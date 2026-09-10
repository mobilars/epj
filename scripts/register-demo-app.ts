/**
 * Registers the first-party SMART apps.
 *
 * Each app's launch URL carries its client id, because the apps are static and
 * have no configuration of their own - that is what lets one app be pointed at
 * several record systems without rebuilding it. The id only exists once the
 * client is registered, so the URL is completed afterwards.
 *
 * Idempotent: run it again and it updates what is there rather than adding a
 * second registration.
 *
 *   npm run register:apper
 */

import { exec } from '../src/lib/server/db';
import { getTenant } from '../src/lib/server/tenant/tenant';
import { requireTenant, withTenant } from '../src/lib/server/tenant/context';
import { listClients, registerClient, setPlacement, setRequireConsent, type Placement } from '../src/lib/server/auth/clients';

const READ = 'openid fhirUser launch launch/patient online_access patient/Patient.rs';

interface App {
	name: string;
	host: string;
	scopes: string[];
	placement: Placement;
	inMainMenu?: boolean;
	note: string;
}

const APPS: App[] = [
	{
		name: 'Journalnotat',
		host: 'https://notat.apps.apus.no',
		scopes: `${READ} patient/Composition.rs patient/Composition.c patient/Encounter.c patient/Condition.c`.split(' '),
		placement: 'side',
		note: 'Journalens eget notatfelt, bygget som app.'
	},
	{
		name: 'Kritisk informasjon',
		host: 'https://kritisk.apps.apus.no',
		scopes: `${READ} patient/AllergyIntolerance.rs patient/Condition.rs`.split(' '),
		placement: 'ingen',
		note: 'Alvorlige allergier og tilstander.'
	},
	{
		name: 'Legemidler',
		host: 'https://legemidler.apps.apus.no',
		scopes: `${READ} patient/MedicationRequest.rs patient/MedicationRequest.cu patient/AllergyIntolerance.rs`.split(' '),
		placement: 'ingen',
		inMainMenu: true,
		note: 'Legemiddellisten. Forskrivning går fortsatt gjennom SFM i journalen.'
	},
	{
		name: 'FHIR-testapp',
		host: 'https://smartdemo.apps.apus.no',
		scopes: `${READ} patient/Observation.rs patient/Condition.rs patient/MedicationRequest.rs patient/Observation.c`.split(' '),
		placement: 'ingen',
		note: 'Teknisk app for å prøve SMART on FHIR mot journalen.'
	}
];

async function ensure(app: App): Promise<string> {
	const tenantId = requireTenant().id;
	const existing = (await listClients()).find((c) => c.name === app.name);
	const clientId = existing?.client_id;

	if (clientId) {
		await exec(
			`UPDATE oauth_client
			 SET redirect_uris = $2, allowed_scopes = $3, launch_url = $4, in_main_menu = $5, status = 'aktiv'
			 WHERE client_id = $1 AND tenant_id = $6`,
			[
				clientId,
				JSON.stringify([`${app.host}/callback`]),
				JSON.stringify(app.scopes),
				`${app.host}/launch?client_id=${clientId}`,
				app.inMainMenu ?? false,
				tenantId
			]
		);
		await setPlacement(clientId, app.placement);
		// An app the practice has placed opens on every patient. A consent dialog
		// on every patient is not a decision anyone makes.
		await setRequireConsent(clientId, app.placement === 'ingen');
		return `oppdatert  ${clientId}`;
	}

	const { client } = await registerClient({
		name: app.name,
		type: 'public',
		category: 'smart-ehr',
		redirectUris: [`${app.host}/callback`],
		scopes: app.scopes,
		launchUrl: `${app.host}/launch`,
		databehandleravtale: app.note,
		inMainMenu: app.inMainMenu ?? false
	});
	// Now that the id exists, put it on the launch URL.
	await exec('UPDATE oauth_client SET launch_url = $2 WHERE client_id = $1 AND tenant_id = $3', [
		client.client_id,
		`${app.host}/launch?client_id=${client.client_id}`,
		tenantId
	]);
	await setPlacement(client.client_id, app.placement);
	await setRequireConsent(client.client_id, app.placement === 'ingen');
	return `registrert ${client.client_id}`;
}

async function main(): Promise<void> {
	const tenantId = process.env.EPJ_SEED_TENANT ?? 'standard';
	const tenant = await getTenant(tenantId);
	if (!tenant) throw new Error(`Virksomheten «${tenantId}» finnes ikke.`);

	await withTenant(tenant, async () => {
		for (const app of APPS) {
			const outcome = await ensure(app);
			console.log(`  ${app.name.padEnd(22)} ${app.placement.padEnd(6)} ${outcome}`);
		}
	});
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err);
		process.exit(1);
	}
);
