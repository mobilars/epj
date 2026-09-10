import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$srv/config';
import { createTrial, trialsAreOpen } from '$srv/tenant/trial';
import { requestEmailCode } from '$srv/auth/email-login';
import { rateLimit } from '$srv/http';
import { log } from '$srv/audit';

/**
 * Setting up a trial.
 *
 * Fill in three fields and you get a record of your own, with yourself as its
 * administrator. It is the real thing - a real organisation with a real FHIR
 * partition - because a trial that is not teaches nothing about the system.
 *
 * What follows immediately is a sign-in code to the address given, which is
 * also what proves the address was real. Nothing is confirmed beforehand: an
 * organisation nobody can sign in to costs nothing and disappears from view.
 */
export const load: PageServerLoad = async () => {
	if (!(await trialsAreOpen())) redirect(303, '/logg-inn');
	return { open: true };
};

export const actions: Actions = {
	default: async (event) => {
		if (!(await trialsAreOpen())) redirect(303, '/logg-inn');

		const form = await event.request.formData();
		const text = (name: string) => String(form.get(name) ?? '').trim();
		const values = {
			navn: text('navn'),
			epost: text('epost'),
			virksomhet: text('virksomhet')
		};
		const fields = { values };

		if (!values.navn) return fail(400, { error: 'Skriv inn navnet ditt.', ...fields });
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.epost)) {
			return fail(400, { error: 'Skriv inn en gyldig e-postadresse.', ...fields });
		}
		if (!values.virksomhet) return fail(400, { error: 'Gi kontoret et navn.', ...fields });

		// Creating an organisation is expensive - a partition in FHIR, a schema of
		// rows - so the limit is per address and per caller, not per session.
		const limit = await rateLimit(`prove:${event.locals.clientIp}`, 3, 3600);
		if (!limit.allowed) {
			return fail(429, { error: 'For mange prøvekontoer herfra. Prøv igjen senere.', ...fields });
		}

		const actor = {
			userId: null,
			actorRef: 'Person/ukjent',
			name: values.epost,
			role: null,
			clientId: null,
			ip: event.locals.clientIp,
			requestId: event.locals.requestId
		};

		const result = await createTrial(
			{
				contactName: values.navn,
				contactEmail: values.epost,
				practiceName: values.virksomhet,
				ip: event.locals.clientIp
			},
			actor
		);
		if ('error' in result) return fail(400, { error: result.error, ...fields });

		await log(
			{
				type: 'admin',
				subtype: 'provekonto:opprettet',
				action: 'C',
				outcome: '0',
				details: { tenant: result.tenantId, epost: values.epost }
			},
			actor
		);

		// The code is what makes the address real, so it goes out at once.
		try {
			await requestEmailCode(values.epost, result.tenantId, event.locals.clientIp);
		} catch {
			// The organisation exists either way; they can ask for a code again.
		}
		redirect(303, `/logg-inn/epost?sendt=ja&e=${encodeURIComponent(values.epost)}`);
	}
};
