import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { utfor } from '$srv/fhir/gateway';
import { FhirError } from '$srv/fhir/outcome';
import { tilPasientVisning } from '$srv/fhir/visning';
import { aktivNodrett, harBehandlingsrelasjon } from '$srv/authz/tilgang';
import { query } from '$srv/db';
import { krevTenant } from '$srv/tenant/kontekst';
import { config } from '$srv/config';
import { kanNodrett } from '$srv/authz/roles';
import { fhirKlient } from '$srv/fhir/client';

/**
 * Rammen rundt én pasientjournal.
 *
 * Når brukeren mangler tjenstlig behov, vises ikke en vanlig feilside: brukeren
 * får se at pasienten finnes, og kan be om nødrettstilgang med begrunnelse.
 * Det er dette som gjør sperringen håndterbar i akutte situasjoner uten at
 * hovedregelen svekkes - forsøket logges uansett utfall.
 */
export const load: LayoutServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (!ctx.rettigheter.has('journal:les')) {
		error(403, 'Rollen din har ikke tilgang til pasientopplysninger.');
	}
	const patientId = event.params.id;

	let pasient = null;
	let nektet: string | null = null;
	try {
		const svar = await utfor({ ctx, metode: 'GET', sti: `Patient/${patientId}`, sok: new URLSearchParams() });
		pasient = tilPasientVisning(svar.ressurs);
	} catch (err) {
		if (err instanceof FhirError && (err.status === 403 || err.status === 404)) {
			nektet = err.issues[0]?.diagnostics ?? 'Ingen tilgang';
		} else {
			throw err;
		}
	}

	const [nodrett, relasjon, sperringer] = await Promise.all([
		aktivNodrett(ctx.userId, patientId),
		harBehandlingsrelasjon(ctx.userId, patientId),
		query<{ omfang: string; begrunnelse: string | null; registrert: string }>(
			'SELECT omfang, begrunnelse, registrert FROM journal_sperring WHERE patient_id = $1 AND tenant_id = $2 AND opphevet = false',
			[patientId, krevTenant().id]
		)
	]);

	// Navnet vises i nødrettsdialogen selv uten tilgang til journalinnholdet,
	// slik at brukeren kan kontrollere at hen ber om tilgang til riktig person.
	let minimaltNavn: string | null = null;
	if (!pasient && nektet) {
		const rå = await fhirKlient.les('Patient', patientId).catch(() => null);
		if (rå) minimaltNavn = tilPasientVisning(rå).navn;
	}

	return {
		patientId,
		pasient,
		nektet,
		minimaltNavn,
		nodrett,
		relasjon,
		sperret: sperringer.length > 0,
		sperringer: sperringer.map((s) => ({ omfang: s.omfang, begrunnelse: s.begrunnelse, registrert: s.registrert })),
		kanBeOmNodrett: kanNodrett(ctx.roller),
		krevErEngangskode: config.security.requireMfa && ctx.amr !== 'helseid'
	};
};
