import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { execute } from '$srv/fhir/gateway';
import { FhirError } from '$srv/fhir/outcome';
import { toPatientDisplay } from '$srv/fhir/display';
import { activeEmergencyAccess, hasCareRelationship } from '$srv/authz/access';
import { query } from '$srv/db';
import { requireTenant } from '$srv/tenant/context';
import { config } from '$srv/config';
import { canEmergencyAccess } from '$srv/authz/roles';
import { fhirClient } from '$srv/fhir/client';

/**
 * The frame around a single patient record.
 *
 * When the user lacks a legitimate need, no ordinary error page is shown: the
 * user gets to see that the patient exists, and can ask for emergency access
 * with a justification. This is what makes the restriction manageable in acute
 * situations without weakening the main rule - the attempt is logged whatever
 * the outcome.
 */
export const load: LayoutServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (!ctx.permissions.has('journal:les')) {
		error(403, 'Rollen din har ikke tilgang til pasientopplysninger.');
	}
	const patientId = event.params.id;

	let patient = null;
	let nektet: string | null = null;
	try {
		const response = await execute({ ctx, method: 'GET', path: `Patient/${patientId}`, search: new URLSearchParams() });
		patient = toPatientDisplay(response.resource);
	} catch (err) {
		if (err instanceof FhirError && (err.status === 403 || err.status === 404)) {
			nektet = err.issues[0]?.diagnostics ?? 'Ingen tilgang';
		} else {
			throw err;
		}
	}

	const [emergencyAccess, relationship, restrictions] = await Promise.all([
		activeEmergencyAccess(ctx.userId, patientId),
		hasCareRelationship(ctx.userId, patientId),
		query<{ scope_extent: string; justification: string | null; registered_at: string }>(
			'SELECT scope_extent, justification, registered_at FROM record_restriction WHERE patient_id = $1 AND tenant_id = $2 AND lifted = false',
			[patientId, requireTenant().id]
		)
	]);

	// The name is shown in the emergency-access dialog even without access to the
	// record content, so the user can check they are asking for the right person.
	let minimaltName: string | null = null;
	if (!patient && nektet) {
		const raw = await fhirClient.read('Patient', patientId).catch(() => null);
		if (raw) minimaltName = toPatientDisplay(raw).name;
	}

	return {
		patientId,
		patient,
		nektet,
		minimaltName,
		emergencyAccess,
		relationship,
		blocked: restrictions.length > 0,
		restrictions: restrictions.map((s) => ({ scope_extent: s.scope_extent, justification: s.justification, registered_at: s.registered_at })),
		canBeAboutEmergencyAccess: canEmergencyAccess(ctx.roles),
		canUtlevere: ctx.permissions.has('journal:utlever'),
		canSkrive: ctx.permissions.has('journal:skriv'),
		requireIsOneTimeCode: config.security.requireMfa && ctx.amr !== 'helseid'
	};
};
