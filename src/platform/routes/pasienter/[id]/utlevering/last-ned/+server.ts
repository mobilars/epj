import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	buildRecordExtract,
	filnavn,
	toHtml,
	toText,
	UTLEVERINGSGRUNNER,
	type Utleveringsgrunn
} from '$srv/journal/disclosure';

/**
 * The disclosure itself.
 *
 * A GET endpoint, so the browser downloads the file directly and the form
 * works without JavaScript. The extract is rebuilt for every download - it is
 * not cached anywhere, so a record with health data is never left lying
 * outside the clinical store.
 */
export const GET: RequestHandler = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) error(401, 'Ikke pålogget.');
	if (!ctx.permissions.has('journal:utlever')) error(403, 'Rollen din kan ikke utlevere journal.');

	const p = event.url.searchParams;
	const format = p.get('format') ?? 'html';
	const reason = p.get('grunn') ?? 'pasient-innsyn';
	if (!UTLEVERINGSGRUNNER.some((g) => g.code === reason)) error(400, 'Ukjent utleveringsgrunn.');
	if (!['html', 'json', 'txt'].includes(format)) error(400, 'Ukjent format.');

	const date = (n: string) => {
		const v = p.get(n)?.trim();
		if (!v) return undefined;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) error(400, `Ugyldig dato: ${v}`);
		return v;
	};

	const extract = await buildRecordExtract(ctx, event.params.id, {
		reason: reason as Utleveringsgrunn,
		recipient: p.get('mottaker')?.trim() || undefined,
		fromDate: date('fra'),
		toDate: date('til')
	});

	const { body, type, extension } =
		format === 'json'
			? { body: JSON.stringify(extract.document, null, 2), type: 'application/fhir+json', extension: 'json' as const }
			: format === 'txt'
				? { body: toText(extract), type: 'text/plain; charset=utf-8', extension: 'txt' as const }
				: { body: toHtml(extract), type: 'text/html; charset=utf-8', extension: 'html' as const };

	return new Response(body, {
		headers: {
			'content-type': type,
			// The record is to be saved as a file, not displayed in a frame somewhere.
			'content-disposition': `attachment; filename="${filnavn(extract, extension)}"`,
			// Health data must not sit in any intermediate cache.
			'cache-control': 'no-store, private',
			'x-utlevering': extract.disclosureId
		}
	});
};
