import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$srv/config';
import { logIn } from '$srv/auth/users';
import { createSession } from '$srv/auth/session';
import { isKonfigurert as healthIdKonfigurert } from '$srv/auth/helseid';
import { log } from '$srv/audit';
import { rateLimit } from '$srv/http';

/**
 * Pålogging.
 *
 * HelseID er hovedveien inn. Den lokale påloggingen med brukernavn, passord og
 * engangskode er en testmekanisme, og styres av `EPJ_TESTINNLOGGING`. I
 * produksjon med HelseID skal den være avslått.
 */

function trygtReturnTo(returnTo: string | null): string {
	// Kun interne stier, aldri absolutte URL-er: hindrer åpen omdirigering.
	if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//')) return '/';
	return returnTo;
}

export const load: PageServerLoad = async (event) => {
	if (event.locals.auth?.mate === 'session') {
		redirect(303, trygtReturnTo(event.url.searchParams.get('retur')));
	}
	return {
		healthId: healthIdKonfigurert(),
		testLogin: config.testLogin.aktivert,
		demoUsers: config.testLogin.showDemoUsers
			? [
					{ username: 'lege', name: 'Dr. Ingrid Fastlege', role: 'Lege' },
					{ username: 'sykepleier', name: 'Kari Sykepleier', role: 'Sykepleier' },
					{ username: 'sekretaer', name: 'Ola Helsesekretær', role: 'Helsesekretær' },
					{ username: 'admin', name: 'Systemansvarlig', role: 'Systemansvarlig' }
				]
			: [],
		returnTo: trygtReturnTo(event.url.searchParams.get('retur')),
		organisation: config.organisation.name
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

		// Egen teller per brukernavn, i tillegg til IP-grensen i hooks.
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
				// Samme melding uansett årsak - vi avslører ikke om brukeren finnes.
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
