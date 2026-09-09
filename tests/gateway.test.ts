import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec, query } from '../src/lib/server/db/index';
import { harTestdatabase, opprettTestdatabase, tomTabeller, type Testdatabase } from './fixtures/db';
import { fhirForTest, type TestFhirServer } from './fixtures/fhir-testserver';
import { appKontekst, kontekst } from './fixtures/kontekst';
import { utfor } from '../src/lib/server/fhir/gateway';
import { FhirError } from '../src/lib/server/fhir/outcome';
import { fhirKlient } from '../src/lib/server/fhir/client';
import { nyId } from '../src/lib/server/util/ids';
import { SYSTEM } from '../src/lib/server/fhir/kodeverk';
import type { Bundle } from '../src/lib/server/fhir/types';

const beskriv = harTestdatabase() ? describe : describe.skip;

/**
 * Integrasjonstest av vokteren foran FHIR-serveren.
 *
 * Kjører mot ekte PostgreSQL og over ekte HTTP mot en FHIR-server, slik at
 * hele kjeden testes: tilgangsbeslutning, videresending, etterfiltrering av
 * sperrede pasienter og skriving til sikkerhetsloggen.
 */
beskriv('FHIR-vokteren', () => {
	let db: Testdatabase;
	let fhir: TestFhirServer;
	let pasient1 = '';
	let pasient2 = '';

	beforeAll(async () => {
		db = await opprettTestdatabase('gateway');
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
		await exec('INSERT INTO user_account (id, brukernavn, navn) VALUES ($1,$2,$3)', ['bruker-1', 'lege', 'Dr. Ingrid Fastlege']);
		await exec('INSERT INTO user_account (id, brukernavn, navn) VALUES ($1,$2,$3)', ['bruker-2', 'sykepleier', 'Kari Sykepleier']);

		const p1 = await fhirKlient.opprett({
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: '13086510035' }],
			name: [{ family: 'Bakken', given: ['Anne'] }]
		});
		const p2 = await fhirKlient.opprett({
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: '24035810281' }],
			name: [{ family: 'Vik', given: ['Ola'] }]
		});
		pasient1 = p1.ressurs.id as string;
		pasient2 = p2.ressurs.id as string;

		for (const p of [pasient1, pasient2]) {
			await fhirKlient.opprett({
				resourceType: 'Observation',
				status: 'final',
				category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
				code: { coding: [{ system: SYSTEM.LOINC, code: '8480-6' }], text: 'Systolisk blodtrykk' },
				subject: { reference: `Patient/${p}` },
				valueQuantity: { value: 140, unit: 'mm[Hg]' }
			});
			await fhirKlient.opprett({
				resourceType: 'Condition',
				clinicalStatus: { coding: [{ code: 'active' }] },
				code: { text: 'Hypertensjon' },
				subject: { reference: `Patient/${p}` }
			});
		}
	});

	const girRelasjon = (userId: string, patientId: string) =>
		exec('INSERT INTO care_relationship (id, user_id, patient_id, grunnlag) VALUES ($1,$2,$3,$4)', [nyId(), userId, patientId, 'fastlege']);

	const antallLogg = async (): Promise<number> =>
		Number((await query<{ n: string }>('SELECT count(*)::int AS n FROM audit_event'))[0].n);

	describe('lesing', () => {
		it('leser en ressurs brukeren har tilgang til, og logger det', async () => {
			await girRelasjon('bruker-1', pasient1);
			const svar = await utfor({ ctx: kontekst(), metode: 'GET', sti: `Patient/${pasient1}`, sok: new URLSearchParams() });
			expect(svar.status).toBe(200);
			expect(svar.ressurs.resourceType).toBe('Patient');
			expect(svar.headers.etag).toMatch(/^W\//);

			const logg = await query<{ subtype: string; outcome: string; patient_id: string }>('SELECT subtype, outcome, patient_id FROM audit_event');
			expect(logg).toHaveLength(1);
			expect(logg[0]).toMatchObject({ subtype: 'read', outcome: '0', patient_id: pasient1 });
		});

		it('nekter lesing uten behandlingsrelasjon, og logger avvisningen', async () => {
			await expect(
				utfor({ ctx: kontekst(), metode: 'GET', sti: `Patient/${pasient1}`, sok: new URLSearchParams() })
			).rejects.toThrow(FhirError);

			const logg = await query<{ outcome: string; outcome_desc: string }>('SELECT outcome, outcome_desc FROM audit_event');
			expect(logg).toHaveLength(1);
			expect(logg[0].outcome).toBe('4');
			expect(logg[0].outcome_desc).toMatch(/behandlingsrelasjon/);
		});

		it('nekter en app som mangler scope for ressurstypen', async () => {
			await girRelasjon('bruker-1', pasient1);
			const app = appKontekst('patient/Observation.rs', pasient1);
			await expect(
				utfor({ ctx: app, metode: 'GET', sti: `Condition/finnes-ikke`, sok: new URLSearchParams() })
			).rejects.toThrow();
		});
	});

	describe('søk', () => {
		it('avgrenser til pasienter brukeren har relasjon til', async () => {
			await girRelasjon('bruker-1', pasient1);
			const svar = await utfor({ ctx: kontekst(), metode: 'POST', sti: 'Observation/_search', sok: new URLSearchParams(), kropp: new URLSearchParams() });
			const bundle = svar.ressurs as Bundle;
			expect(bundle.entry).toHaveLength(1);
			const subject = (bundle.entry?.[0].resource?.subject as { reference: string }).reference;
			expect(subject).toBe(`Patient/${pasient1}`);
		});

		it('gir tomt resultat når brukeren ikke har noen pasienter', async () => {
			const svar = await utfor({ ctx: kontekst(), metode: 'POST', sti: 'Observation/_search', sok: new URLSearchParams(), kropp: new URLSearchParams() });
			expect((svar.ressurs as Bundle).entry).toHaveLength(0);
			// Ingen kall skal ha gått videre til FHIR-serveren.
			if (!fhir.erEkte) {
				expect(fhir.kall.filter((k) => k.sti.startsWith('Observation/_search'))).toHaveLength(0);
			}
		});

		it('filtrerer bort sperrede pasienter etter at serveren har svart', async () => {
			await girRelasjon('bruker-1', pasient1);
			await girRelasjon('bruker-1', pasient2);
			await exec("INSERT INTO journal_sperring (id, patient_id, omfang, registrert_av) VALUES ($1,$2,'alle','bruker-1')", [nyId(), pasient2]);

			const svar = await utfor({ ctx: kontekst(), metode: 'POST', sti: 'Observation/_search', sok: new URLSearchParams(), kropp: new URLSearchParams() });
			const bundle = svar.ressurs as Bundle;
			expect(bundle.entry).toHaveLength(1);
			expect((bundle.entry?.[0].resource?.subject as { reference: string }).reference).toBe(`Patient/${pasient1}`);

			const logg = await query<{ content: { entity: { detail: { type: { text: string }; valueString: string }[] }[] } }>(
				"SELECT content FROM audit_event WHERE subtype = 'search-type'"
			);
			const detaljer = logg[0].content.entity[0].detail;
			expect(detaljer.find((d) => d.type.text === 'filtrertBortSperret')?.valueString).toBe('1');
		});

		it('tvinger inn scope-begrensninger i spørringen', async () => {
			await girRelasjon('bruker-1', pasient1);
			const app = appKontekst('patient/Observation.rs?category=vital-signs', pasient1);
			await utfor({ ctx: app, metode: 'POST', sti: 'Observation/_search', sok: new URLSearchParams(), kropp: new URLSearchParams() });
			// Begrensningen skal ha nådd fram til serveren.
			if (!fhir.erEkte) {
				expect(fhir.kall.some((k) => k.sti === 'Observation/_search')).toBe(true);
			}
		});

		it('maskerer identifikatorer i loggen', async () => {
			await girRelasjon('bruker-1', pasient1);
			await utfor({
				ctx: kontekst(), metode: 'POST', sti: 'Patient/_search',
				sok: new URLSearchParams(), kropp: new URLSearchParams({ identifier: `${SYSTEM.FNR}|13086510035` })
			});
			const logg = await query<{ content: { entity: { detail: { type: { text: string }; valueString: string }[] }[] } }>(
				"SELECT content FROM audit_event WHERE subtype = 'search-type'"
			);
			const sporring = logg[0].content.entity[0].detail.find((d) => d.type.text === 'spørring')?.valueString ?? '';
			expect(sporring).not.toContain('13086510035');
			expect(sporring).toContain('maskert');
		});
	});

	describe('skriving', () => {
		it('oppretter en ressurs og merker forfatteren', async () => {
			await girRelasjon('bruker-1', pasient1);
			const svar = await utfor({
				ctx: kontekst(), metode: 'POST', sti: 'Condition', sok: new URLSearchParams(),
				kropp: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Astma' }, subject: { reference: `Patient/${pasient1}` } }
			});
			expect(svar.status).toBe(201);
			expect(svar.headers.location).toContain('/Condition/');
			const tagger = (svar.ressurs.meta as { tag?: { system: string; code: string }[] }).tag ?? [];
			expect(tagger.some((t) => t.system === 'urn:epj:forfatter' && t.code === 'Practitioner/42')).toBe(true);
		});

		it('avviser ressurs som ikke validerer, uten å kontakte serveren', async () => {
			await girRelasjon('bruker-1', pasient1);
			const forFor = fhir.kall.length;
			await expect(
				utfor({ ctx: kontekst(), metode: 'POST', sti: 'Observation', sok: new URLSearchParams(), kropp: { resourceType: 'Observation' } })
			).rejects.toMatchObject({ status: 422 });
			if (!fhir.erEkte) expect(fhir.kall.length).toBe(forFor);
		});

		it('hindrer at en ressurs flyttes over på en pasient brukeren har tilgang til', async () => {
			await girRelasjon('bruker-1', pasient1);
			const fremmed = await fhirKlient.opprett({
				resourceType: 'Condition',
				clinicalStatus: { coding: [{ code: 'active' }] },
				code: { text: 'Skjult' },
				subject: { reference: `Patient/${pasient2}` }
			});
			// Ny versjon peker på «min» pasient, men den eksisterende gjør ikke det.
			await expect(
				utfor({
					ctx: kontekst(), metode: 'PUT', sti: `Condition/${fremmed.ressurs.id}`, sok: new URLSearchParams(),
					kropp: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Flyttet' }, subject: { reference: `Patient/${pasient1}` } }
				})
			).rejects.toMatchObject({ status: 403 });
		});

		it('nekter sletting for rolle uten skriverettighet', async () => {
			await girRelasjon('bruker-2', pasient1);
			const sekretaer = kontekst({ userId: 'bruker-2', roller: ['helsesekretaer'] });
			await expect(
				utfor({ ctx: sekretaer, metode: 'DELETE', sti: `Condition/finnes-ikke`, sok: new URLSearchParams() })
			).rejects.toThrow();
		});
	});

	describe('transaksjoner', () => {
		it('vurderer hver oppføring for seg', async () => {
			await girRelasjon('bruker-1', pasient1);
			const bundle = {
				resourceType: 'Bundle',
				type: 'transaction',
				entry: [
					{ request: { method: 'POST', url: 'Condition' }, resource: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Ok' }, subject: { reference: `Patient/${pasient1}` } } },
					{ request: { method: 'POST', url: 'Condition' }, resource: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Ikke lov' }, subject: { reference: `Patient/${pasient2}` } } }
				]
			};
			await expect(
				utfor({ ctx: kontekst(), metode: 'POST', sti: '', sok: new URLSearchParams(), kropp: bundle })
			).rejects.toMatchObject({ status: 403 });

			// Hele transaksjonen skal være stoppet før den nådde serveren.
			if (!fhir.erEkte) {
				expect(fhir.kall.some((k) => k.metode === 'POST' && k.sti === '')).toBe(false);
			}
		});

		it('kjører en transaksjon der alt er tillatt', async () => {
			await girRelasjon('bruker-1', pasient1);
			const svar = await utfor({
				ctx: kontekst(), metode: 'POST', sti: '', sok: new URLSearchParams(),
				kropp: {
					resourceType: 'Bundle',
					type: 'transaction',
					entry: [
						{ request: { method: 'POST', url: 'Condition' }, resource: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'A' }, subject: { reference: `Patient/${pasient1}` } } },
						{ request: { method: 'POST', url: 'Condition' }, resource: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'B' }, subject: { reference: `Patient/${pasient1}` } } }
					]
				}
			});
			expect((svar.ressurs as Bundle).type).toBe('transaction-response');
			expect((svar.ressurs as Bundle).entry).toHaveLength(2);
		});
	});

	describe('$everything', () => {
		it('gir hele journalen til den som har tilgang', async () => {
			await girRelasjon('bruker-1', pasient1);
			const svar = await utfor({ ctx: kontekst(), metode: 'GET', sti: `Patient/${pasient1}/$everything`, sok: new URLSearchParams() });
			const typer = ((svar.ressurs as Bundle).entry ?? []).map((e) => e.resource?.resourceType);
			expect(typer).toContain('Patient');
			expect(typer).toContain('Observation');
			expect(typer).toContain('Condition');
		});

		it('fjerner ressurstyper appen ikke har lesescope for', async () => {
			await girRelasjon('bruker-1', pasient1);
			const app = appKontekst('patient/Patient.rs patient/Observation.rs', pasient1);
			const svar = await utfor({ ctx: app, metode: 'GET', sti: `Patient/${pasient1}/$everything`, sok: new URLSearchParams() });
			const typer = ((svar.ressurs as Bundle).entry ?? []).map((e) => e.resource?.resourceType);
			expect(typer).toContain('Observation');
			expect(typer).not.toContain('Condition');
		});

		it('nekter og logger når brukeren mangler tilgang', async () => {
			await expect(
				utfor({ ctx: kontekst(), metode: 'GET', sti: `Patient/${pasient1}/$everything`, sok: new URLSearchParams() })
			).rejects.toMatchObject({ status: 403 });
			expect(await antallLogg()).toBe(1);
		});
	});

	describe('CapabilityStatement', () => {
		it('legger SMART-utvidelsen på serverens erklæring', async () => {
			const svar = await utfor({ ctx: kontekst(), metode: 'GET', sti: 'metadata', sok: new URLSearchParams() });
			const rest = (svar.ressurs.rest as { security: { extension: { extension: { url: string; valueUri: string }[] }[] } }[])[0];
			const uris = rest.security.extension[0].extension;
			expect(uris.find((u) => u.url === 'authorize')?.valueUri).toContain('/oauth/authorize');
			expect(uris.find((u) => u.url === 'token')?.valueUri).toContain('/oauth/token');
		});
	});

	describe('ukjente stier', () => {
		it('avviser ustøttet ressurstype', async () => {
			await expect(
				utfor({ ctx: kontekst(), metode: 'GET', sti: 'Ingredient/1', sok: new URLSearchParams() })
			).rejects.toMatchObject({ status: 422 });
		});

		it('avviser systemoperasjoner', async () => {
			await expect(
				utfor({ ctx: kontekst(), metode: 'GET', sti: '$reindex', sok: new URLSearchParams() })
			).rejects.toThrow();
		});
	});
});
