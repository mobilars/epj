import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { actorFromContext } from '$srv/audit';
import { readResourceHvisExists } from '$srv/fhir/internal';
import { ageFrom } from '$srv/fhir/display';
import { listCard, createBillingCard, getCard } from '$srv/integrations/helfo/billing';
import { getCopaymentStatus } from '$srv/integrations/helfo/copayment';
import { oreToKroner, TARIFFS, TAKSTREGISTER_VALID_FROM } from '$srv/integrations/helfo/tariffs';

/** Regningskort for én pasient, med frikortstatus og takstvalg. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const parent = await event.parent();
	if (!ctx || !parent.patient) return { card: [], tariffs: [], copayment: null, canRegistrere: false, validFrom: TAKSTREGISTER_VALID_FROM };

	const card = await listCard({ patientId: event.params.id, limit: 50 });
	const copayment = parent.patient.nationalId
		? await getCopaymentStatus(event.params.id, parent.patient.nationalId, actorFromContext(ctx)).catch(() => null)
		: null;

	return {
		canRegistrere: ctx.permissions.has('oppgjor:registrer'),
		validFrom: TAKSTREGISTER_VALID_FROM,
		tariffs: TARIFFS.map((t) => ({
			code: t.code, text: t.text, group: t.group,
			reimbursement: oreToKroner(t.reimbursementOre), copayment: oreToKroner(t.copaymentOre),
			repeterbar: t.repeterbar ?? false
		})),
		copayment: copayment && {
			hasExemptionCard: copayment.hasExemptionCard,
			validTo: copayment.exemptionCardValidTo,
			earned: oreToKroner(copayment.earnedOre),
			remaining: oreToKroner(copayment.remainingOre),
			source: copayment.source
		},
		card: await Promise.all(
			card.map(async (k) => {
				const detalj = await getCard(k.id);
				return {
					id: k.id,
					date: k.date,
					status: k.status,
					kontakttype: k.kontakttype,
					diagnosis: k.diagnosis_code ?? '',
					reimbursement: oreToKroner(k.reimbursement_ore),
					copayment: oreToKroner(k.copayment_ore),
					exemption: k.exemption_reason ?? '',
					rejection: k.rejection ?? '',
					lines: (detalj?.lines ?? []).map((l) => `${l.tariff_code}×${l.count}`)
				};
			})
		)
	};
};

export const actions: Actions = {
	newValue: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('oppgjor:registrer')) return fail(403, { error: 'Rollen din kan ikke registrere regningskort.' });

		const form = await event.request.formData();
		const takstkoder = form.getAll('takst').map(String).filter(Boolean);
		if (takstkoder.length === 0) return fail(400, { error: 'Velg minst én takst.' });

		// Handlinger har ikke tilgang til forelderens data; pasienten hentes på nytt
		// gjennom vokteren, som samtidig kontrollerer at brukeren har tilgang.
		const patient = await readResourceHvisExists(ctx, 'Patient', event.params.id);
		const age = patient?.birthDate ? ageFrom(patient.birthDate as string) : undefined;

		const tariffs = takstkoder.map((code) => ({
			tariff_code: code,
			count: Number(form.get(`antall_${code}`) ?? 1)
		}));

		const response = await createBillingCard(
			{
				patientId: event.params.id,
				encounterId: String(form.get('encounterId') ?? '') || null,
				practitionerId: ctx.actorRef.replace('Practitioner/', ''),
				hprNumber: String(form.get('hpr') ?? '') || null,
				date: String(form.get('dato') ?? new Date().toISOString().slice(0, 10)),
				kontakttype: String(form.get('kontakttype') ?? 'kontor') as 'kontor',
				diagnosisCode: String(form.get('diagnoseKode') ?? '').trim() || null,
				tariffs,
				isSpesialistAllmennmedisin: form.get('spesialist') === 'på',
				patientAge: age
			},
			actorFromContext(ctx)
		);

		if (!response.ok) return fail(400, { error: response.error?.join(' · ') });
		return { ok: true, warnings: response.warnings ?? [] };
	}
};
