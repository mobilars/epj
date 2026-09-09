import type { PageServerLoad } from './$types';
import { en } from '$srv/db';
import { verifiserLoggkjede, ugjennomgattNodrett } from '$srv/audit';
import { fhirKlient } from '$srv/fhir/client';
import { gjeldendeVersjon } from '$srv/db/migrate';
import { config } from '$srv/config';
import { ventendeKvitteringer } from '$srv/integrasjoner/nhn/meldingsko';

/** Driftsoversikt: tilstand på avhengigheter, loggintegritet og saker til oppfølging. */
export const load: PageServerLoad = async () => {
	const [antallBrukere, antallApper, kjede, nodrett, fhirOppe, kvitteringer] = await Promise.all([
		en<{ n: number }>("SELECT count(*)::int AS n FROM user_account WHERE status = 'aktiv'"),
		en<{ n: number }>("SELECT count(*)::int AS n FROM oauth_client WHERE status = 'aktiv'"),
		verifiserLoggkjede().catch(() => ({ gyldig: false, kontrollerte: 0 })),
		ugjennomgattNodrett().catch(() => []),
		fhirKlient.erTilgjengelig(),
		ventendeKvitteringer(60).catch(() => [])
	]);

	return {
		antallBrukere: antallBrukere?.n ?? 0,
		antallApper: antallApper?.n ?? 0,
		loggkjede: kjede,
		nodrett: nodrett.map((n) => ({
			seq: n.seq,
			tidspunkt: new Date(n.recorded).toLocaleString('nb-NO'),
			hvem: n.actor_navn ?? '',
			patientId: n.patient_id ?? ''
		})),
		fhirOppe,
		ventendeKvitteringer: kvitteringer.length,
		skjemaversjon: await gjeldendeVersjon().catch(() => 0),
		miljo: {
			integrasjoner: config.integrasjoner.modus,
			helseId: config.integrasjoner.helseId.enabled,
			testinnlogging: config.testinnlogging.aktivert,
			mfa: config.security.requireMfa
		}
	};
};
