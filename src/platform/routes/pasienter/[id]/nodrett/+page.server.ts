import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { exec } from '$srv/db';
import { requireTenant } from '$srv/tenant/context';
import { newId } from '$srv/util/ids';
import { log, actorFromContext } from '$srv/audit';
import { confirmTotp } from '$srv/auth/users';
import { config } from '$srv/config';
import { canEmergencyAccess } from '$srv/authz/roles';

/**
 * Emergency access ("break the glass").
 *
 * A route of its own, because the actions must be reachable from every tab in
 * the record. The page has no view - it sends the user back to the record.
 */
export const load: PageServerLoad = async (event) => {
	redirect(303, `/pasienter/${event.params.id}`);
};

export const actions: Actions = {
	/**
	 * Emergency access. Requires a justification and confirmation of identity,
	 * and grants time-limited access. Both the request and the access itself are
	 * logged, and the lookup is queued for review.
	 */
	emergencyAccess: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		if (!canEmergencyAccess(ctx.roles)) return fail(403, { error: 'Rollen din kan ikke bruke nødrettstilgang.' });


		const form = await event.request.formData();
		const justification = String(form.get('begrunnelse') ?? '').trim();
		const oneTimeCode = String(form.get('engangskode') ?? '').trim();
		const patientId = event.params.id;

		const back = (error: string) =>
			redirect(303, `/pasienter/${patientId}?nodrettFeil=${encodeURIComponent(error)}`);

		if (justification.length < 15) back('Skriv en konkret begrunnelse på minst 15 tegn.');

		// Re-authentication before emergency access, when the account has two-factor.
		if (config.security.requireMfa && ctx.amr !== 'helseid') {
			if (!oneTimeCode || !(await confirmTotp(ctx.userId, oneTimeCode))) {
				back('Feil eller manglende engangskode.');
			}
		}

		const durationAppointments = 4;
		await exec(
			`INSERT INTO break_glass (id, tenant_id, user_id, patient_id, justification, expires_at)
			 VALUES ($1,$6,$2,$3,$4, now() + ($5 || ' hours')::interval)`,
			[newId(), ctx.userId, patientId, justification, String(durationAppointments), requireTenant().id]
		);
		await log(
			{
				type: 'emergency-override', subtype: 'break-glass', action: 'E', outcome: '0',
				patientId, purposeOfUse: 'ETREAT', outcomeDescription: justification,
				details: { durationAppointments }
			},
			actorFromContext(ctx)
		);
		redirect(303, `/pasienter/${patientId}`);
	},

	endEmergencyAccess: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		await exec(
			'UPDATE break_glass SET expires_at = now() WHERE user_id = $1 AND patient_id = $2 AND tenant_id = $3 AND expires_at > now()',
			[ctx.userId, event.params.id, requireTenant().id]
		);
		await log(
			{ type: 'emergency-override', subtype: 'break-glass-avsluttet', action: 'E', outcome: '0', patientId: event.params.id },
			actorFromContext(ctx)
		);
		redirect(303, `/pasienter/${event.params.id}`);
	}
};
