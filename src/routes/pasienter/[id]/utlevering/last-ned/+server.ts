import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	byggJournaluttrekk,
	filnavn,
	tilHtml,
	tilTekst,
	UTLEVERINGSGRUNNER,
	type Utleveringsgrunn
} from '$srv/journal/utlevering';

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
	if (!ctx.rettigheter.has('journal:utlever')) error(403, 'Rollen din kan ikke utlevere journal.');

	const p = event.url.searchParams;
	const format = p.get('format') ?? 'html';
	const grunn = p.get('grunn') ?? 'pasient-innsyn';
	if (!UTLEVERINGSGRUNNER.some((g) => g.kode === grunn)) error(400, 'Ukjent utleveringsgrunn.');
	if (!['html', 'json', 'txt'].includes(format)) error(400, 'Ukjent format.');

	const dato = (n: string) => {
		const v = p.get(n)?.trim();
		if (!v) return undefined;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) error(400, `Ugyldig dato: ${v}`);
		return v;
	};

	const uttrekk = await byggJournaluttrekk(ctx, event.params.id, {
		grunn: grunn as Utleveringsgrunn,
		mottaker: p.get('mottaker')?.trim() || undefined,
		fraDato: dato('fra'),
		tilDato: dato('til')
	});

	const { kropp, type, endelse } =
		format === 'json'
			? { kropp: JSON.stringify(uttrekk.dokument, null, 2), type: 'application/fhir+json', endelse: 'json' as const }
			: format === 'txt'
				? { kropp: tilTekst(uttrekk), type: 'text/plain; charset=utf-8', endelse: 'txt' as const }
				: { kropp: tilHtml(uttrekk), type: 'text/html; charset=utf-8', endelse: 'html' as const };

	return new Response(kropp, {
		headers: {
			'content-type': type,
			// Journalen skal lagres som fil, ikke vises i en ramme et sted.
			'content-disposition': `attachment; filename="${filnavn(uttrekk, endelse)}"`,
			// Helseopplysninger skal ikke ligge i noen mellomlagring.
			'cache-control': 'no-store, private',
			'x-utlevering': uttrekk.utleveringsId
		}
	});
};
