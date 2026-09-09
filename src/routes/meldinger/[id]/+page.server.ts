import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { hentMelding } from '$srv/integrasjoner/nhn/meldingsko';
import { lesHodemelding } from '$srv/integrasjoner/nhn/apprec';
import { logg, aktorFraKontekst } from '$srv/audit';

/** Detaljvisning av én melding, med lesbar sammenstilling av hodemeldingen. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (!ctx.rettigheter.has('melding:les')) error(403, 'Rollen din har ikke tilgang til meldinger.');

	const melding = await hentMelding(event.params.id);
	if (!melding) error(404, 'Meldingen finnes ikke.');

	await logg(
		{ type: 'integrasjon', subtype: 'melding:lest', handling: 'R', utfall: '0', patientId: melding.patient_id, entityRef: `urn:melding:${melding.msg_id}` },
		aktorFraKontekst(ctx)
	);

	const lest = melding.payload_xml ? lesHodemelding(melding.payload_xml) : null;

	return {
		melding: {
			id: melding.id,
			type: melding.meldingstype,
			retning: melding.retning,
			msgId: melding.msg_id,
			status: melding.status,
			detalj: melding.status_detalj,
			apprec: melding.apprec_status,
			patientId: melding.patient_id,
			fhirRef: melding.fhir_ref,
			opprettet: new Date(melding.opprettet).toLocaleString('nb-NO'),
			avsender: lest?.avsender.navn ?? melding.avsender_her ?? '',
			pasientNavn: lest?.pasientNavn ?? '',
			xml: melding.payload_xml ?? ''
		}
	};
};
