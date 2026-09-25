import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { readResource } from '$srv/fhir/internal';
import { codeText, formatsDate } from '$srv/fhir/display';
import { log, actorFromContext } from '$srv/audit';

/**
 * One record note, laid out to be printed.
 *
 * The disclosure page hands out the whole record or a period of it, which is
 * the right tool for a request under the right of access and the wrong one for
 * the everyday case: one note, for the patient to take home or for a colleague
 * who has no access to the record.
 *
 * A printout leaves the record's control the moment it exists, so opening this
 * page is logged as a print in its own right, not only as the read the gateway
 * logs anyway. The patient sees it in their access log as what it was.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.userId) redirect(303, '/logg-inn');

	const parent = await event.parent();
	if (!parent.patient) error(403, 'Du har ikke tilgang til denne journalen.');

	const note = await readResource(ctx, 'Composition', event.params.note);

	// The note has to belong to the patient in the address. Otherwise one
	// patient's note would print under another patient's name.
	const subject = (note.subject as { reference?: string } | undefined)?.reference;
	if (subject !== `Patient/${event.params.id}`) error(404, 'Fant ikke notatet.');

	await log(
		{
			type: 'rest',
			subtype: 'notat:utskrift',
			action: 'R',
			outcome: '0',
			patientId: event.params.id,
			entityRef: `Composition/${event.params.note}`,
			details: { version: note.meta?.versionId ?? '1' }
		},
		actorFromContext(ctx)
	);

	const sections = ((note.section as { title?: string; text?: { div?: string } }[]) ?? []).map((s) => ({
		title: s.title ?? '',
		// The section text is our own escaped XHTML; printing wants the words.
		text: (s.text?.div ?? '')
			.replace(/<[^>]+>/g, '')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&amp;/g, '&')
			.trim()
	}));

	// A note marked as entered in error carries the reason as an annotation.
	// A printout of it has to say so as plainly as the screen does.
	const corrections = ((note.note as { text?: string; time?: string }[]) ?? []).map((n) => ({
		text: n.text ?? '',
		time: formatsDate(n.time, true)
	}));

	return {
		note: {
			id: note.id as string,
			title: (note.title as string) ?? codeText(note.type),
			date: formatsDate(note.date as string, true),
			status: note.status as string,
			author: ((note.author as { display?: string }[]) ?? [])[0]?.display ?? '',
			version: note.meta?.versionId ?? '1',
			sections,
			corrections
		},
		printedBy: ctx.name,
		printedAt: formatsDate(new Date().toISOString(), true)
	};
};
