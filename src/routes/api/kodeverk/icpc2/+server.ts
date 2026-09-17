import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { lookupIcpc2, searchIcpc2 } from '$srv/terminology/icpc2';

/**
 * ICPC-2 search for the record's own forms.
 *
 * The same table the FHIR terminology operations answer from, in the shape a
 * picker wants: a short list, ranked, with the official name. Apps use
 * `/fhir/ValueSet/$expand`; this is the record's own door, behind its session.
 */
export const GET: RequestHandler = ({ url, locals }) => {
	if (!locals.auth) return json({ error: 'Ikke pålogget' }, { status: 401 });
	const q = url.searchParams.get('q') ?? '';
	const exact = lookupIcpc2(q);
	const results = searchIcpc2(q, 12).map((c) => ({
		code: c.code,
		display: c.display,
		chapter: c.chapter,
		icd10: c.icd10 ?? null,
		inclusion: c.inclusion ?? null
	}));
	return json(
		{ query: q, exact: exact && exact.level === 2 ? { code: exact.code, display: exact.display } : null, results },
		{ headers: { 'cache-control': 'private, max-age=3600' } }
	);
};
