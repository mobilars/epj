import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { ressurser, sokRessurser } from '$srv/fhir/internt';
import { tilPasientVisning } from '$srv/fhir/visning';
import { SYSTEM, gyldigNorskPersonnummer } from '$srv/fhir/kodeverk';
import { logg, aktorFraKontekst } from '$srv/audit';
import { query } from '$srv/db';

/**
 * Pasientsøk.
 *
 * Søket går gjennom den samme voktereren som API-et og er dermed automatisk
 * avgrenset til pasienter brukeren har tjenstlig behov for. Selve søket
 * loggføres, med søkestrengen maskert.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);

	const sok = (event.url.searchParams.get('sok') ?? '').trim();

	const mine = await query<{ patient_id: string }>(
		`SELECT DISTINCT patient_id FROM care_relationship
		 WHERE user_id = $1 AND gyldig_fra <= now() AND (gyldig_til IS NULL OR gyldig_til > now()) LIMIT 500`,
		[ctx.userId]
	);

	if (!sok) {
		const pasienter = mine.length
			? ressurser(await sokRessurser(ctx, 'Patient', { _id: mine.map((m) => m.patient_id).join(','), _count: 100, _sort: 'family' }))
			: [];
		return { sok: '', treff: pasienter.map(tilPasientVisning), antallMine: mine.length, sokteEtterFnr: false };
	}

	const erFnr = /^\d{11}$/.test(sok);
	if (erFnr && !gyldigNorskPersonnummer(sok)) {
		return { sok, treff: [], antallMine: mine.length, sokteEtterFnr: true, feil: 'Ugyldig fødselsnummer (kontrollsiffer stemmer ikke).' };
	}

	const bundle = erFnr
		? await sokRessurser(ctx, 'Patient', { identifier: `${SYSTEM.FNR}|${sok}`, _count: 20 })
		: await sokRessurser(ctx, 'Patient', { name: sok, _count: 40, _sort: 'family' });

	await logg(
		{
			type: 'rest', subtype: 'pasientsøk', handling: 'E', utfall: '0',
			detaljer: { type: erFnr ? 'fødselsnummer' : 'navn', treff: (bundle.entry ?? []).length }
		},
		aktorFraKontekst(ctx)
	);

	return {
		sok,
		treff: ressurser(bundle).map(tilPasientVisning),
		antallMine: mine.length,
		sokteEtterFnr: erFnr
	};
};
