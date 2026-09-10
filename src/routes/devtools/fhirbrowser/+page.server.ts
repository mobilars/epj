import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { searchResources, readResource, resources } from '$srv/fhir/internal';
import { STOTTEDE_RESSURSTYPER } from '$srv/fhir/searchparams';
import { config } from '$srv/config';
import { log, actorFromContext } from '$srv/audit';
import { fhirBaseFor } from '$srv/tenant/context';
import { requireTenant } from '$srv/tenant/context';

/**
 * A reader for the FHIR resources the record writes.
 *
 * Built for development: when a note, a prescription or a settlement does not
 * look the way it should in the interface, the question is almost always what
 * was actually stored - and reading it through the same gateway the API uses
 * answers that without a second route into the data.
 *
 * It is deliberately not a back door. Every lookup goes through
 * `fhir/internal`, so scope, role, legitimate need and restriction all apply
 * exactly as they do elsewhere, and every read is written to the audit log
 * under the user who made it. What it adds over the API is a page to look at.
 *
 * Available only where the test surfaces are on, and only to a role that may
 * already read the record.
 */

export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname + event.url.search)}`);

	// Off wherever the test sign-in is off - which is to say, in production.
	if (!config.testLogin.aktivert) error(404, 'Ikke tilgjengelig.');
	if (!ctx.permissions.has('journal:les')) error(403, 'Rollen din har ikke tilgang til journalinnhold.');

	const type = (event.url.searchParams.get('type') ?? 'Patient').trim();
	const patient = (event.url.searchParams.get('pasient') ?? '').trim();
	const id = (event.url.searchParams.get('id') ?? '').trim();

	const types = [...STOTTEDE_RESSURSTYPER].sort();
	if (!types.includes(type)) error(400, `Ukjent ressurstype: ${type}`);

	await log(
		{ type: 'rest', subtype: 'devtools:fhir', action: 'R', outcome: '0', details: { type, id: id || null } },
		actorFromContext(ctx)
	);

	// One resource by id, or a page of them.
	if (id) {
		const resource = await readResource(ctx, type, id);
		return {
			types,
			type,
			patient,
			id,
			fhirBase: fhirBaseFor(requireTenant()),
			single: JSON.stringify(resource, null, 2),
			list: []
		};
	}

	const parameters: Record<string, string | number> = { _count: 25, _sort: '-_lastUpdated' };
	if (patient) parameters[type === 'Patient' ? '_id' : 'patient'] = type === 'Patient' ? patient : `Patient/${patient}`;

	const bundle = await searchResources(ctx, type, parameters);
	return {
		types,
		type,
		patient,
		id: '',
		fhirBase: fhirBaseFor(requireTenant()),
		single: null,
		list: resources(bundle).map((r) => ({
			id: r.id as string,
			lastUpdated: ((r.meta as { lastUpdated?: string } | undefined)?.lastUpdated) ?? '',
			version: (r.meta?.versionId as string) ?? '',
			summary: JSON.stringify(r).slice(0, 160)
		}))
	};
};
