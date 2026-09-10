import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/server/db/index';
import { hasTestDatabase, createTestDatabase, setIn, emptyTables, type TestDatabase } from './fixtures/db';
import { fhirForTest, type TestFhirServer } from './fixtures/fhir-testserver';
import { context } from './fixtures/context';
import { buildRecordExtract, filnavn, toHtml, toText, UTLEVERINGSGRUNNER } from '../src/lib/server/journal/disclosure';
import { fhirClient } from '../src/lib/server/fhir/client';
import { SYSTEM } from '../src/lib/server/fhir/codesystems';
import { newId } from '../src/lib/server/util/ids';
import type { FhirResource } from '../src/lib/server/fhir/types';

const describeIf = hasTestDatabase() ? describe : describe.skip;

/**
 * Disclosure of the record.
 *
 * The tests check what actually matters legally: that the extract goes through
 * access control, that what is disclosed is what the receipt says, that the
 * legal basis ends up in the security log, and that the readable and the
 * machine-readable version say the same thing.
 */
describeIf('utlevering av journal', () => {
	let db: TestDatabase;
	let fhir: TestFhirServer;
	let patient = '';
	let annenPatient = '';

	beforeAll(async () => {
		db = await createTestDatabase('utlev');
		fhir = await fhirForTest();
		process.env.EPJ_HAPI_BASE_URL = fhir.url;
	});

	afterAll(async () => {
		await fhir.close();
		await db.riv();
	});

	beforeEach(async () => {
		await emptyTables();
		fhir.nullstill();
		await setIn('INSERT INTO user_account (id, username, name) VALUES ($1,$2,$3)', ['bruker-1', 'lege', 'Dr. Ingrid Fastlege']);

		const p = await fhirClient.create({
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: '13086510035' }],
			name: [{ use: 'official', family: 'Bakken', given: ['Anne'] }],
			birthDate: '1965-08-13',
			address: [{ line: ['Storgata 12'], postalCode: '0155', city: 'Oslo' }]
		});
		patient = p.resource.id as string;

		const annen = await fhirClient.create({
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: '24035810281' }],
			name: [{ family: 'Vik', given: ['Ola'] }]
		});
		annenPatient = annen.resource.id as string;

		const subject = { reference: `Patient/${patient}` };
		await fhirClient.create({
			resourceType: 'Condition',
			clinicalStatus: { coding: [{ code: 'active' }] },
			code: { coding: [{ system: SYSTEM.ICPC2, code: 'K86' }], text: 'Hypertensjon ukomplisert' },
			recordedDate: '2020-03-01',
			subject
		});
		await fhirClient.create({
			resourceType: 'Condition',
			clinicalStatus: { coding: [{ code: 'active' }] },
			code: { coding: [{ system: SYSTEM.ICPC2, code: 'T90' }], text: 'Diabetes type 2' },
			recordedDate: '2024-06-15',
			subject
		});
		await fhirClient.create({
			resourceType: 'AllergyIntolerance',
			clinicalStatus: { coding: [{ code: 'active' }] },
			code: { text: 'Penicillin' },
			criticality: 'high',
			recordedDate: '2019-01-10',
			patient: subject
		});
		await fhirClient.create({
			resourceType: 'MedicationRequest',
			status: 'active',
			medication: { concept: { coding: [{ system: SYSTEM.ATC, code: 'C09AA05' }], text: 'Ramipril 5 mg' } },
			dosageInstruction: [{ text: '1 tablett morgen' }],
			authoredOn: '2024-06-15',
			subject
		});
		await fhirClient.create({
			resourceType: 'Observation',
			status: 'final',
			code: { coding: [{ system: SYSTEM.LOINC, code: '8480-6' }], text: 'Systolisk blodtrykk' },
			effectiveDateTime: '2025-02-01T09:30:00Z',
			valueQuantity: { value: 148, unit: 'mm[Hg]' },
			subject
		});
		await fhirClient.create({
			resourceType: 'Composition',
			status: 'final',
			type: { text: 'Konsultasjonsnotat' },
			title: 'Kontroll hypertensjon',
			date: '2025-02-01T09:45:00Z',
			author: [{ reference: 'Practitioner/42', display: 'Dr. Ingrid Fastlege' }],
			subject,
			section: [{ text: { status: 'generated', div: '<div>Blodtrykk noe høyt. Fortsetter Ramipril.</div>' } }]
		});

		// This must never end up in the extract for our patient.
		await fhirClient.create({
			resourceType: 'Condition',
			clinicalStatus: { coding: [{ code: 'active' }] },
			code: { text: 'Astma hos en annen pasient' },
			subject: { reference: `Patient/${annenPatient}` }
		});
	});

	const givesRelationship = (patientId: string) =>
		setIn('INSERT INTO care_relationship (id, user_id, patient_id, basis) VALUES ($1,$2,$3,$4)', [
			newId(), 'bruker-1', patientId, 'fastlege'
		]);

	const extractFor = async (over: Parameters<typeof buildRecordExtract>[2] = { reason: 'pasient-innsyn' }) => {
		await givesRelationship(patient);
		return buildRecordExtract(context(), patient, over);
	};

	describe('tilgang', () => {
		it('nekter utlevering uten behandlingsrelasjon', async () => {
			await expect(buildRecordExtract(context(), patient, { reason: 'pasient-innsyn' })).rejects.toThrow();
		});

		it('tar ikke med andre pasienters opplysninger', async () => {
			const u = await extractFor();
			const tekster = (u.document.entry ?? [])
				.map((e) => JSON.stringify(e.resource))
				.join(' ');
			expect(tekster).not.toContain('Astma hos en annen pasient');
			expect(tekster).not.toContain(annenPatient);
		});
	});

	describe('FHIR-dokumentet', () => {
		it('er en Bundle av typen document med Composition først', async () => {
			const u = await extractFor();
			expect(u.document.resourceType).toBe('Bundle');
			expect(u.document.type).toBe('document');
			const first = (u.document.entry ?? [])[0]?.resource as FhirResource;
			expect(first.resourceType).toBe('Composition');
			expect(first.status).toBe('final');
			expect((first.subject as { reference: string }).reference).toBe(`Patient/${patient}`);
		});

		it('navngir virksomheten som journalansvarlig', async () => {
			const u = await extractFor();
			const composition = (u.document.entry ?? [])[0]?.resource as FhirResource;
			const custodian = composition.custodian as { display: string; identifier: { system: string; value: string } };
			expect(custodian.display).toBe('Standardvirksomhet');
			expect(custodian.identifier.system).toBe(SYSTEM.ORGNR);
		});

		it('deler innholdet i seksjoner med LOINC-koder', async () => {
			const u = await extractFor();
			const composition = (u.document.entry ?? [])[0]?.resource as FhirResource;
			const seksjoner = (composition.section as { title: string; code?: { coding: { code: string }[] } }[]) ?? [];
			const titler = seksjoner.map((s) => s.title);
			expect(titler).toContain('Diagnoser og helseproblemer');
			expect(titler).toContain('Legemidler');
			expect(titler).toContain('Allergier og overfølsomhet');
			expect(titler).toContain('Journalnotater');
			// Problemlisten skal ha den etablerte LOINC-koden.
			const problem = seksjoner.find((s) => s.title === 'Diagnoser og helseproblemer');
			expect(problem?.code?.coding[0].code).toBe('11450-4');
		});

		it('lar hver seksjonsreferanse peke på en ressurs som er med i dokumentet', async () => {
			const u = await extractFor();
			const composition = (u.document.entry ?? [])[0]?.resource as FhirResource;
			const iDocument = new Set(
				(u.document.entry ?? [])
					.map((e) => e.resource as FhirResource)
					.map((r) => `${r.resourceType}/${r.id}`)
			);
			const references = ((composition.section as { entry?: { reference: string }[] }[]) ?? []).flatMap(
				(s) => s.entry ?? []
			);
			expect(references.length).toBeGreaterThan(0);
			for (const r of references) expect(iDocument.has(r.reference)).toBe(true);
		});

		it('utelater sikkerhetsloggen og samtykker', async () => {
			const u = await extractFor();
			const types = (u.document.entry ?? []).map((e) => (e.resource as FhirResource).resourceType);
			expect(types).not.toContain('AuditEvent');
			expect(types).not.toContain('Consent');
		});

		it('lar ingenting falle ut: alt som hentes havner i en seksjon eller under øvrige', async () => {
			await fhirClient.create({
				resourceType: 'Coverage',
				status: 'active',
				beneficiary: { reference: `Patient/${patient}` }
			});
			const u = await extractFor();
			const composition = (u.document.entry ?? [])[0]?.resource as FhirResource;
			const referert = new Set(
				((composition.section as { entry?: { reference: string }[] }[]) ?? [])
					.flatMap((s) => s.entry ?? [])
					.map((e) => e.reference)
			);
			const clinical = (u.document.entry ?? [])
				.map((e) => e.resource as FhirResource)
				.filter((r) => r.resourceType !== 'Composition' || r.id !== u.disclosureId)
				.filter((r) => r.resourceType !== 'Patient');
			for (const r of clinical) expect(referert.has(`${r.resourceType}/${r.id}`)).toBe(true);
		});
	});

	describe('avgrensning i tid', () => {
		it('tar bare med opplysninger i perioden', async () => {
			const u = await extractFor({ reason: 'overforing-behandler', fromDate: '2024-01-01' });
			const diagnoses = (u.document.entry ?? [])
				.map((e) => e.resource as FhirResource)
				.filter((r) => r.resourceType === 'Condition');
			expect(diagnoses).toHaveLength(1);
			expect(JSON.stringify(diagnoses[0])).toContain('Diabetes');
		});

		it('tar med hele journalen når perioden ikke er satt', async () => {
			const u = await extractFor();
			const diagnoses = (u.document.entry ?? [])
				.map((e) => e.resource as FhirResource)
				.filter((r) => r.resourceType === 'Condition');
			expect(diagnoses).toHaveLength(2);
		});
	});

	describe('sikkerhetsloggen', () => {
		it('registrerer utleveringen med hjemmel som purposeOfUse', async () => {
			const u = await extractFor({ reason: 'pasient-innsyn', recipient: 'Pasienten selv' });
			const rows = await query<{ type_code: string; subtype: string; purpose_of_use: string; patient_id: string; entity_ref: string }>(
				"SELECT type_code, subtype, purpose_of_use, patient_id, entity_ref FROM audit_event WHERE type_code = 'utlevering'"
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				subtype: 'journal:pasient-innsyn',
				purpose_of_use: 'PATRQT',
				patient_id: patient,
				entity_ref: `Bundle/${u.disclosureId}`
			});
		});

		it('bruker riktig purposeOfUse for hver hjemmel', async () => {
			const codes = Object.fromEntries(UTLEVERINGSGRUNNER.map((g) => [g.code, g.purposeOfUse]));
			expect(codes).toMatchObject({
				'pasient-innsyn': 'PATRQT',
				'overforing-behandler': 'TREAT',
				rettslig: 'HLEGAL'
			});
		});

		it('teller innholdet i utleveringen, slik at kvitteringen kan etterprøves', async () => {
			const u = await extractFor();
			const iDocument = (u.document.entry ?? [])
				.map((e) => e.resource as FhirResource)
				.filter((r) => !(r.resourceType === 'Composition' && r.id === u.disclosureId))
				.filter((r) => r.resourceType !== 'Patient');
			expect(u.countResources).toBe(iDocument.length);
			const sum = u.content.reduce((n, i) => n + i.count, 0);
			expect(sum).toBe(u.countResources);
		});
	});

	describe('lesbar utgave', () => {
		it('viser pasientens identitet, hjemmel og referanse', async () => {
			const u = await extractFor({ reason: 'pasient-innsyn', recipient: 'Pasienten selv' });
			const html = toHtml(u);
			expect(html).toContain('Anne Bakken');
			expect(html).toContain('13086510035');
			expect(html).toContain('Innsyn etter pasient- og brukerrettighetsloven § 5-1');
			expect(html).toContain(u.disclosureId);
			expect(html).toContain('Pasienten selv');
		});

		it('inneholder det samme kliniske innholdet som dokumentet', async () => {
			const u = await extractFor();
			const html = toHtml(u);
			expect(html).toContain('Hypertensjon ukomplisert');
			expect(html).toContain('Diabetes type 2');
			expect(html).toContain('Penicillin');
			expect(html).toContain('Ramipril 5 mg');
			expect(html).toContain('1 tablett morgen');
			expect(html).toContain('Systolisk blodtrykk');
			expect(html).toContain('Kontroll hypertensjon');
		});

		it('sier fra om at sperret materiale kan mangle', async () => {
			const html = toHtml(await extractFor());
			expect(html).toMatch(/sperret/i);
		});

		it('er selvstendig: ingen skript og ingen eksterne ressurser', async () => {
			const html = toHtml(await extractFor());
			expect(html).not.toMatch(/<script/i);
			expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
			expect(html).not.toMatch(/<link\b/i);
		});

		it('rømmer innhold, slik at journaltekst ikke kan bli til markup', async () => {
			await fhirClient.create({
				resourceType: 'Condition',
				clinicalStatus: { coding: [{ code: 'active' }] },
				code: { text: '<img src=x onerror="alert(1)">' },
				subject: { reference: `Patient/${patient}` }
			});
			const html = toHtml(await extractFor());
			expect(html).not.toContain('<img src=x');
			expect(html).toContain('&lt;img src=x');
		});

		it('gir en tekstutgave med det samme innholdet', async () => {
			const u = await extractFor();
			const text = toText(u);
			expect(text).toContain('UTSKRIFT AV PASIENTJOURNAL');
			expect(text).toContain('Anne Bakken');
			expect(text).toContain('Hypertensjon ukomplisert');
			expect(text).toContain('Ramipril 5 mg');
			expect(text).toContain(u.disclosureId);
		});
	});

	describe('filnavn', () => {
		it('folder norske bokstaver og tåler navn uten latinske tegn', async () => {
			const u = await extractFor();
			expect(filnavn(u, 'json')).toMatch(/^journal-anne-bakken-\d{4}-\d{2}-\d{2}\.json$/);

			const kunstig = { ...u, patient: { ...u.patient, name: 'Øyvind Ærlig Åsen' } };
			expect(filnavn(kunstig, 'html')).toContain('oyvind-aerlig-asen');

			const without = { ...u, patient: { ...u.patient, name: '中文' } };
			expect(filnavn(without, 'txt')).toMatch(/^journal-pasient-/);
		});
	});
});
