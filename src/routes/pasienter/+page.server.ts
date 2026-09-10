import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { resources, searchResources } from '$srv/fhir/internal';
import { toPatientDisplay } from '$srv/fhir/display';
import { SYSTEM, validNorwegianNationalId } from '$srv/fhir/codesystems';
import { log, actorFromContext } from '$srv/audit';
import { query } from '$srv/db';
import { requireTenant } from '$srv/tenant/context';

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
	// Roller uten klinisk lesetilgang, som systemansvarlig, skal ikke kunne åpne
	// pasientlisten i det hele tatt - heller ikke for å se at den er tom.
	if (!ctx.permissions.has('journal:les')) {
		error(403, 'Rollen din har ikke tilgang til pasientopplysninger.');
	}

	const search = (event.url.searchParams.get('sok') ?? '').trim();

	const mine = await query<{ patient_id: string }>(
		`SELECT DISTINCT patient_id FROM care_relationship
		 WHERE tenant_id = $2 AND user_id = $1
		   AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now()) LIMIT 500`,
		[ctx.userId, requireTenant().id]
	);

	if (!search) {
		const patients = mine.length
			? resources(await searchResources(ctx, 'Patient', { _id: mine.map((m) => m.patient_id).join(','), _count: 100, _sort: 'family' }))
			: [];
		return { search: '', match: patients.map(toPatientDisplay), countMine: mine.length, sokteAfterFnr: false };
	}

	const isFnr = /^\d{11}$/.test(search);
	if (isFnr && !validNorwegianNationalId(search)) {
		return { search, match: [], countMine: mine.length, sokteAfterFnr: true, error: 'Ugyldig fødselsnummer (kontrollsiffer stemmer ikke).' };
	}

	const bundle = isFnr
		? await searchResources(ctx, 'Patient', { identifier: `${SYSTEM.FNR}|${search}`, _count: 20 })
		: await searchResources(ctx, 'Patient', { name: search, _count: 40, _sort: 'family' });

	await log(
		{
			type: 'rest', subtype: 'pasientsøk', action: 'E', outcome: '0',
			details: { type: isFnr ? 'fødselsnummer' : 'navn', match: (bundle.entry ?? []).length }
		},
		actorFromContext(ctx)
	);

	return {
		search,
		match: resources(bundle).map(toPatientDisplay),
		countMine: mine.length,
		sokteAfterFnr: isFnr
	};
};
