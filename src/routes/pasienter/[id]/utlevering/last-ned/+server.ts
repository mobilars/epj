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
 * Selve utleveringen.
 *
 * Et GET-endepunkt, slik at nettleseren laster ned filen direkte og skjemaet
 * virker uten JavaScript. Uttrekket bygges på nytt for hver nedlasting - det
 * mellomlagres ikke noe sted, så en journal med helseopplysninger blir aldri
 * liggende utenfor det kliniske lageret.
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
			// Journalen skal lagres som fil, ikke vises i en ramme et sted.
			'content-disposition': `attachment; filename="${filnavn(extract, extension)}"`,
			// Helseopplysninger skal ikke ligge i noen mellomlagring.
			'cache-control': 'no-store, private',
			'x-utlevering': extract.disclosureId
		}
	});
};
