import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec, query } from '../src/lib/server/db/index';
import { hasTestDatabase, createTestDatabase, emptyTables, type TestDatabase, setIn } from './fixtures/db';
import { fhirForTest, type TestFhirServer } from './fixtures/fhir-testserver';
import { appContext, context } from './fixtures/context';
import { execute } from '../src/lib/server/fhir/gateway';
import { FhirError } from '../src/lib/server/fhir/outcome';
import { fhirClient } from '../src/lib/server/fhir/client';
import { newId } from '../src/lib/server/util/ids';
import { SYSTEM } from '../src/lib/server/fhir/codesystems';
import type { Bundle } from '../src/lib/server/fhir/types';

const describeIf = hasTestDatabase() ? describe : describe.skip;

/**
 * Integration test of the guard in front of the FHIR server.
 *
 * Runs against real PostgreSQL and over real HTTP towards a FHIR server, so
 * the whole chain is tested: the access decision, forwarding, post-filtering
 * of restricted patients and writing to the security log.
 */
describeIf('FHIR-vokteren', () => {
	let db: TestDatabase;
	let fhir: TestFhirServer;
	let pasient1 = '';
	let pasient2 = '';

	beforeAll(async () => {
		db = await createTestDatabase('gateway');
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
		await setIn('INSERT INTO user_account (id, username, name) VALUES ($1,$2,$3)', ['bruker-1', 'ingrid', 'Dr. Ingrid Fastlege']);
		await setIn('INSERT INTO user_account (id, username, name) VALUES ($1,$2,$3)', ['bruker-2', 'kari', 'Kari Sykepleier']);

		const p1 = await fhirClient.create({
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: '13086510035' }],
			name: [{ family: 'Bakken', given: ['Anne'] }]
		});
		const p2 = await fhirClient.create({
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: '24035810281' }],
			name: [{ family: 'Vik', given: ['Ola'] }]
		});
		pasient1 = p1.resource.id as string;
		pasient2 = p2.resource.id as string;

		for (const p of [pasient1, pasient2]) {
			await fhirClient.create({
				resourceType: 'Observation',
				status: 'final',
				category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
				code: { coding: [{ system: SYSTEM.LOINC, code: '8480-6' }], text: 'Systolisk blodtrykk' },
				subject: { reference: `Patient/${p}` },
				valueQuantity: { value: 140, unit: 'mm[Hg]' }
			});
			await fhirClient.create({
				resourceType: 'Condition',
				clinicalStatus: { coding: [{ code: 'active' }] },
				code: { text: 'Hypertensjon' },
				subject: { reference: `Patient/${p}` }
			});
		}
	});

	const givesRelationship = (userId: string, patientId: string) =>
		setIn('INSERT INTO care_relationship (id, user_id, patient_id, basis) VALUES ($1,$2,$3,$4)', [newId(), userId, patientId, 'fastlege']);

	const countLog = async (): Promise<number> =>
		Number((await query<{ n: string }>('SELECT count(*)::int AS n FROM audit_event'))[0].n);

	describe('lesing', () => {
		it('leser en ressurs brukeren har tilgang til, og logger det', async () => {
			await givesRelationship('bruker-1', pasient1);
			const response = await execute({ ctx: context(), method: 'GET', path: `Patient/${pasient1}`, search: new URLSearchParams() });
			expect(response.status).toBe(200);
			expect(response.resource.resourceType).toBe('Patient');
			expect(response.headers.etag).toMatch(/^W\//);

			const log = await query<{ subtype: string; outcome: string; patient_id: string }>('SELECT subtype, outcome, patient_id FROM audit_event');
			expect(log).toHaveLength(1);
			expect(log[0]).toMatchObject({ subtype: 'read', outcome: '0', patient_id: pasient1 });
		});

		it('nekter lesing uten behandlingsrelasjon, og logger avvisningen', async () => {
			await expect(
				execute({ ctx: context(), method: 'GET', path: `Patient/${pasient1}`, search: new URLSearchParams() })
			).rejects.toThrow(FhirError);

			const log = await query<{ outcome: string; outcome_desc: string }>('SELECT outcome, outcome_desc FROM audit_event');
			expect(log).toHaveLength(1);
			expect(log[0].outcome).toBe('4');
			expect(log[0].outcome_desc).toMatch(/behandlingsrelasjon/);
		});

		it('nekter en app som mangler scope for ressurstypen', async () => {
			await givesRelationship('bruker-1', pasient1);
			const app = appContext('patient/Observation.rs', pasient1);
			await expect(
				execute({ ctx: app, method: 'GET', path: `Condition/finnes-ikke`, search: new URLSearchParams() })
			).rejects.toThrow();
		});
	});

	describe('søk', () => {
		it('avgrenser til pasienter brukeren har relasjon til', async () => {
			await givesRelationship('bruker-1', pasient1);
			const response = await execute({ ctx: context(), method: 'POST', path: 'Observation/_search', search: new URLSearchParams(), body: new URLSearchParams() });
			const bundle = response.resource as Bundle;
			expect(bundle.entry).toHaveLength(1);
			const subject = (bundle.entry?.[0].resource?.subject as { reference: string }).reference;
			expect(subject).toBe(`Patient/${pasient1}`);
		});

		it('gir tomt resultat når brukeren ikke har noen pasienter', async () => {
			const response = await execute({ ctx: context(), method: 'POST', path: 'Observation/_search', search: new URLSearchParams(), body: new URLSearchParams() });
			expect((response.resource as Bundle).entry).toHaveLength(0);
			// No call must have gone on to the FHIR server.
			if (!fhir.isEkte) {
				expect(fhir.call.filter((k) => k.path.startsWith('Observation/_search'))).toHaveLength(0);
			}
		});

		it('filtrerer bort sperrede pasienter etter at serveren har svart', async () => {
			await givesRelationship('bruker-1', pasient1);
			await givesRelationship('bruker-1', pasient2);
			await setIn("INSERT INTO record_restriction (id, patient_id, scope_extent, registered_by) VALUES ($1,$2,'alle','bruker-1')", [newId(), pasient2]);

			const response = await execute({ ctx: context(), method: 'POST', path: 'Observation/_search', search: new URLSearchParams(), body: new URLSearchParams() });
			const bundle = response.resource as Bundle;
			expect(bundle.entry).toHaveLength(1);
			expect((bundle.entry?.[0].resource?.subject as { reference: string }).reference).toBe(`Patient/${pasient1}`);

			const log = await query<{ content: { entity: { detail: { type: { text: string }; valueString: string }[] }[] } }>(
				"SELECT content FROM audit_event WHERE subtype = 'search-type'"
			);
			const details = log[0].content.entity[0].detail;
			expect(details.find((d) => d.type.text === 'filtrertBortSperret')?.valueString).toBe('1');
		});

		it('tvinger inn scope-begrensninger i spørringen', async () => {
			await givesRelationship('bruker-1', pasient1);
			const app = appContext('patient/Observation.rs?category=vital-signs', pasient1);
			await execute({ ctx: app, method: 'POST', path: 'Observation/_search', search: new URLSearchParams(), body: new URLSearchParams() });
			// The narrowing must have reached the server.
			if (!fhir.isEkte) {
				expect(fhir.call.some((k) => k.path === 'Observation/_search')).toBe(true);
			}
		});

		it('maskerer identifikatorer i loggen', async () => {
			await givesRelationship('bruker-1', pasient1);
			await execute({
				ctx: context(), method: 'POST', path: 'Patient/_search',
				search: new URLSearchParams(), body: new URLSearchParams({ identifier: `${SYSTEM.FNR}|13086510035` })
			});
			const log = await query<{ content: { entity: { detail: { type: { text: string }; valueString: string }[] }[] } }>(
				"SELECT content FROM audit_event WHERE subtype = 'search-type'"
			);
			const loggedQuery = log[0].content.entity[0].detail.find((d) => d.type.text === 'spørring')?.valueString ?? '';
			expect(loggedQuery).not.toContain('13086510035');
			expect(loggedQuery).toContain('maskert');
		});
	});

	describe('skriving', () => {
		it('oppretter en ressurs og merker forfatteren', async () => {
			await givesRelationship('bruker-1', pasient1);
			const response = await execute({
				ctx: context(), method: 'POST', path: 'Condition', search: new URLSearchParams(),
				body: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Astma' }, subject: { reference: `Patient/${pasient1}` } }
			});
			expect(response.status).toBe(201);
			expect(response.headers.location).toContain('/Condition/');
			const tagger = (response.resource.meta as { tag?: { system: string; code: string }[] }).tag ?? [];
			expect(tagger.some((t) => t.system === 'urn:epj:forfatter' && t.code === 'Practitioner/42')).toBe(true);
		});

		it('avviser ressurs som ikke validerer, uten å kontakte serveren', async () => {
			await givesRelationship('bruker-1', pasient1);
			const forFor = fhir.call.length;
			await expect(
				execute({ ctx: context(), method: 'POST', path: 'Observation', search: new URLSearchParams(), body: { resourceType: 'Observation' } })
			).rejects.toMatchObject({ status: 422 });
			if (!fhir.isEkte) expect(fhir.call.length).toBe(forFor);
		});

		it('hindrer at en ressurs flyttes over på en pasient brukeren har tilgang til', async () => {
			await givesRelationship('bruker-1', pasient1);
			const fremmed = await fhirClient.create({
				resourceType: 'Condition',
				clinicalStatus: { coding: [{ code: 'active' }] },
				code: { text: 'Skjult' },
				subject: { reference: `Patient/${pasient2}` }
			});
			// The new version points at "my" patient, but the existing one does not.
			await expect(
				execute({
					ctx: context(), method: 'PUT', path: `Condition/${fremmed.resource.id}`, search: new URLSearchParams(),
					body: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Flyttet' }, subject: { reference: `Patient/${pasient1}` } }
				})
			).rejects.toMatchObject({ status: 403 });
		});

		it('nekter sletting for rolle uten skriverettighet', async () => {
			await givesRelationship('bruker-2', pasient1);
			const sekretaer = context({ userId: 'bruker-2', roles: ['resepsjon'] });
			await expect(
				execute({ ctx: sekretaer, method: 'DELETE', path: `Condition/finnes-ikke`, search: new URLSearchParams() })
			).rejects.toThrow();
		});
	});

	describe('transaksjoner', () => {
		it('vurderer hver oppføring for seg', async () => {
			await givesRelationship('bruker-1', pasient1);
			const bundle = {
				resourceType: 'Bundle',
				type: 'transaction',
				entry: [
					{ request: { method: 'POST', url: 'Condition' }, resource: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Ok' }, subject: { reference: `Patient/${pasient1}` } } },
					{ request: { method: 'POST', url: 'Condition' }, resource: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'Ikke lov' }, subject: { reference: `Patient/${pasient2}` } } }
				]
			};
			await expect(
				execute({ ctx: context(), method: 'POST', path: '', search: new URLSearchParams(), body: bundle })
			).rejects.toMatchObject({ status: 403 });

			// The whole transaction must have been stopped before it reached the server.
			if (!fhir.isEkte) {
				expect(fhir.call.some((k) => k.method === 'POST' && k.path === '')).toBe(false);
			}
		});

		it('vurderer en endring i en transaksjon mot den lagrede versjonen også', async () => {
			// The user sees patient 1 only. An observation belonging to patient 2,
			// rewritten with patient 1 as subject, is a move of somebody else's
			// record content - and would have passed if only the new version were
			// judged, as a plain PUT already guards against.
			await givesRelationship('bruker-1', pasient1);
			const theirs = await fhirClient.create({
				resourceType: 'Observation',
				status: 'final',
				code: { text: 'Ikke min' },
				subject: { reference: `Patient/${pasient2}` }
			});
			await expect(
				execute({
					ctx: context(), method: 'POST', path: '', search: new URLSearchParams(),
					body: {
						resourceType: 'Bundle',
						type: 'transaction',
						entry: [
							{
								request: { method: 'PUT', url: `Observation/${theirs.resource.id}` },
								resource: { ...theirs.resource, subject: { reference: `Patient/${pasient1}` } }
							}
						]
					}
				})
			).rejects.toMatchObject({ status: 403 });
		});

		it('avviser betingede endringer i en transaksjon', async () => {
			await givesRelationship('bruker-1', pasient1);
			await expect(
				execute({
					ctx: context(), method: 'POST', path: '', search: new URLSearchParams(),
					body: {
						resourceType: 'Bundle',
						type: 'transaction',
						entry: [
							{
								request: { method: 'PUT', url: 'Observation?identifier=x' },
								resource: { resourceType: 'Observation', status: 'final', code: { text: 'A' }, subject: { reference: `Patient/${pasient1}` } }
							}
						]
					}
				})
			).rejects.toMatchObject({ status: 400 });
		});

		it('kjører en transaksjon der alt er tillatt', async () => {
			await givesRelationship('bruker-1', pasient1);
			const response = await execute({
				ctx: context(), method: 'POST', path: '', search: new URLSearchParams(),
				body: {
					resourceType: 'Bundle',
					type: 'transaction',
					entry: [
						{ request: { method: 'POST', url: 'Condition' }, resource: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'A' }, subject: { reference: `Patient/${pasient1}` } } },
						{ request: { method: 'POST', url: 'Condition' }, resource: { resourceType: 'Condition', clinicalStatus: { coding: [{ code: 'active' }] }, code: { text: 'B' }, subject: { reference: `Patient/${pasient1}` } } }
					]
				}
			});
			expect((response.resource as Bundle).type).toBe('transaction-response');
			expect((response.resource as Bundle).entry).toHaveLength(2);
		});
	});

	describe('$everything', () => {
		it('gir hele journalen til den som har tilgang', async () => {
			await givesRelationship('bruker-1', pasient1);
			const response = await execute({ ctx: context(), method: 'GET', path: `Patient/${pasient1}/$everything`, search: new URLSearchParams() });
			const types = ((response.resource as Bundle).entry ?? []).map((e) => e.resource?.resourceType);
			expect(types).toContain('Patient');
			expect(types).toContain('Observation');
			expect(types).toContain('Condition');
		});

		it('fjerner ressurstyper appen ikke har lesescope for', async () => {
			await givesRelationship('bruker-1', pasient1);
			const app = appContext('patient/Patient.rs patient/Observation.rs', pasient1);
			const response = await execute({ ctx: app, method: 'GET', path: `Patient/${pasient1}/$everything`, search: new URLSearchParams() });
			const types = ((response.resource as Bundle).entry ?? []).map((e) => e.resource?.resourceType);
			expect(types).toContain('Observation');
			expect(types).not.toContain('Condition');
		});

		it('nekter og logger når brukeren mangler tilgang', async () => {
			await expect(
				execute({ ctx: context(), method: 'GET', path: `Patient/${pasient1}/$everything`, search: new URLSearchParams() })
			).rejects.toMatchObject({ status: 403 });
			expect(await countLog()).toBe(1);
		});
	});

	describe('CapabilityStatement', () => {
		it('legger SMART-utvidelsen på serverens erklæring', async () => {
			const response = await execute({ ctx: context(), method: 'GET', path: 'metadata', search: new URLSearchParams() });
			const rest = (response.resource.rest as { security: { extension: { extension: { url: string; valueUri: string }[] }[] } }[])[0];
			const uris = rest.security.extension[0].extension;
			expect(uris.find((u) => u.url === 'authorize')?.valueUri).toContain('/oauth/authorize');
			expect(uris.find((u) => u.url === 'token')?.valueUri).toContain('/oauth/token');
		});
	});

	describe('ukjente stier', () => {
		it('avviser ustøttet ressurstype', async () => {
			await expect(
				execute({ ctx: context(), method: 'GET', path: 'Ingredient/1', search: new URLSearchParams() })
			).rejects.toMatchObject({ status: 422 });
		});

		it('avviser systemoperasjoner', async () => {
			await expect(
				execute({ ctx: context(), method: 'GET', path: '$reindex', search: new URLSearchParams() })
			).rejects.toThrow();
		});
	});
});
