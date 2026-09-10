import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$srv/config';
import { requestEmailCode, signInAs, verifyEmailCode, type AccountMatch } from '$srv/auth/email-login';
import { rateLimit } from '$srv/http';
import { log } from '$srv/audit';
import { requireTenant } from '$srv/tenant/context';

/**
 * Signing in with a code sent by email.
 *
 * Weaker than HelseID by design, and offered only where it is turned on. A
 * person may hold an account at more than one practice, so the code unlocks
 * the address first and the organisation is chosen afterwards - a question
 * that only makes sense once the code is known to be right.
 */
function guard(): void {
	if (!config.testLogin.epost) redirect(303, '/logg-inn');
}

export const load: PageServerLoad = async (event) => {
	guard();
	if (event.locals.auth?.mate === 'session') redirect(303, '/');
	return {
		sent: event.url.searchParams.get('sendt') === 'ja',
		email: event.url.searchParams.get('e') ?? '',
		organisation: requireTenant().name
	};
};

/** One shape for every failure, so the page can read the same fields back. */
interface Svar {
	error?: string;
	email?: string;
	code?: string;
	sent?: boolean;
	accounts?: { tenantId: string; tenantName: string }[];
}

export const actions: Actions = {
	send: async (event) => {
		guard();
		const form = await event.request.formData();
		const email = String(form.get('epost') ?? '').trim();
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
			return fail(400, { error: 'Skriv inn en gyldig e-postadresse.', email } as Svar);
		}

		const limit = await rateLimit(`epost:${email.toLowerCase()}`, 5, 900);
		if (!limit.allowed) return fail(429, { error: 'For mange forespørsler. Vent litt.', email } as Svar);

		try {
			// The organisation is recorded but not enforced: what matters is the
			// address, and which organisations it belongs to is settled below.
			await requestEmailCode(email, requireTenant().id, event.locals.clientIp);
		} catch (err) {
			return fail(500, { error: `Klarte ikke å sende koden: ${(err as Error).message}`, email });
		}
		redirect(303, `/logg-inn/epost?sendt=ja&e=${encodeURIComponent(email)}`);
	},

	bekreft: async (event) => {
		guard();
		const form = await event.request.formData();
		const email = String(form.get('epost') ?? '').trim();
		const code = String(form.get('kode') ?? '').trim();

		const limit = await rateLimit(`epost-kode:${event.locals.clientIp}`, 20, 900);
		if (!limit.allowed) return fail(429, { error: 'For mange forsøk. Vent litt.', email, sent: true } as Svar);

		const result = await verifyEmailCode(email, code);
		if (!result.ok) return fail(400, { error: result.error, email, sent: true } as Svar);

		// One account: straight in. Several: the person picks, and the choice is
		// made from accounts the code has already unlocked, so naming one that is
		// not on the list gets nowhere.
		const chosen = String(form.get('virksomhet') ?? '');
		const account: AccountMatch | undefined =
			result.accounts.length === 1 ? result.accounts[0] : result.accounts.find((a) => a.tenantId === chosen);

		if (!account) {
			return fail(400, {
				sent: true,
				email,
				code,
				accounts: result.accounts.map((a) => ({ tenantId: a.tenantId, tenantName: a.tenantName })),
				error: 'Velg hvilken virksomhet du vil logge inn i.'
			} as Svar);
		}

		const { tenant, roles } = await signInAs(
			account,
			event.cookies,
			event.locals.clientIp,
			event.request.headers.get('user-agent')
		);
		await log(
			{ type: 'login', subtype: 'epost', action: 'E', outcome: '0', details: { roles: roles.join(',') } },
			{
				userId: account.userId,
				actorRef: `Person/${account.userId}`,
				name: account.name,
				role: roles[0] ?? null,
				clientId: null,
				ip: event.locals.clientIp,
				requestId: event.locals.requestId
			}
		);
		// Back to whichever address serves that organisation.
		redirect(303, tenant.base_url ? `${tenant.base_url.replace(/\/$/, '')}/` : '/');
	}
};
