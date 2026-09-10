import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { actorFromContext } from '$srv/audit';
import { prescribe, fornye, getMedicationList, discontinue, synkHistory } from '$srv/integrations/sfm';
import { config } from '$srv/config';

/**
 * Medication list and prescribing through Sentral forskrivningsmodul.
 *
 * The record shows the list from SFM (the patient's medication list) as the
 * source, and marks discrepancies the doctor must consider. Prescribing
 * requires the `resept:forskriv` permission.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const parent = await event.parent();
	if (!ctx || !parent.patient) return { list: null, history: [], canForskrive: false, mode: config.integrations.mode };

	const response = await getMedicationList(event.params.id, actorFromContext(ctx));
	return {
		list: response.ok ? response.data : null,
		error: response.ok ? null : response.error,
		history: await synkHistory(event.params.id, 15),
		canForskrive: ctx.permissions.has('resept:forskriv'),
		canFornye: ctx.permissions.has('resept:fornye'),
		mode: config.integrations.mode
	};
};

export const actions: Actions = {
	prescribe: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('resept:forskriv')) return fail(403, { error: 'Rollen din kan ikke forskrive legemidler.' });

		const form = await event.request.formData();
		const name = String(form.get('navn') ?? '').trim();
		const dosage = String(form.get('dosering') ?? '').trim();
		if (!name || !dosage) return fail(400, { error: 'Legemiddel og dosering må fylles ut.' });

		const response = await prescribe(
			{
				patientId: event.params.id,
				forskriverHpr: String(form.get('hpr') ?? ''),
				forskriverName: ctx.name,
				medication: {
					name,
					atc: String(form.get('atc') ?? '').trim() || undefined,
					strength: String(form.get('styrke') ?? '').trim() || undefined,
					form: String(form.get('form') ?? '').trim() || undefined
				},
				dosage,
				quantity: String(form.get('mengde') ?? '1'),
				indication: String(form.get('indikasjon') ?? '').trim() || undefined,
				reimbursementCode: String(form.get('refusjonKode') ?? '').trim() || undefined,
				reimbursementLegalBasis: String(form.get('refusjonHjemmel') ?? '').trim() || undefined,
				reiterasjon: Number(form.get('reiterasjon') ?? 0)
			},
			actorFromContext(ctx)
		);

		if (!response.ok) return fail(502, { error: response.error ?? 'Forskrivningen ble ikke gjennomført.' });
		const alerts = (response.data as unknown as { alerts?: string[] })?.alerts ?? [];
		return { ok: true, prescriptionId: response.prescriptionId, alerts };
	},

	discontinue: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('resept:forskriv')) return fail(403, { error: 'Rollen din kan ikke seponere legemidler.' });
		const form = await event.request.formData();
		const response = await discontinue(
			event.params.id,
			String(form.get('reseptId') ?? ''),
			String(form.get('arsak') ?? '').trim() || 'Ikke oppgitt',
			actorFromContext(ctx)
		);
		if (!response.ok) return fail(502, { error: response.error });
		redirect(303, `/pasienter/${event.params.id}/legemidler`);
	},

	fornye: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('resept:fornye')) return fail(403, { error: 'Rollen din kan ikke fornye resepter.' });
		const form = await event.request.formData();
		const response = await fornye(event.params.id, String(form.get('reseptId') ?? ''), actorFromContext(ctx));
		if (!response.ok) return fail(502, { error: response.error });
		redirect(303, `/pasienter/${event.params.id}/legemidler`);
	}
};
