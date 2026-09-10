/**
 * Inserts demo data: users with roles, patients with record content, care
 * relationships, appointments and a registered SMART app.
 *
 * Run against an empty development or test environment. The national identity
 * numbers below are valid mod11 numbers from the Tax Administration's synthetic
 * test set (Tenor) and belong to no real person.
 */
import { exec, closePool, query } from '../src/lib/server/db/index';
import { migrate } from '../src/lib/server/db/migrate';
import { withTenant, PLATFORM_TENANT, type Tenant } from '../src/lib/server/tenant/context';
import { getTenant, ensureDefaultOrganisation } from '../src/lib/server/tenant/tenant';
import { createUser, setRoles } from '../src/lib/server/auth/users';
import { registerClient } from '../src/lib/server/auth/clients';
import { fhirClient } from '../src/lib/server/fhir/client';
import { SYSTEM, validNorwegianNationalId, genderFromNationalId, validDateDel } from '../src/lib/server/fhir/codesystems';
import { encrypt } from '../src/lib/server/util/crypto';
import { newTotpSecret } from '../src/lib/server/auth/totp';
import { newId } from '../src/lib/server/util/ids';
import type { FhirResource } from '../src/lib/server/fhir/types';

const PASSWORD = 'Testpassord1!';

/** Fixed TOTP secret in the demo, so the code can always be computed. */
const DEMO_TOTP = 'JBSWY3DPEHPK3PXP';

interface DemoPatient {
	fnr: string;
	givenName: string;
	familyName: string;
	phone: string;
	address: { line: string; postnr: string; sted: string };
	diagnoses: { code: string; text: string }[];
	malinger: { code: string; name: string; value: number; unit: string }[];
	allergier?: string[];
}

const PATIENTS: DemoPatient[] = [
	{
		fnr: '13086510035', givenName: 'Anne', familyName: 'Bakken', phone: '99887766',
		address: { line: 'Storgata 12', postnr: '0155', sted: 'Oslo' },
		diagnoses: [{ code: 'K86', text: 'Hypertensjon ukomplisert' }, { code: 'T90', text: 'Diabetes type 2' }],
		malinger: [
			{ code: '8480-6', name: 'Systolisk blodtrykk', value: 148, unit: 'mm[Hg]' },
			{ code: '8462-4', name: 'Diastolisk blodtrykk', value: 92, unit: 'mm[Hg]' },
			{ code: '4548-4', name: 'HbA1c', value: 58, unit: 'mmol/mol' }
		],
		allergier: ['Penicillin']
	},
	{
		fnr: '05077810023', givenName: 'Jonas', familyName: 'Nordli', phone: '91234567',
		address: { line: 'Kirkeveien 4', postnr: '0368', sted: 'Oslo' },
		diagnoses: [{ code: 'R96', text: 'Astma' }],
		malinger: [{ code: '19926-5', name: 'FEV1 % av forventet', value: 78, unit: '%' }]
	},
	{
		fnr: '21129410180', givenName: 'Sofie', familyName: 'Lie', phone: '48891122',
		address: { line: 'Bogstadveien 44', postnr: '0366', sted: 'Oslo' },
		diagnoses: [{ code: 'P76', text: 'Depressiv lidelse' }],
		malinger: [{ code: '55758-7', name: 'PHQ-9 sumskår', value: 14, unit: '{score}' }]
	},
	{
		fnr: '24035810281', givenName: 'Ola', familyName: 'Vik', phone: '90011223',
		address: { line: 'Trondheimsveien 100', postnr: '0565', sted: 'Oslo' },
		diagnoses: [{ code: 'L84', text: 'Ryggsyndrom uten smertestråling' }],
		malinger: [{ code: '29463-7', name: 'Vekt', value: 88, unit: 'kg' }]
	},
	{
		// Children under 16 - used to show copayment exemption in the settlement.
		fnr: '11061550188', givenName: 'Emma', familyName: 'Vik', phone: '90011223',
		address: { line: 'Trondheimsveien 100', postnr: '0565', sted: 'Oslo' },
		diagnoses: [{ code: 'R74', text: 'Akutt øvre luftveisinfeksjon' }],
		malinger: [{ code: '8310-5', name: 'Kroppstemperatur', value: 38.4, unit: 'Cel' }]
	}
];

async function patientResource(p: DemoPatient): Promise<FhirResource> {
	return {
		resourceType: 'Patient',
		identifier: [{ system: SYSTEM.FNR, value: p.fnr, use: 'official' }],
		active: true,
		name: [{ use: 'official', family: p.familyName, given: [p.givenName] }],
		gender: genderFromNationalId(p.fnr),
		birthDate: validDateDel(p.fnr) ?? undefined,
		telecom: [{ system: 'phone', value: p.phone, use: 'mobile' }],
		address: [{ use: 'home', line: [p.address.line], postalCode: p.address.postnr, city: p.address.sted, country: 'NO' }]
	};
}

async function main(): Promise<void> {
	await migrate();
	await ensureDefaultOrganisation();

	// Demo data goes into the default organisation. Everything below runs in its
	// context, so queries are bounded exactly as they are in the application.
	const tenantId = process.env.EPJ_SEED_TENANT ?? 'standard';
	const tenant = await getTenant(tenantId);
	if (!tenant) throw new Error(`Virksomheten «${tenantId}» finnes ikke. Kjør migrasjonene først.`);
	await withTenant(tenant, () => seed(tenant));

	// The platform administrator belongs to the system organisation, not to any
	// of the practices. The `systemeier` role holds no clinical scopes.
	const platform = await getTenant(PLATFORM_TENANT);
	if (platform) await withTenant(platform, () => seedPlatform(platform));
}

async function seedPlatform(platform: Tenant): Promise<void> {
	const exists = await query<{ n: number }>('SELECT count(*)::int AS n FROM user_account WHERE tenant_id = $1', [
		platform.id
	]);
	if ((exists[0]?.n ?? 0) > 0) return;

	const user = await createUser({
		username: 'systemeier',
		name: 'Plattformadministrator',
		password: PASSWORD,
		roles: ['systemeier']
	});
	await exec(
		'UPDATE user_account SET totp_secret_enc = $2, mfa_aktivert = true, must_change_password = false WHERE id = $1',
		[user.id, encrypt(DEMO_TOTP)]
	);
	console.log(`Opprettet plattformbruker «systemeier» (passord: ${PASSWORD}).`);
}

async function seed(tenant: Tenant): Promise<void> {
	const exists = await query<{ n: number }>('SELECT count(*)::int AS n FROM user_account WHERE tenant_id = $1', [tenant.id]);
	if ((exists[0]?.n ?? 0) > 0) {
		console.log('Databasen har allerede brukere. Avbryter for ikke å overskrive data.');
		return;
	}

	// --- Practitioners as FHIR Practitioner --------------------------------
	const doctorRes = await fhirClient.create({
		resourceType: 'Practitioner',
		identifier: [{ system: SYSTEM.HPR, value: '9144889' }],
		active: true,
		name: [{ family: 'Fastlege', given: ['Ingrid'], prefix: ['Dr.'] }],
		qualification: [{ code: { text: 'Spesialist i allmennmedisin' } }]
	});
	const nurseRes = await fhirClient.create({
		resourceType: 'Practitioner',
		identifier: [{ system: SYSTEM.HPR, value: '5551234' }],
		active: true,
		name: [{ family: 'Sykepleier', given: ['Kari'] }]
	});

	// --- Brukere ----------------------------------------------------------
	const users = [
		{ username: 'lege', name: 'Dr. Ingrid Fastlege', roles: ['lege'] as const, practitionerId: doctorRes.resource.id as string, hpr: '9144889' },
		{ username: 'sykepleier', name: 'Kari Sykepleier', roles: ['sykepleier'] as const, practitionerId: nurseRes.resource.id as string, hpr: '5551234' },
		{ username: 'sekretaer', name: 'Ola Helsesekretær', roles: ['helsesekretaer'] as const, practitionerId: undefined, hpr: undefined },
		{ username: 'admin', name: 'Systemansvarlig', roles: ['systemansvarlig'] as const, practitionerId: undefined, hpr: undefined },
		{ username: 'ombud', name: 'Personvernombud', roles: ['personvernombud'] as const, practitionerId: undefined, hpr: undefined }
	];

	const idPerUsername = new Map<string, string>();
	for (const b of users) {
		const user = await createUser({
			username: b.username,
			name: b.name,
			password: PASSWORD,
			practitionerId: b.practitionerId,
			hprNumber: b.hpr,
			roles: [...b.roles]
		});
		idPerUsername.set(b.username, user.id);
		// Demo: fixed TOTP secret, and the password need not be changed.
		await exec(
			'UPDATE user_account SET totp_secret_enc = $2, mfa_aktivert = true, must_change_password = false WHERE id = $1',
			[user.id, encrypt(DEMO_TOTP)]
		);
	}
	console.log(`Opprettet ${users.length} brukere (passord: ${PASSWORD}).`);

	// --- Patients with record content ---------------------------------------
	const doctorId = idPerUsername.get('lege') as string;
	const nurseId = idPerUsername.get('sykepleier') as string;
	const sekretaerId = idPerUsername.get('sekretaer') as string;

	for (const p of PATIENTS) {
		if (!validNorwegianNationalId(p.fnr)) {
			throw new Error(`Demodata inneholder ugyldig fødselsnummer: ${p.fnr}`);
		}
		const response = await fhirClient.create(await patientResource(p));
		const patientId = response.resource.id as string;
		const subject = { reference: `Patient/${patientId}` };

		const encounter = await fhirClient.create({
			resourceType: 'Encounter',
			status: 'completed',
			class: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'Poliklinisk kontakt' }] }],
			subject,
			actualPeriod: { start: new Date(Date.now() - 7 * 86400_000).toISOString(), end: new Date(Date.now() - 7 * 86400_000 + 1800_000).toISOString() },
			participant: [{ actor: { reference: `Practitioner/${doctorRes.resource.id}` } }]
		});

		for (const d of p.diagnoses) {
			await fhirClient.create({
				resourceType: 'Condition',
				clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
				verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
				category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
				code: { coding: [{ system: SYSTEM.ICPC2, code: d.code, display: d.text }], text: d.text },
				subject,
				recordedDate: new Date(Date.now() - 200 * 86400_000).toISOString()
			});
		}

		for (const m of p.malinger) {
			await fhirClient.create({
				resourceType: 'Observation',
				status: 'final',
				category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
				code: { coding: [{ system: SYSTEM.LOINC, code: m.code, display: m.name }], text: m.name },
				subject,
				encounter: { reference: `Encounter/${encounter.resource.id}` },
				effectiveDateTime: new Date(Date.now() - 7 * 86400_000).toISOString(),
				valueQuantity: { value: m.value, unit: m.unit, system: 'http://unitsofmeasure.org', code: m.unit }
			});
		}

		for (const a of p.allergier ?? []) {
			await fhirClient.create({
				resourceType: 'AllergyIntolerance',
				clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
				type: { coding: [{ code: 'allergy' }] },
				criticality: 'high',
				code: { text: a },
				patient: subject,
				recordedDate: new Date(Date.now() - 900 * 86400_000).toISOString()
			});
		}

		await fhirClient.create({
			resourceType: 'Composition',
			status: 'final',
			type: { coding: [{ system: SYSTEM.LOINC, code: '11488-4', display: 'Konsultasjonsnotat' }] },
			subject,
			encounter: { reference: `Encounter/${encounter.resource.id}` },
			date: new Date(Date.now() - 7 * 86400_000).toISOString(),
			author: [{ reference: `Practitioner/${doctorRes.resource.id}` }],
			title: 'Konsultasjon',
			section: [
				{ title: 'Subjektivt', text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">Pasienten møter til kontroll for ${p.diagnoses[0]?.text ?? 'plagene sine'}.</div>` } },
				{ title: 'Objektivt', text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">Allmenntilstanden er god. Målinger registrert.</div>' } },
				{ title: 'Vurdering og plan', text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">Fortsetter uendret behandling. Ny kontroll om tre måneder.</div>' } }
			]
		});

		await fhirClient.create({
			resourceType: 'Appointment',
			status: 'booked',
			start: new Date(Date.now() + 86400_000 + PATIENTS.indexOf(p) * 1800_000).toISOString(),
			end: new Date(Date.now() + 86400_000 + PATIENTS.indexOf(p) * 1800_000 + 1200_000).toISOString(),
			description: 'Kontroll',
			participant: [
				{ actor: subject, status: 'accepted' },
				{ actor: { reference: `Practitioner/${doctorRes.resource.id}` }, status: 'accepted' }
			]
		});

		// Care relationships: the doctor for everyone, the nurse for the first two,
		// the medical secretary administratively for all.
		const relationship = (userId: string, basis: string) =>
			exec('INSERT INTO care_relationship (id, tenant_id, user_id, patient_id, basis) VALUES ($1,$2,$3,$4,$5)', [
				newId(), tenant.id, userId, patientId, basis
			]);
		await relationship(doctorId, 'fastlege');
		if (PATIENTS.indexOf(p) < 2) await relationship(nurseId, 'konsultasjon');
		await relationship(sekretaerId, 'administrativ');

		console.log(`Pasient ${p.givenName} ${p.familyName} (${patientId}) opprettet.`);
	}

	// One patient blocks the record for the nurse, to show the restriction flow.
	const blockedPatient = await fhirClient.search('Patient', new URLSearchParams({ identifier: `${SYSTEM.FNR}|${PATIENTS[2].fnr}` }));
	const blockedId = blockedPatient.entry?.[0]?.resource?.id as string | undefined;
	if (blockedId) {
		await exec(
			`INSERT INTO record_restriction (id, tenant_id, patient_id, scope_extent, target_user_id, justification, registered_by)
			 VALUES ($1,$6,$2,'bruker',$3,$4,$5)`,
			[newId(), blockedId, nurseId, 'Pasienten ønsker ikke at sykepleier ser journalen.', doctorId, tenant.id]
		);
		console.log(`Sperring registrert på pasient ${blockedId} for sykepleier.`);
	}

	// --- SMART-app --------------------------------------------------------
	const { client, secret } = await registerClient({
		name: 'Diabetesoversikt (demo)',
		type: 'public',
		category: 'smart-ehr',
		redirectUris: ['http://localhost:4000/callback', 'http://127.0.0.1:4000/callback'],
		scopes: [
			'openid', 'fhirUser', 'launch', 'launch/patient', 'online_access',
			'patient/Patient.rs', 'patient/Observation.rs', 'patient/Condition.rs', 'patient/MedicationRequest.rs'
		],
		launchUrl: 'http://localhost:4000/launch',
		databehandleravtale: 'DBA-2026-001'
	});
	console.log(`SMART-app registrert: ${client.client_id}${secret ? ` (hemmelighet: ${secret})` : ''}`);

	console.log(`\nFerdig i virksomheten «${tenant.name}» (${tenant.id}).`);
	console.log('Logg inn på /logg-inn med brukernavn «lege» og passord «' + PASSWORD + '».');
	console.log(`TOTP-hemmelighet for demobrukerne: ${DEMO_TOTP}`);
}

await main();
await closePool();
