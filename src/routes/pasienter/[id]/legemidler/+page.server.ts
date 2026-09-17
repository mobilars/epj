import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { callHook } from '$srv/cds/hooks';
import { SYSTEM } from '$srv/fhir/codesystems';
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

		// Everything the form said, so the page can put it back if the
		// clinician has to look at a warning first.
		const draft = Object.fromEntries(
			['navn', 'atc', 'styrke', 'form', 'dosering', 'indikasjon', 'mengde', 'reiterasjon', 'refusjonKode', 'refusjonHjemmel', 'hpr'].map((k) => [k, String(form.get(k) ?? '')])
		);

		/**
		 * `medication-prescribe` fires while the prescription is still a draft.
		 *
		 * This is the moment advice is worth something - an interaction found
		 * after the prescription has gone to e-resept is a phone call, not a
		 * card. So the hook is asked first, and if anything comes back the
		 * prescription waits: the page shows the cards and the same form, filled
		 * in, with one more button. Pressing it says the clinician has read them.
		 * That is the whole of what a card can do - it cannot refuse, only ask
		 * for a second look.
		 */
		const confirmed = form.get('bekreftet') === 'ja';
		const draftOrder = {
			resourceType: 'MedicationRequest',
			status: 'draft',
			intent: 'order',
			subject: { reference: `Patient/${event.params.id}` },
			medication: {
				concept: {
					...(draft.atc ? { coding: [{ system: SYSTEM.ATC, code: draft.atc, display: name }] } : {}),
					text: [name, draft.styrke, draft.form].filter(Boolean).join(' ')
				}
			},
			dosageInstruction: [{ text: dosage }],
			...(draft.indikasjon ? { reason: [{ concept: { text: draft.indikasjon } }] } : {})
		};
		if (!confirmed) {
			const advice = await callHook('medication-prescribe', ctx, {
				patientId: event.params.id,
				patient: event.params.id,
				medications: { resourceType: 'Bundle', type: 'collection', entry: [{ resource: draftOrder }] },
				draftOrders: { resourceType: 'Bundle', type: 'collection', entry: [{ resource: draftOrder }] }
			}).catch(() => ({ cards: [], failed: [] as string[] }));
			if (advice.cards.length) {
				return { advice, draft, needsConfirmation: true };
			}
		}

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

		// `order-sign` fires once the prescription is signed: the order is real
		// now, and a service that keeps a medication list, or a register that
		// wants to know, gets told. Cards here are read after the fact.
		const signed = await callHook('order-sign', ctx, {
			patientId: event.params.id,
			patient: event.params.id,
			draftOrders: { resourceType: 'Bundle', type: 'collection', entry: [{ resource: { ...draftOrder, status: 'active', identifier: [{ value: response.prescriptionId }] } }] }
		}).catch(() => ({ cards: [], failed: [] as string[] }));

		return { ok: true, prescriptionId: response.prescriptionId, alerts, signedCards: signed.cards };
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
