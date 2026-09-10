import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { actorFromContext } from '$srv/audit';
import { queueOut, listMessages, sendQueue } from '$srv/integrations/nhn/message-queue';
import { buildDialogueMessage, buildReferral } from '$srv/integrations/nhn/messages';
import { getRecipient, searchRecipients, toPart } from '$srv/integrations/nhn/address-registry';
import { readResourceHvisExists } from '$srv/fhir/internal';
import { toPatientDisplay } from '$srv/fhir/display';
import { newId } from '$srv/util/ids';
import { SYSTEM } from '$srv/fhir/codesystems';

/** Meldinger knyttet til én pasient, og skjema for å sende dialogmelding eller henvisning. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const parent = await event.parent();
	if (!ctx || !parent.patient) return { messages: [], recipients: [], canSende: false };

	return {
		canSende: ctx.permissions.has('melding:send'),
		recipients: (await searchRecipients('')).map((m) => ({ herId: m.herId, name: m.name, types: m.supportsMessages })),
		messages: (await listMessages({ patientId: event.params.id, limit: 50 })).map((m) => ({
			id: m.id,
			direction: m.direction,
			type: m.message_type,
			part: m.recipient_name ?? m.sender_her_id ?? '',
			status: m.status,
			apprec: m.apprec_status,
			detalj: m.status_detail,
			created_at: new Date(m.created_at).toLocaleString('nb-NO')
		}))
	};
};

async function patientPart(ctx: NonNullable<App.Locals['auth']>, patientId: string) {
	const patient = await readResourceHvisExists(ctx, 'Patient', patientId);
	if (!patient) return null;
	const v = toPatientDisplay(patient);
	const [givenName, ...resten] = v.name.split(' ');
	return {
		fnr: v.nationalId ?? '',
		givenName,
		familyName: resten.join(' '),
		birthDate: v.birthDate ?? undefined,
		gender: v.gender === 'Kvinne' ? ('K' as const) : ('M' as const)
	};
}

export const actions: Actions = {
	dialog: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('melding:send')) return fail(403, { error: 'Rollen din kan ikke sende meldinger.' });

		const form = await event.request.formData();
		const recipientHer = String(form.get('mottaker') ?? '');
		const content = String(form.get('innhold') ?? '').trim();
		if (!recipientHer || !content) return fail(400, { error: 'Velg mottaker og skriv innhold.' });

		const recipient = await getRecipient(recipientHer);
		const patient = await patientPart(ctx, event.params.id);
		if (!recipient || !patient) return fail(400, { error: 'Fant ikke mottaker eller pasient.' });

		const msgId = newId();
		const xml = buildDialogueMessage({
			msgId,
			type: (String(form.get('type') ?? 'notat') as 'notat' | 'foresporsel'),
			content,
			recipient: toPart(recipient),
			patient,
			practitioner: { name: ctx.name, hpr: String(form.get('hpr') ?? '') }
		});

		const result = await queueOut(
			{
				message_type: String(form.get('type') ?? 'notat') === 'foresporsel' ? 'DIALOG_FORESPORSEL' : 'DIALOG_NOTAT',
				msgId, patientId: event.params.id, recipientHer, payloadXml: xml, createdOf: ctx.userId as string
			},
			actorFromContext(ctx)
		);
		if (!result.ok) return fail(400, { error: result.error });
		await sendQueue();
		redirect(303, `/pasienter/${event.params.id}/meldinger`);
	},

	referral: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('melding:send')) return fail(403, { error: 'Rollen din kan ikke sende meldinger.' });

		const form = await event.request.formData();
		const recipientHer = String(form.get('mottaker') ?? '');
		const problem = String(form.get('problemstilling') ?? '').trim();
		if (!recipientHer || !problem) return fail(400, { error: 'Velg mottaker og beskriv problemstillingen.' });

		const recipient = await getRecipient(recipientHer);
		const patient = await patientPart(ctx, event.params.id);
		if (!recipient || !patient) return fail(400, { error: 'Fant ikke mottaker eller pasient.' });

		const msgId = newId();
		const diagnosisCode = String(form.get('diagnoseKode') ?? '').trim();
		const xml = buildReferral({
			msgId,
			recipient: toPart(recipient),
			patient,
			practitioner: { name: ctx.name, hpr: String(form.get('hpr') ?? '') },
			diagnosis: diagnosisCode ? { code: diagnosisCode, text: String(form.get('diagnoseTekst') ?? ''), system: SYSTEM.ICPC2 } : undefined,
			problem,
			anamnese: String(form.get('anamnese') ?? '').trim() || undefined,
			requestedExamination: String(form.get('onsket') ?? '').trim() || undefined,
			hastegrad: (String(form.get('hastegrad') ?? 'ordinaer') as 'ordinaer' | 'haster' | 'akutt'),
			pasientenInformed: form.get('informert') === 'på'
		});

		const result = await queueOut(
			{ message_type: 'HENVIS', msgId, patientId: event.params.id, recipientHer, payloadXml: xml, createdOf: ctx.userId as string },
			actorFromContext(ctx)
		);
		if (!result.ok) return fail(400, { error: result.error });
		await sendQueue();
		redirect(303, `/pasienter/${event.params.id}/meldinger`);
	}
};
