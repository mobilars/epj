import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/lib/server/db/index';
import { harTestdatabase, opprettTestdatabase, settInn, tomTabeller, type Testdatabase } from './fixtures/db';
import { fhirForTest, type TestFhirServer } from './fixtures/fhir-testserver';
import { kontekst } from './fixtures/kontekst';
import { byggJournaluttrekk, filnavn, tilHtml, tilTekst, UTLEVERINGSGRUNNER } from '../src/lib/server/journal/utlevering';
import { fhirKlient } from '../src/lib/server/fhir/client';
import { SYSTEM } from '../src/lib/server/fhir/kodeverk';
import { nyId } from '../src/lib/server/util/ids';
import type { FhirResource } from '../src/lib/server/fhir/types';

const beskriv = harTestdatabase() ? describe : describe.skip;

/**
 * Utlevering av journal.
 *
 * Testene kontrollerer det som faktisk betyr noe juridisk: at uttrekket går
 * gjennom tilgangskontrollen, at det som utleveres er det som står i
 * kvitteringen, at hjemmelen havner i sikkerhetsloggen, og at den lesbare og
 * den maskinlesbare utgaven sier det samme.
 */
beskriv('utlevering av journal', () => {
	let db: Testdatabase;
	let fhir: TestFhirServer;
	let pasient = '';
	let annenPasient = '';

	beforeAll(async () => {
		db = await opprettTestdatabase('utlev');
		fhir = await fhirForTest();
		process.env.EPJ_HAPI_BASE_URL = fhir.url;
	});

	afterAll(async () => {
		await fhir.lukk();
		await db.riv();
	});

	beforeEach(async () => {
		await tomTabeller();
		fhir.nullstill();
		await settInn('INSERT INTO user_account (id, brukernavn, navn) VALUES ($1,$2,$3)', ['bruker-1', 'lege', 'Dr. Ingrid Fastlege']);

		const p = await fhirKlient.opprett({
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: '13086510035' }],
			name: [{ use: 'official', family: 'Bakken', given: ['Anne'] }],
			birthDate: '1965-08-13',
			address: [{ line: ['Storgata 12'], postalCode: '0155', city: 'Oslo' }]
		});
		pasient = p.ressurs.id as string;

		const annen = await fhirKlient.opprett({
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: '24035810281' }],
			name: [{ family: 'Vik', given: ['Ola'] }]
		});
		annenPasient = annen.ressurs.id as string;

		const subject = { reference: `Patient/${pasient}` };
		await fhirKlient.opprett({
			resourceType: 'Condition',
			clinicalStatus: { coding: [{ code: 'active' }] },
			code: { coding: [{ system: SYSTEM.ICPC2, code: 'K86' }], text: 'Hypertensjon ukomplisert' },
			recordedDate: '2020-03-01',
			subject
		});
		await fhirKlient.opprett({
			resourceType: 'Condition',
			clinicalStatus: { coding: [{ code: 'active' }] },
			code: { coding: [{ system: SYSTEM.ICPC2, code: 'T90' }], text: 'Diabetes type 2' },
			recordedDate: '2024-06-15',
			subject
		});
		await fhirKlient.opprett({
			resourceType: 'AllergyIntolerance',
			clinicalStatus: { coding: [{ code: 'active' }] },
			code: { text: 'Penicillin' },
			criticality: 'high',
			recordedDate: '2019-01-10',
			patient: subject
		});
		await fhirKlient.opprett({
			resourceType: 'MedicationRequest',
			status: 'active',
			medication: { concept: { coding: [{ system: SYSTEM.ATC, code: 'C09AA05' }], text: 'Ramipril 5 mg' } },
			dosageInstruction: [{ text: '1 tablett morgen' }],
			authoredOn: '2024-06-15',
			subject
		});
		await fhirKlient.opprett({
			resourceType: 'Observation',
			status: 'final',
			code: { coding: [{ system: SYSTEM.LOINC, code: '8480-6' }], text: 'Systolisk blodtrykk' },
			effectiveDateTime: '2025-02-01T09:30:00Z',
			valueQuantity: { value: 148, unit: 'mm[Hg]' },
			subject
		});
		await fhirKlient.opprett({
			resourceType: 'Composition',
			status: 'final',
			type: { text: 'Konsultasjonsnotat' },
			title: 'Kontroll hypertensjon',
			date: '2025-02-01T09:45:00Z',
			author: [{ reference: 'Practitioner/42', display: 'Dr. Ingrid Fastlege' }],
			subject,
			section: [{ text: { status: 'generated', div: '<div>Blodtrykk noe høyt. Fortsetter Ramipril.</div>' } }]
		});

		// Denne skal aldri komme med i uttrekket for vår pasient.
		await fhirKlient.opprett({
			resourceType: 'Condition',
			clinicalStatus: { coding: [{ code: 'active' }] },
			code: { text: 'Astma hos en annen pasient' },
			subject: { reference: `Patient/${annenPasient}` }
		});
	});

	const girRelasjon = (patientId: string) =>
		settInn('INSERT INTO care_relationship (id, user_id, patient_id, grunnlag) VALUES ($1,$2,$3,$4)', [
			nyId(), 'bruker-1', patientId, 'fastlege'
		]);

	const uttrekkFor = async (over: Parameters<typeof byggJournaluttrekk>[2] = { grunn: 'pasient-innsyn' }) => {
		await girRelasjon(pasient);
		return byggJournaluttrekk(kontekst(), pasient, over);
	};

	describe('tilgang', () => {
		it('nekter utlevering uten behandlingsrelasjon', async () => {
			await expect(byggJournaluttrekk(kontekst(), pasient, { grunn: 'pasient-innsyn' })).rejects.toThrow();
		});

		it('tar ikke med andre pasienters opplysninger', async () => {
			const u = await uttrekkFor();
			const tekster = (u.dokument.entry ?? [])
				.map((e) => JSON.stringify(e.resource))
				.join(' ');
			expect(tekster).not.toContain('Astma hos en annen pasient');
			expect(tekster).not.toContain(annenPasient);
		});
	});

	describe('FHIR-dokumentet', () => {
		it('er en Bundle av typen document med Composition først', async () => {
			const u = await uttrekkFor();
			expect(u.dokument.resourceType).toBe('Bundle');
			expect(u.dokument.type).toBe('document');
			const forste = (u.dokument.entry ?? [])[0]?.resource as FhirResource;
			expect(forste.resourceType).toBe('Composition');
			expect(forste.status).toBe('final');
			expect((forste.subject as { reference: string }).reference).toBe(`Patient/${pasient}`);
		});

		it('navngir virksomheten som journalansvarlig', async () => {
			const u = await uttrekkFor();
			const composition = (u.dokument.entry ?? [])[0]?.resource as FhirResource;
			const custodian = composition.custodian as { display: string; identifier: { system: string; value: string } };
			expect(custodian.display).toBe('Standardvirksomhet');
			expect(custodian.identifier.system).toBe(SYSTEM.ORGNR);
		});

		it('deler innholdet i seksjoner med LOINC-koder', async () => {
			const u = await uttrekkFor();
			const composition = (u.dokument.entry ?? [])[0]?.resource as FhirResource;
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
			const u = await uttrekkFor();
			const composition = (u.dokument.entry ?? [])[0]?.resource as FhirResource;
			const iDokument = new Set(
				(u.dokument.entry ?? [])
					.map((e) => e.resource as FhirResource)
					.map((r) => `${r.resourceType}/${r.id}`)
			);
			const referanser = ((composition.section as { entry?: { reference: string }[] }[]) ?? []).flatMap(
				(s) => s.entry ?? []
			);
			expect(referanser.length).toBeGreaterThan(0);
			for (const r of referanser) expect(iDokument.has(r.reference)).toBe(true);
		});

		it('utelater sikkerhetsloggen og samtykker', async () => {
			const u = await uttrekkFor();
			const typer = (u.dokument.entry ?? []).map((e) => (e.resource as FhirResource).resourceType);
			expect(typer).not.toContain('AuditEvent');
			expect(typer).not.toContain('Consent');
		});

		it('lar ingenting falle ut: alt som hentes havner i en seksjon eller under øvrige', async () => {
			await fhirKlient.opprett({
				resourceType: 'Coverage',
				status: 'active',
				beneficiary: { reference: `Patient/${pasient}` }
			});
			const u = await uttrekkFor();
			const composition = (u.dokument.entry ?? [])[0]?.resource as FhirResource;
			const referert = new Set(
				((composition.section as { entry?: { reference: string }[] }[]) ?? [])
					.flatMap((s) => s.entry ?? [])
					.map((e) => e.reference)
			);
			const kliniske = (u.dokument.entry ?? [])
				.map((e) => e.resource as FhirResource)
				.filter((r) => r.resourceType !== 'Composition' || r.id !== u.utleveringsId)
				.filter((r) => r.resourceType !== 'Patient');
			for (const r of kliniske) expect(referert.has(`${r.resourceType}/${r.id}`)).toBe(true);
		});
	});

	describe('avgrensning i tid', () => {
		it('tar bare med opplysninger i perioden', async () => {
			const u = await uttrekkFor({ grunn: 'overforing-behandler', fraDato: '2024-01-01' });
			const diagnoser = (u.dokument.entry ?? [])
				.map((e) => e.resource as FhirResource)
				.filter((r) => r.resourceType === 'Condition');
			expect(diagnoser).toHaveLength(1);
			expect(JSON.stringify(diagnoser[0])).toContain('Diabetes');
		});

		it('tar med hele journalen når perioden ikke er satt', async () => {
			const u = await uttrekkFor();
			const diagnoser = (u.dokument.entry ?? [])
				.map((e) => e.resource as FhirResource)
				.filter((r) => r.resourceType === 'Condition');
			expect(diagnoser).toHaveLength(2);
		});
	});

	describe('sikkerhetsloggen', () => {
		it('registrerer utleveringen med hjemmel som purposeOfUse', async () => {
			const u = await uttrekkFor({ grunn: 'pasient-innsyn', mottaker: 'Pasienten selv' });
			const rader = await query<{ type_code: string; subtype: string; purpose_of_use: string; patient_id: string; entity_ref: string }>(
				"SELECT type_code, subtype, purpose_of_use, patient_id, entity_ref FROM audit_event WHERE type_code = 'utlevering'"
			);
			expect(rader).toHaveLength(1);
			expect(rader[0]).toMatchObject({
				subtype: 'journal:pasient-innsyn',
				purpose_of_use: 'PATRQT',
				patient_id: pasient,
				entity_ref: `Bundle/${u.utleveringsId}`
			});
		});

		it('bruker riktig purposeOfUse for hver hjemmel', async () => {
			const koder = Object.fromEntries(UTLEVERINGSGRUNNER.map((g) => [g.kode, g.purposeOfUse]));
			expect(koder).toMatchObject({
				'pasient-innsyn': 'PATRQT',
				'overforing-behandler': 'TREAT',
				rettslig: 'HLEGAL'
			});
		});

		it('teller innholdet i utleveringen, slik at kvitteringen kan etterprøves', async () => {
			const u = await uttrekkFor();
			const iDokument = (u.dokument.entry ?? [])
				.map((e) => e.resource as FhirResource)
				.filter((r) => !(r.resourceType === 'Composition' && r.id === u.utleveringsId))
				.filter((r) => r.resourceType !== 'Patient');
			expect(u.antallRessurser).toBe(iDokument.length);
			const sum = u.innhold.reduce((n, i) => n + i.antall, 0);
			expect(sum).toBe(u.antallRessurser);
		});
	});

	describe('lesbar utgave', () => {
		it('viser pasientens identitet, hjemmel og referanse', async () => {
			const u = await uttrekkFor({ grunn: 'pasient-innsyn', mottaker: 'Pasienten selv' });
			const html = tilHtml(u);
			expect(html).toContain('Anne Bakken');
			expect(html).toContain('13086510035');
			expect(html).toContain('Innsyn etter pasient- og brukerrettighetsloven § 5-1');
			expect(html).toContain(u.utleveringsId);
			expect(html).toContain('Pasienten selv');
		});

		it('inneholder det samme kliniske innholdet som dokumentet', async () => {
			const u = await uttrekkFor();
			const html = tilHtml(u);
			expect(html).toContain('Hypertensjon ukomplisert');
			expect(html).toContain('Diabetes type 2');
			expect(html).toContain('Penicillin');
			expect(html).toContain('Ramipril 5 mg');
			expect(html).toContain('1 tablett morgen');
			expect(html).toContain('Systolisk blodtrykk');
			expect(html).toContain('Kontroll hypertensjon');
		});

		it('sier fra om at sperret materiale kan mangle', async () => {
			const html = tilHtml(await uttrekkFor());
			expect(html).toMatch(/sperret/i);
		});

		it('er selvstendig: ingen skript og ingen eksterne ressurser', async () => {
			const html = tilHtml(await uttrekkFor());
			expect(html).not.toMatch(/<script/i);
			expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
			expect(html).not.toMatch(/<link\b/i);
		});

		it('rømmer innhold, slik at journaltekst ikke kan bli til markup', async () => {
			await fhirKlient.opprett({
				resourceType: 'Condition',
				clinicalStatus: { coding: [{ code: 'active' }] },
				code: { text: '<img src=x onerror="alert(1)">' },
				subject: { reference: `Patient/${pasient}` }
			});
			const html = tilHtml(await uttrekkFor());
			expect(html).not.toContain('<img src=x');
			expect(html).toContain('&lt;img src=x');
		});

		it('gir en tekstutgave med det samme innholdet', async () => {
			const u = await uttrekkFor();
			const tekst = tilTekst(u);
			expect(tekst).toContain('UTSKRIFT AV PASIENTJOURNAL');
			expect(tekst).toContain('Anne Bakken');
			expect(tekst).toContain('Hypertensjon ukomplisert');
			expect(tekst).toContain('Ramipril 5 mg');
			expect(tekst).toContain(u.utleveringsId);
		});
	});

	describe('filnavn', () => {
		it('folder norske bokstaver og tåler navn uten latinske tegn', async () => {
			const u = await uttrekkFor();
			expect(filnavn(u, 'json')).toMatch(/^journal-anne-bakken-\d{4}-\d{2}-\d{2}\.json$/);

			const kunstig = { ...u, pasient: { ...u.pasient, navn: 'Øyvind Ærlig Åsen' } };
			expect(filnavn(kunstig, 'html')).toContain('oyvind-aerlig-asen');

			const uten = { ...u, pasient: { ...u.pasient, navn: '中文' } };
			expect(filnavn(uten, 'txt')).toMatch(/^journal-pasient-/);
		});
	});
});
