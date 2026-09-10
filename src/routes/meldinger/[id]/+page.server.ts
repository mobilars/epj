import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getMessage } from '$srv/integrations/nhn/message-queue';
import { readMsgHead } from '$srv/integrations/nhn/apprec';
import { log, actorFromContext } from '$srv/audit';

/** Detaljvisning av én melding, med lesbar sammenstilling av hodemeldingen. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (!ctx.permissions.has('melding:les')) error(403, 'Rollen din har ikke tilgang til meldinger.');

	const message = await getMessage(event.params.id);
	if (!message) error(404, 'Meldingen finnes ikke.');

	await log(
		{ type: 'integrasjon', subtype: 'melding:lest', action: 'R', outcome: '0', patientId: message.patient_id, entityRef: `urn:melding:${message.msg_id}` },
		actorFromContext(ctx)
	);

	const read = message.payload_xml ? readMsgHead(message.payload_xml) : null;

	return {
		message: {
			id: message.id,
			type: message.message_type,
			direction: message.direction,
			msgId: message.msg_id,
			status: message.status,
			detalj: message.status_detail,
			apprec: message.apprec_status,
			patientId: message.patient_id,
			fhirRef: message.fhir_ref,
			created_at: new Date(message.created_at).toLocaleString('nb-NO'),
			sender: read?.sender.name ?? message.sender_her_id ?? '',
			patientName: read?.patientName ?? '',
			xml: message.payload_xml ?? ''
		}
	};
};
