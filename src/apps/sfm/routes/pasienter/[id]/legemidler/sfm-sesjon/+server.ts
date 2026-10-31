import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from '$routetypes/pasienter/[id]/legemidler/sfm-sesjon/$types';
import { actorFromContext, log } from '$srv/audit';
import { config } from '$srv/config';
import { toPatientDisplay } from '$srv/fhir/display';
import { readResource } from '$srv/fhir/internal';
import { openSfm } from '$apps/sfm/server/session-gateway';

/**
 * Starts SFM for one patient: a session, and a ticket for this patient.
 *
 * The patient is read through the gateway as the user, so someone without access
 * to the record gets no further than they would anywhere else. A JSON post from
 * another site would be stopped by the browser's preflight; the origin is checked
 * here as well, because the record's own check only covers form posts.
 *
 * The answer holds the one-time code, the nonce and the ticket, which is what
 * the page has to pass on, and nothing that identifies the patient.
 */
export const POST: RequestHandler = async (event) => {
	if (!config.integrations.sfm.full) error(404, 'Ikke tilgjengelig');
	const ctx = event.locals.auth;
	if (!ctx?.sessionId || ctx.mate !== 'session') error(401, 'Ikke innlogget');
	if (event.request.headers.get('origin') !== event.url.origin) error(403, 'Kryssopphavs-kall avvist');
	if (!ctx.permissions.has('journal:les')) error(403, 'Ingen tilgang');

	// Against NHN, SFM needs the token only a HelseID sign-in leaves behind. The
	// simulator stands in for all of it, so it can be run without one.
	const live = config.integrations.mode !== 'mock';
	if (live && ctx.amr !== 'helseid') return json({ reason: 'needs-helseid' }, { status: 409 });

	const patient = toPatientDisplay(await readResource(ctx, 'Patient', event.params.id));
	// An unverified number is deliberately not offered here: SFM would pass it on
	// to Reseptformidleren as though it were real.
	if (!patient.nationalId) return json({ reason: 'no-national-id' }, { status: 409 });

	let launch;
	try {
		launch = await openSfm(ctx.sessionId, patient.nationalId);
	} catch (err) {
		console.error('[sfm] could not start', (err as Error).message);
		await log(
			{ type: 'integrasjon', subtype: 'sfm:åpne', action: 'E', outcome: '8', patientId: event.params.id, purposeOfUse: 'TREAT' },
			actorFromContext(ctx)
		);
		return json({ reason: 'unavailable' }, { status: 502 });
	}
	if (!launch) return json({ reason: 'needs-helseid' }, { status: 409 });

	await log(
		{ type: 'integrasjon', subtype: 'sfm:åpne', action: 'E', outcome: '0', patientId: event.params.id, purposeOfUse: 'TREAT' },
		actorFromContext(ctx)
	);
	return json(launch, { headers: { 'cache-control': 'no-store' } });
};
