import { error, redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { execute } from '$srv/fhir/gateway';
import { FhirError } from '$srv/fhir/outcome';
import { toPatientDisplay } from '$srv/fhir/display';
import { activeEmergencyAccess, hasCareRelationship } from '$srv/authz/access';
import { query } from '$srv/db';
import { fhirBaseFor, requireTenant } from '$srv/tenant/context';
import { config } from '$srv/config';
import { canEmergencyAccess } from '$srv/authz/roles';
import { fhirClient } from '$srv/fhir/client';
import { clientAtPlacement, clientsByTab, listClients } from '$srv/auth/clients';
import { createLaunch } from '$srv/auth/oauth';
import { SETTING, getSetting } from '$srv/auth/settings';

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
			'SELECT scope_extent, justification, registered_at FROM record_restriction WHERE patient_id = $1 AND tenant_id = $2 AND lifted = false AND (valid_until IS NULL OR valid_until > now())',
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

	/**
	 * The apps that hold a place in the record.
	 *
	 * `side` is the narrow panel, `hoved` the wide surface beside the record's
	 * own content. A user may keep a different app in the side panel than the
	 * practice's default, so their own choice wins when they have made one; the
	 * record's built-in note editor is what is there when nobody has chosen.
	 *
	 * The launch context is minted here rather than in the frame, so the app
	 * receives an opaque `launch` exactly as it would if started any other way.
	 */
	const tabApps = await clientsByTab();
	const [sideDefault, wideApp] = await Promise.all([
		clientAtPlacement('side'),
		clientAtPlacement('hoved')
	]);
	const chosen = ctx.userId ? await getSetting(ctx.userId, SETTING.SIDE_APP) : null;
	const sideApp =
		chosen === 'journal' ? null : chosen ? (await listClients()).find((c) => c.client_id === chosen && c.status === 'aktiv') ?? sideDefault : sideDefault;

	const launchFor = async (client: { client_id: string; launch_url: string | null } | null | undefined) => {
		if (!client?.launch_url || !ctx.userId || !patient) return null;
		const launchId = await createLaunch({ clientId: client.client_id, userId: ctx.userId, patientId, encounterId: null });
		const url = new URL(client.launch_url);
		url.searchParams.set('iss', fhirBaseFor(requireTenant()));
		url.searchParams.set('launch', launchId);
		return url.toString();
	};

	const [sideUrl, wideUrl] = await Promise.all([launchFor(sideApp), launchFor(wideApp)]);

	return {
		patientId,
		patient,
		// A tab an app has taken over links to the app instead of the record's own
		// page. The record keeps its page for whichever tabs no app answers for.
		tabApps: Object.fromEntries([...tabApps].map(([tab, c]) => [tab, { name: c.name, clientId: c.client_id }])),
		sidePanel: sideApp && sideUrl ? { name: sideApp.name, clientId: sideApp.client_id, url: sideUrl } : null,
		widePanel: wideApp && wideUrl ? { name: wideApp.name, clientId: wideApp.client_id, url: wideUrl } : null,
		nektet,
		minimaltName,
		emergencyAccess,
		relationship,
		blocked: restrictions.length > 0,
		restrictions: restrictions.map((s) => ({ scope_extent: s.scope_extent, justification: s.justification, registered_at: s.registered_at })),
		canBeAboutEmergencyAccess: canEmergencyAccess(ctx.roles),
		canUtlevere: ctx.permissions.has('journal:utlever'),
		canSkrive: ctx.permissions.has('journal:skriv'),
		canRestrict: ctx.permissions.has('pasient:sperr'),
		requireIsOneTimeCode: config.security.requireMfa && ctx.amr !== 'helseid'
	};
};
