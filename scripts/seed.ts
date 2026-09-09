/**
 * Legger inn demodata: brukere med roller, pasienter med journalinnhold,
 * behandlingsrelasjoner, timeavtaler og en registrert SMART-app.
 *
 * Kjøres mot et tomt utviklings- eller testmiljø. Fødselsnumrene under er
 * gyldige mod11-numre fra Skatteetatens syntetiske testdatasett (Tenor) og
 * tilhører ingen virkelig person.
 */
import { exec, lukkPool, query } from '../src/lib/server/db/index';
import { migrer } from '../src/lib/server/db/migrate';
import { opprettBruker, settRoller } from '../src/lib/server/auth/brukere';
import { registrerKlient } from '../src/lib/server/auth/klienter';
import { fhirKlient } from '../src/lib/server/fhir/client';
import { SYSTEM, gyldigNorskPersonnummer, kjonnFraPersonnummer, gyldigDatoDel } from '../src/lib/server/fhir/kodeverk';
import { krypter } from '../src/lib/server/util/crypto';
import { nyTotpHemmelighet } from '../src/lib/server/auth/totp';
import { nyId } from '../src/lib/server/util/ids';
import type { FhirResource } from '../src/lib/server/fhir/types';

const PASSORD = 'Testpassord1!';

/** Fast TOTP-hemmelighet i demo, slik at koden alltid kan regnes ut. */
const DEMO_TOTP = 'JBSWY3DPEHPK3PXP';

interface DemoPasient {
	fnr: string;
	fornavn: string;
	etternavn: string;
	telefon: string;
	adresse: { linje: string; postnr: string; sted: string };
	diagnoser: { kode: string; tekst: string }[];
	malinger: { kode: string; navn: string; verdi: number; enhet: string }[];
	allergier?: string[];
}

const PASIENTER: DemoPasient[] = [
	{
		fnr: '13086510035', fornavn: 'Anne', etternavn: 'Bakken', telefon: '99887766',
		adresse: { linje: 'Storgata 12', postnr: '0155', sted: 'Oslo' },
		diagnoser: [{ kode: 'K86', tekst: 'Hypertensjon ukomplisert' }, { kode: 'T90', tekst: 'Diabetes type 2' }],
		malinger: [
			{ kode: '8480-6', navn: 'Systolisk blodtrykk', verdi: 148, enhet: 'mm[Hg]' },
			{ kode: '8462-4', navn: 'Diastolisk blodtrykk', verdi: 92, enhet: 'mm[Hg]' },
			{ kode: '4548-4', navn: 'HbA1c', verdi: 58, enhet: 'mmol/mol' }
		],
		allergier: ['Penicillin']
	},
	{
		fnr: '05077810023', fornavn: 'Jonas', etternavn: 'Nordli', telefon: '91234567',
		adresse: { linje: 'Kirkeveien 4', postnr: '0368', sted: 'Oslo' },
		diagnoser: [{ kode: 'R96', tekst: 'Astma' }],
		malinger: [{ kode: '19926-5', navn: 'FEV1 % av forventet', verdi: 78, enhet: '%' }]
	},
	{
		fnr: '21129410180', fornavn: 'Sofie', etternavn: 'Lie', telefon: '48891122',
		adresse: { linje: 'Bogstadveien 44', postnr: '0366', sted: 'Oslo' },
		diagnoser: [{ kode: 'P76', tekst: 'Depressiv lidelse' }],
		malinger: [{ kode: '55758-7', navn: 'PHQ-9 sumskår', verdi: 14, enhet: '{score}' }]
	},
	{
		fnr: '24035810281', fornavn: 'Ola', etternavn: 'Vik', telefon: '90011223',
		adresse: { linje: 'Trondheimsveien 100', postnr: '0565', sted: 'Oslo' },
		diagnoser: [{ kode: 'L84', tekst: 'Ryggsyndrom uten smertestråling' }],
		malinger: [{ kode: '29463-7', navn: 'Vekt', verdi: 88, enhet: 'kg' }]
	},
	{
		// Barn under 16 - brukes til å vise fritak for egenandel i oppgjøret.
		fnr: '11061550188', fornavn: 'Emma', etternavn: 'Vik', telefon: '90011223',
		adresse: { linje: 'Trondheimsveien 100', postnr: '0565', sted: 'Oslo' },
		diagnoser: [{ kode: 'R74', tekst: 'Akutt øvre luftveisinfeksjon' }],
		malinger: [{ kode: '8310-5', navn: 'Kroppstemperatur', verdi: 38.4, enhet: 'Cel' }]
	}
];

async function pasientRessurs(p: DemoPasient): Promise<FhirResource> {
	return {
		resourceType: 'Patient',
		identifier: [{ system: SYSTEM.FNR, value: p.fnr, use: 'official' }],
		active: true,
		name: [{ use: 'official', family: p.etternavn, given: [p.fornavn] }],
		gender: kjonnFraPersonnummer(p.fnr),
		birthDate: gyldigDatoDel(p.fnr) ?? undefined,
		telecom: [{ system: 'phone', value: p.telefon, use: 'mobile' }],
		address: [{ use: 'home', line: [p.adresse.linje], postalCode: p.adresse.postnr, city: p.adresse.sted, country: 'NO' }]
	};
}

async function main(): Promise<void> {
	await migrer();

	const finnes = await query<{ n: number }>('SELECT count(*)::int AS n FROM user_account');
	if ((finnes[0]?.n ?? 0) > 0) {
		console.log('Databasen har allerede brukere. Avbryter for ikke å overskrive data.');
		return;
	}

	// --- Behandlere som FHIR Practitioner --------------------------------
	const legeRes = await fhirKlient.opprett({
		resourceType: 'Practitioner',
		identifier: [{ system: SYSTEM.HPR, value: '9144889' }],
		active: true,
		name: [{ family: 'Fastlege', given: ['Ingrid'], prefix: ['Dr.'] }],
		qualification: [{ code: { text: 'Spesialist i allmennmedisin' } }]
	});
	const sykepleierRes = await fhirKlient.opprett({
		resourceType: 'Practitioner',
		identifier: [{ system: SYSTEM.HPR, value: '5551234' }],
		active: true,
		name: [{ family: 'Sykepleier', given: ['Kari'] }]
	});

	// --- Brukere ----------------------------------------------------------
	const brukere = [
		{ brukernavn: 'lege', navn: 'Dr. Ingrid Fastlege', roller: ['lege'] as const, practitionerId: legeRes.ressurs.id as string, hpr: '9144889' },
		{ brukernavn: 'sykepleier', navn: 'Kari Sykepleier', roller: ['sykepleier'] as const, practitionerId: sykepleierRes.ressurs.id as string, hpr: '5551234' },
		{ brukernavn: 'sekretaer', navn: 'Ola Helsesekretær', roller: ['helsesekretaer'] as const, practitionerId: undefined, hpr: undefined },
		{ brukernavn: 'admin', navn: 'Systemansvarlig', roller: ['systemansvarlig'] as const, practitionerId: undefined, hpr: undefined },
		{ brukernavn: 'ombud', navn: 'Personvernombud', roller: ['personvernombud'] as const, practitionerId: undefined, hpr: undefined }
	];

	const idPerBrukernavn = new Map<string, string>();
	for (const b of brukere) {
		const bruker = await opprettBruker({
			brukernavn: b.brukernavn,
			navn: b.navn,
			passord: PASSORD,
			practitionerId: b.practitionerId,
			hprNummer: b.hpr,
			roller: [...b.roller]
		});
		idPerBrukernavn.set(b.brukernavn, bruker.id);
		// Demo: fast TOTP-hemmelighet, og passordet trenger ikke byttes.
		await exec(
			'UPDATE user_account SET totp_secret_enc = $2, mfa_aktivert = true, ma_bytte_passord = false WHERE id = $1',
			[bruker.id, krypter(DEMO_TOTP)]
		);
	}
	console.log(`Opprettet ${brukere.length} brukere (passord: ${PASSORD}).`);

	// --- Pasienter med journalinnhold -------------------------------------
	const legeId = idPerBrukernavn.get('lege') as string;
	const sykepleierId = idPerBrukernavn.get('sykepleier') as string;
	const sekretaerId = idPerBrukernavn.get('sekretaer') as string;

	for (const p of PASIENTER) {
		if (!gyldigNorskPersonnummer(p.fnr)) {
			throw new Error(`Demodata inneholder ugyldig fødselsnummer: ${p.fnr}`);
		}
		const svar = await fhirKlient.opprett(await pasientRessurs(p));
		const patientId = svar.ressurs.id as string;
		const subject = { reference: `Patient/${patientId}` };

		const encounter = await fhirKlient.opprett({
			resourceType: 'Encounter',
			status: 'completed',
			class: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'Poliklinisk kontakt' }] }],
			subject,
			actualPeriod: { start: new Date(Date.now() - 7 * 86400_000).toISOString(), end: new Date(Date.now() - 7 * 86400_000 + 1800_000).toISOString() },
			participant: [{ actor: { reference: `Practitioner/${legeRes.ressurs.id}` } }]
		});

		for (const d of p.diagnoser) {
			await fhirKlient.opprett({
				resourceType: 'Condition',
				clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
				verificationStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'confirmed' }] },
				category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] }],
				code: { coding: [{ system: SYSTEM.ICPC2, code: d.kode, display: d.tekst }], text: d.tekst },
				subject,
				recordedDate: new Date(Date.now() - 200 * 86400_000).toISOString()
			});
		}

		for (const m of p.malinger) {
			await fhirKlient.opprett({
				resourceType: 'Observation',
				status: 'final',
				category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
				code: { coding: [{ system: SYSTEM.LOINC, code: m.kode, display: m.navn }], text: m.navn },
				subject,
				encounter: { reference: `Encounter/${encounter.ressurs.id}` },
				effectiveDateTime: new Date(Date.now() - 7 * 86400_000).toISOString(),
				valueQuantity: { value: m.verdi, unit: m.enhet, system: 'http://unitsofmeasure.org', code: m.enhet }
			});
		}

		for (const a of p.allergier ?? []) {
			await fhirKlient.opprett({
				resourceType: 'AllergyIntolerance',
				clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
				type: { coding: [{ code: 'allergy' }] },
				criticality: 'high',
				code: { text: a },
				patient: subject,
				recordedDate: new Date(Date.now() - 900 * 86400_000).toISOString()
			});
		}

		await fhirKlient.opprett({
			resourceType: 'Composition',
			status: 'final',
			type: { coding: [{ system: SYSTEM.LOINC, code: '11488-4', display: 'Konsultasjonsnotat' }] },
			subject,
			encounter: { reference: `Encounter/${encounter.ressurs.id}` },
			date: new Date(Date.now() - 7 * 86400_000).toISOString(),
			author: [{ reference: `Practitioner/${legeRes.ressurs.id}` }],
			title: 'Konsultasjon',
			section: [
				{ title: 'Subjektivt', text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">Pasienten møter til kontroll for ${p.diagnoser[0]?.tekst ?? 'plagene sine'}.</div>` } },
				{ title: 'Objektivt', text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">Allmenntilstanden er god. Målinger registrert.</div>' } },
				{ title: 'Vurdering og plan', text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">Fortsetter uendret behandling. Ny kontroll om tre måneder.</div>' } }
			]
		});

		await fhirKlient.opprett({
			resourceType: 'Appointment',
			status: 'booked',
			start: new Date(Date.now() + 86400_000 + PASIENTER.indexOf(p) * 1800_000).toISOString(),
			end: new Date(Date.now() + 86400_000 + PASIENTER.indexOf(p) * 1800_000 + 1200_000).toISOString(),
			description: 'Kontroll',
			participant: [
				{ actor: subject, status: 'accepted' },
				{ actor: { reference: `Practitioner/${legeRes.ressurs.id}` }, status: 'accepted' }
			]
		});

		// Behandlingsrelasjoner: legen for alle, sykepleier for de to første,
		// helsesekretær administrativt for alle.
		await exec('INSERT INTO care_relationship (id, user_id, patient_id, grunnlag) VALUES ($1,$2,$3,$4)', [nyId(), legeId, patientId, 'fastlege']);
		if (PASIENTER.indexOf(p) < 2) {
			await exec('INSERT INTO care_relationship (id, user_id, patient_id, grunnlag) VALUES ($1,$2,$3,$4)', [nyId(), sykepleierId, patientId, 'konsultasjon']);
		}
		await exec('INSERT INTO care_relationship (id, user_id, patient_id, grunnlag) VALUES ($1,$2,$3,$4)', [nyId(), sekretaerId, patientId, 'administrativ']);

		console.log(`Pasient ${p.fornavn} ${p.etternavn} (${patientId}) opprettet.`);
	}

	// Én pasient sperrer journalen for sykepleieren, for å vise sperringsflyten.
	const sperretPasient = await fhirKlient.sok('Patient', new URLSearchParams({ identifier: `${SYSTEM.FNR}|${PASIENTER[2].fnr}` }));
	const sperretId = sperretPasient.entry?.[0]?.resource?.id as string | undefined;
	if (sperretId) {
		await exec(
			`INSERT INTO journal_sperring (id, patient_id, omfang, mal_user_id, begrunnelse, registrert_av)
			 VALUES ($1,$2,'bruker',$3,$4,$5)`,
			[nyId(), sperretId, sykepleierId, 'Pasienten ønsker ikke at sykepleier ser journalen.', legeId]
		);
		console.log(`Sperring registrert på pasient ${sperretId} for sykepleier.`);
	}

	// --- SMART-app --------------------------------------------------------
	const { klient, secret } = await registrerKlient({
		navn: 'Diabetesoversikt (demo)',
		type: 'public',
		kategori: 'smart-ehr',
		redirectUris: ['http://localhost:4000/callback', 'http://127.0.0.1:4000/callback'],
		scopes: [
			'openid', 'fhirUser', 'launch', 'launch/patient', 'online_access',
			'patient/Patient.rs', 'patient/Observation.rs', 'patient/Condition.rs', 'patient/MedicationRequest.rs'
		],
		databehandleravtale: 'DBA-2026-001'
	});
	console.log(`SMART-app registrert: ${klient.client_id}${secret ? ` (hemmelighet: ${secret})` : ''}`);

	console.log('\nFerdig. Logg inn på /logg-inn med brukernavn «lege» og passord «' + PASSORD + '».');
	console.log(`TOTP-hemmelighet for demobrukerne: ${DEMO_TOTP}`);
}

await main();
await lukkPool();
