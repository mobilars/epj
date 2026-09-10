import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$srv/config';
import { logIn } from '$srv/auth/users';
import { createSession } from '$srv/auth/session';
import { isConfigured as healthIdConfigured } from '$srv/auth/helseid';
import { log } from '$srv/audit';
import { rateLimit } from '$srv/http';
import { startMfaSetup } from '$srv/auth/mfa-setup';
import { requireTenant } from '$srv/tenant/context';
import { DEMO_PASSWORD, DEMO_TOTP_SECRET, demoUsersHere } from '$srv/auth/demo';

/**
 * Sign-in.
 *
 * HelseID is the main way in. Local sign-in with username, password and
 * one-time code is a test mechanism, governed by `EPJ_TEST_LOGIN`. In
 * production with HelseID it must be turned off.
 */

function trygtReturnTo(returnTo: string | null): string {
	// Internal paths only, never absolute URLs: prevents open redirection.
	if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//')) return '/';
	return returnTo;
}

export const load: PageServerLoad = async (event) => {
	if (event.locals.auth?.mate === 'session') {
		redirect(303, trygtReturnTo(event.url.searchParams.get('retur')));
	}
	return {
		healthId: healthIdConfigured(),
		testLogin: config.testLogin.aktivert,
		demoUsers: config.testLogin.showDemoUsers ? await demoUsersHere() : [],
		demoPassword: config.testLogin.showDemoUsers ? DEMO_PASSWORD : '',
		demoTotpSecret: config.testLogin.showDemoUsers ? DEMO_TOTP_SECRET : '',
		returnTo: trygtReturnTo(event.url.searchParams.get('retur')),
		// The organisation the hostname resolves to - not the one in the
		// configuration, which is only the fallback used to seed the first one.
		organisation: requireTenant().name,
		// The other ways in, so the front page can point at them rather than
		// leaving people to guess at hostnames.
		emailLogin: config.testLogin.epost,
		trialUrl: config.tenant.trialsEnabled && config.tenant.trialHostname
			? `https://${config.tenant.trialHostname}/prov`
			: null,
		platformUrl: config.tenant.platformHostname ? `https://${config.tenant.platformHostname}/systemadmin` : null,
		developerUrl: config.tenant.developerHostname ? `https://${config.tenant.developerHostname}/utvikler` : null
	};
};

interface Skjemasvar {
	error?: string;
	username?: string;
	requireIsMfa?: boolean;
}

export const actions: Actions = {
	default: async (event) => {
		const response = (status: number, data: Skjemasvar) => fail(status, data);

		if (!config.testLogin.aktivert) {
			return response(403, { error: 'Lokal pålogging er slått av. Bruk HelseID.' });
		}

		const form = await event.request.formData();
		const username = String(form.get('brukernavn') ?? '').trim();
		const password = String(form.get('passord') ?? '');
		const oneTimeCode = String(form.get('engangskode') ?? '').trim();
		const returnTo = trygtReturnTo(String(form.get('retur') ?? '/'));

		const actor = {
			userId: null,
			actorRef: 'Person/ukjent',
			name: username || 'ukjent',
			role: null,
			clientId: null,
			ip: event.locals.clientIp,
			requestId: event.locals.requestId
		};

		// A separate counter per username, on top of the IP limit in hooks.
		const limit = await rateLimit(
			`login:${username.toLowerCase()}`,
			config.security.rateLimit.loginPerUser,
			config.security.rateLimit.loginWindowSekunder
		);
		if (!limit.allowed) {
			await log({ type: 'login', subtype: 'ratelimit', action: 'E', outcome: '4', outcomeDescription: 'For mange forsøk' }, actor);
			return response(429, { error: 'For mange påloggingsforsøk. Vent noen minutter.' });
		}

		if (!username || !password) {
			return response(400, { error: 'Fyll inn brukernavn og passord.', username });
		}

		const result = await logIn(username, password, oneTimeCode || undefined);

		switch (result.outcome) {
			case 'krever-mfa-oppsett':
				// The password was right, but there is no authenticator yet. Asking
				// for a code here would be a dead end, so take them through setup.
				startMfaSetup(event.cookies, result.user.id, returnTo);
				redirect(303, '/logg-inn/totp');
			case 'krever-mfa':
				return response(401, { requireIsMfa: true, username, error: 'Skriv inn engangskoden fra autentiseringsappen.' });
			case 'laast':
				await log({ type: 'login', subtype: 'passord', action: 'E', outcome: '4', outcomeDescription: 'Kontoen er låst' }, actor);
				return response(423, { error: 'Kontoen er midlertidig låst etter flere mislykkede forsøk.' });
			case 'sperret':
				await log({ type: 'login', subtype: 'passord', action: 'E', outcome: '4', outcomeDescription: 'Kontoen er sperret' }, actor);
				return response(403, { error: 'Kontoen er sperret. Kontakt systemansvarlig.' });
			case 'feil-passord':
			case 'ukjent-bruker':
				await log({ type: 'login', subtype: 'passord', action: 'E', outcome: '4', outcomeDescription: 'Feil brukernavn eller passord' }, actor);
				// The same message whatever the cause - we do not reveal whether the user exists.
				return response(401, { error: 'Feil brukernavn, passord eller engangskode.', username });
			case 'ok': {
				await createSession(
					result.user.id,
					result.amr,
					event.locals.clientIp,
					event.request.headers.get('user-agent'),
					event.cookies
				);
				await log(
					{ type: 'login', subtype: 'passord', action: 'E', outcome: '0', details: { amr: result.amr, roles: result.roles.join(',') } },
					{ ...actor, userId: result.user.id, actorRef: result.user.practitioner_id ? `Practitioner/${result.user.practitioner_id}` : `Person/${result.user.id}`, name: result.user.name, role: result.roles[0] ?? null }
				);
				redirect(303, returnTo);
			}
		}
	}
};
