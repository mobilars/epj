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

import { exec } from '../src/platform/server/db';
import { getTenant } from '../src/platform/server/tenant/tenant';
import { requireTenant, withTenant } from '../src/platform/server/tenant/context';
import { setInMainMenu, type Placement } from '../src/platform/server/auth/clients';
import { getCatalogueApp, installApp, installsForTenant, platformApps, savePlatformApp } from '../src/platform/server/developer/catalogue';

const READ = 'openid fhirUser launch launch/patient online_access patient/Patient.rs';

interface App {
	name: string;
	host: string;
	scopes: string[];
	placement: Placement;
	inMainMenu?: boolean;
	/** Record tab this app answers for, by route segment. */
	replacesTab?: string;
	note: string;
}

const APPS: App[] = [
	{
		name: 'Diabetesoversikt (demo)',
		host: 'https://diabetes.apps.apus.no',
		scopes: `${READ} patient/Observation.rs patient/Observation.cu patient/Condition.rs patient/MedicationRequest.rs`.split(' '),
		placement: 'ingen',
		note: 'HbA1c, blodtrykk, vekt og legemidler på ett skjermbilde. Demonstrasjon.'
	},
	{
		name: 'Vekstkurve',
		host: 'https://vekst.apps.apus.no',
		scopes: `${READ} patient/Observation.rs patient/Observation.cu`.split(' '),
		placement: 'ingen',
		note: 'Høyde og vekt over tid, med ny måling. Demonstrasjon, uten persentilkurver.'
	},
	{
		name: 'Hjerterisiko',
		host: 'https://hjerterisiko.apps.apus.no',
		scopes: `${READ} patient/Observation.rs patient/Observation.cu patient/Condition.rs`.split(' '),
		placement: 'ingen',
		note: 'Tiårsrisiko for hjerte- og karsykdom etter Framingham-modellen. Demonstrasjon, ikke NORRISK 2.'
	},
	{
		name: 'Journalnotat',
		host: 'https://notat.apps.apus.no',
		scopes: `${READ} patient/Composition.rs patient/Composition.c patient/Encounter.c patient/Condition.c`.split(' '),
		placement: 'side',
		// Narrow in the panel, wide in the tab - one app, two shapes.
		replacesTab: 'notater',
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
		replacesTab: 'legemidler',
		note: 'Legemiddellisten. Ikke koblet til SFM eller e-resept.'
	},
	{
		name: 'FHIR-testapp',
		host: 'https://smartdemo.apps.apus.no',
		scopes: `${READ} patient/Observation.rs patient/Condition.rs patient/MedicationRequest.rs patient/Observation.c`.split(' '),
		placement: 'ingen',
		note: 'Teknisk app for å prøve SMART on FHIR mot journalen.'
	}
];

/** Puts the app in the catalogue as a platform app, and installs it here if it is not already. */
async function ensure(app: App): Promise<string> {
	const existing = (await platformApps()).find((a) => a.name === app.name);
	const { id } = await savePlatformApp(
		existing?.id ?? null,
		{
			name: app.name,
			summary: app.note,
			description: '',
			launchUrl: `${app.host}/launch?client_id={client_id}`,
			redirectUris: [`${app.host}/callback`],
			scopes: app.scopes,
			placement: app.placement,
			contactEmail: '',
			privacyUrl: '',
			databehandleravtale: app.note,
			replacesTab: app.replacesTab ?? null
		},
		null
	);
	const installs = await installsForTenant();
	if (installs.some((install) => install.catalogue_id === id)) return 'oppdatert';
	const { clientId } = await installApp((await getCatalogueApp(id))!, null);
	if (app.inMainMenu) await setInMainMenu(clientId, true);
	return `installert ${clientId}`;
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
