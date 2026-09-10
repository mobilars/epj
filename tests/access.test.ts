import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../src/lib/server/db/index';
import { hasTestDatabase, createTestDatabase, emptyTables, type TestDatabase, setIn } from './fixtures/db';
import { appContext, context } from './fixtures/context';
import {
	activeEmergencyAccess,
	isPatientRelated,
	hasCareRelationship,
	canDeterminePatient,
	patientIdFromResource,
	blockedPatients,
	allowedPatients,
	evaluate
} from '../src/lib/server/authz/access';
import { STOTTEDE_RESSURSTYPER } from '../src/lib/server/fhir/searchparams';
import { newId } from '../src/lib/server/util/ids';
import { parseScopes } from '../src/lib/server/authz/scopes';

const describeIf = hasTestDatabase() ? describe : describe.skip;

const PATIENT = 'pas-1';
const ANNEN_PATIENT = 'pas-2';

async function layerUser(id: string, username: string): Promise<void> {
	await setIn('INSERT INTO user_account (id, username, name) VALUES ($1,$2,$3)', [id, username, username]);
}

async function givesRelationship(userId: string, patientId: string, basis = 'fastlege'): Promise<void> {
	await setIn('INSERT INTO care_relationship (id, user_id, patient_id, basis) VALUES ($1,$2,$3,$4)', [newId(), userId, patientId, basis]);
}

const observation = (patientId: string) => ({
	resourceType: 'Observation',
	id: 'obs-1',
	status: 'final',
	code: { text: 'Blodtrykk' },
	subject: { reference: `Patient/${patientId}` }
});

describeIf('tilgangsbeslutning', () => {
	let db: TestDatabase;
	beforeAll(async () => { db = await createTestDatabase('tilgang'); });
	afterAll(async () => { await db.riv(); });
	beforeEach(async () => {
		await emptyTables();
		await layerUser('bruker-1', 'lege');
		await layerUser('bruker-2', 'sykepleier');
	});

	describe('lag 3 - tjenstlig behov', () => {
		it('nekter uten behandlingsrelasjon', async () => {
			const b = await evaluate({ ctx: context(), resourceType: 'Observation', operation: 'r', resource: observation(PATIENT) });
			expect(b.allowed).toBe(false);
			expect(b.reason).toMatch(/behandlingsrelasjon/);
			expect(b.status).toBe(403);
		});

		it('tillater med behandlingsrelasjon', async () => {
			await givesRelationship('bruker-1', PATIENT);
			const b = await evaluate({ ctx: context(), resourceType: 'Observation', operation: 'r', resource: observation(PATIENT) });
			expect(b.allowed).toBe(true);
			expect(b.basis).toBe('behandlingsrelasjon');
			expect(b.purposeOfUse).toBe('TREAT');
		});

		it('gjelder bare den pasienten relasjonen er registrert på', async () => {
			await givesRelationship('bruker-1', PATIENT);
			const b = await evaluate({ ctx: context(), resourceType: 'Observation', operation: 'r', resource: observation(ANNEN_PATIENT) });
			expect(b.allowed).toBe(false);
		});

		it('ser bort fra utløpt relasjon', async () => {
			await setIn(
				"INSERT INTO care_relationship (id, user_id, patient_id, basis, valid_from, valid_until) VALUES ($1,$2,$3,'vikar', now() - interval '30 days', now() - interval '1 day')",
				[newId(), 'bruker-1', PATIENT]
			);
			expect(await hasCareRelationship('bruker-1', PATIENT)).toBe(false);
		});

		it('krever ikke relasjon for ressurser uten pasientopplysninger', async () => {
			const b = await evaluate({ ctx: context(), resourceType: 'Organization', operation: 'r' });
			expect(b.allowed).toBe(true);
			expect(b.basis).toBe('ikke-pasientdata');
		});
	});

	describe('lag 4 - sperring', () => {
		beforeEach(async () => {
			await givesRelationship('bruker-1', PATIENT);
			await givesRelationship('bruker-2', PATIENT);
		});

		it('sperrer for en navngitt bruker', async () => {
			await setIn(
				"INSERT INTO record_restriction (id, patient_id, scope_extent, target_user_id, registered_by) VALUES ($1,$2,'bruker',$3,'bruker-1')",
				[newId(), PATIENT, 'bruker-2']
			);
			const nurse = context({ userId: 'bruker-2', roles: ['sykepleier'] });
			const b = await evaluate({ ctx: nurse, resourceType: 'Observation', operation: 'r', resource: observation(PATIENT) });
			expect(b.allowed).toBe(false);
			expect(b.reason).toMatch(/sperret/);

			// The doctor is not covered by the restriction.
			expect((await evaluate({ ctx: context(), resourceType: 'Observation', operation: 'r', resource: observation(PATIENT) })).allowed).toBe(true);
		});

		it('sperrer for en hel rolle', async () => {
			await setIn(
				"INSERT INTO record_restriction (id, patient_id, scope_extent, target_role, registered_by) VALUES ($1,$2,'rolle','sykepleier','bruker-1')",
				[newId(), PATIENT]
			);
			const nurse = context({ userId: 'bruker-2', roles: ['sykepleier'] });
			expect((await evaluate({ ctx: nurse, resourceType: 'Observation', operation: 'r', resource: observation(PATIENT) })).allowed).toBe(false);
		});

		it('sperrer et enkeltdokument', async () => {
			await setIn(
				"INSERT INTO record_restriction (id, patient_id, scope_extent, target_resource, registered_by) VALUES ($1,$2,'dokument','Observation/obs-1','bruker-1')",
				[newId(), PATIENT]
			);
			expect((await evaluate({ ctx: context(), resourceType: 'Observation', operation: 'r', resource: observation(PATIENT) })).allowed).toBe(false);
			// Another observation is not restricted.
			expect(
				(await evaluate({ ctx: context(), resourceType: 'Observation', operation: 'r', resource: { ...observation(PATIENT), id: 'obs-2' } })).allowed
			).toBe(true);
		});

		it('ser bort fra opphevet sperring', async () => {
			await setIn(
				"INSERT INTO record_restriction (id, patient_id, scope_extent, registered_by, lifted) VALUES ($1,$2,'alle','bruker-1',true)",
				[newId(), PATIENT]
			);
			expect((await evaluate({ ctx: context(), resourceType: 'Observation', operation: 'r', resource: observation(PATIENT) })).allowed).toBe(true);
		});
	});

	describe('nødrett', () => {
		it('gir tilgang uten behandlingsrelasjon, og merker formålet ETREAT', async () => {
			await setIn(
				"INSERT INTO break_glass (id, user_id, patient_id, justification, expires_at) VALUES ($1,$2,$3,$4, now() + interval '4 hours')",
				[newId(), 'bruker-1', PATIENT, 'Akutt situasjon på legevakt']
			);
			expect(await activeEmergencyAccess('bruker-1', PATIENT)).toBe(true);
			const b = await evaluate({ ctx: context(), resourceType: 'Observation', operation: 'r', resource: observation(PATIENT) });
			expect(b.allowed).toBe(true);
			expect(b.basis).toBe('nodrett');
			expect(b.purposeOfUse).toBe('ETREAT');
		});

		it('overstyrer sperring', async () => {
			await setIn("INSERT INTO record_restriction (id, patient_id, scope_extent, registered_by) VALUES ($1,$2,'alle','bruker-1')", [newId(), PATIENT]);
			await setIn(
				"INSERT INTO break_glass (id, user_id, patient_id, justification, expires_at) VALUES ($1,$2,$3,'Nødsituasjon', now() + interval '1 hour')",
				[newId(), 'bruker-1', PATIENT]
			);
			expect((await evaluate({ ctx: context(), resourceType: 'Observation', operation: 'r', resource: observation(PATIENT) })).allowed).toBe(true);
		});

		it('utløper', async () => {
			await setIn(
				"INSERT INTO break_glass (id, user_id, patient_id, justification, started_at, expires_at) VALUES ($1,$2,$3,'Gammel', now() - interval '5 hours', now() - interval '1 hour')",
				[newId(), 'bruker-1', PATIENT]
			);
			expect(await activeEmergencyAccess('bruker-1', PATIENT)).toBe(false);
		});

		it('overstyrer aldri manglende scope', async () => {
			await setIn(
				"INSERT INTO break_glass (id, user_id, patient_id, justification, expires_at) VALUES ($1,$2,$3,'Nød', now() + interval '1 hour')",
				[newId(), 'bruker-1', PATIENT]
			);
			const app = appContext('patient/Observation.rs', PATIENT);
			const b = await evaluate({ ctx: app, resourceType: 'Condition', operation: 'r', patientId: PATIENT });
			expect(b.allowed).toBe(false);
			expect(b.reason).toMatch(/scope/);
		});
	});

	describe('lag 1 og 2 - scope og rolle', () => {
		beforeEach(async () => { await givesRelationship('bruker-1', PATIENT); });

		it('nekter skriving for rolle uten skriverettighet', async () => {
			const sekretaer = context({ roles: ['helsesekretaer'] });
			const b = await evaluate({ ctx: sekretaer, resourceType: 'Observation', operation: 'c', resource: observation(PATIENT) });
			expect(b.allowed).toBe(false);
		});

		it('nekter app som mangler scope for ressurstypen', async () => {
			const app = appContext('patient/Observation.rs', PATIENT);
			expect((await evaluate({ ctx: app, resourceType: 'MedicationRequest', operation: 'r', patientId: PATIENT })).allowed).toBe(false);
		});

		it('nekter app som prøver seg på en annen pasient enn i launch-konteksten', async () => {
			await givesRelationship('bruker-1', ANNEN_PATIENT);
			const app = appContext('patient/Observation.rs', PATIENT);
			expect((await evaluate({ ctx: app, resourceType: 'Observation', operation: 'r', patientId: ANNEN_PATIENT })).allowed).toBe(false);
		});
	});

	describe('registrering av ny pasient', () => {
		/**
		 * A Patient being created has no id, so there is no patient to judge
		 * against - no care relationship can exist, and nothing can be
		 * restricted. Before this was handled explicitly, the create fell through
		 * to the rule that denies a patient-bearing resource with no patient
		 * reference, and nobody could register a patient at all.
		 */
		const newPatient = { resourceType: 'Patient', name: [{ family: 'Nordmann', given: ['Kari'] }] };

		it('lar en rolle med pasient:opprett registrere en ny pasient', async () => {
			const decision = await evaluate({ ctx: context({ roles: ['lege'] }), resourceType: 'Patient', operation: 'c', resource: newPatient });
			expect(decision.allowed).toBe(true);
			expect(decision.basis).toBe('pasientregistrering');
		});

		it('lar helsesekretæren registrere, selv uten skriverett i journal', async () => {
			const sekretaer = context({ roles: ['helsesekretaer'] });
			expect(sekretaer.permissions.has('journal:skriv')).toBe(false);
			expect((await evaluate({ ctx: sekretaer, resourceType: 'Patient', operation: 'c', resource: newPatient })).allowed).toBe(true);
		});

		it('nekter en rolle uten pasient:opprett', async () => {
			const sykepleier = context({ roles: ['sykepleier'] });
			expect(sykepleier.permissions.has('pasient:opprett')).toBe(false);
			expect((await evaluate({ ctx: sykepleier, resourceType: 'Patient', operation: 'c', resource: newPatient })).allowed).toBe(false);
		});

		it('gir ikke tilgang til en pasient som allerede finnes', async () => {
			// The exception covers registration only. A create carrying an id names
			// an existing record, and must be judged the ordinary way.
			const decision = await evaluate({
				ctx: context({ roles: ['lege'] }),
				resourceType: 'Patient',
				operation: 'c',
				resource: { ...newPatient, id: ANNEN_PATIENT }
			});
			expect(decision.allowed).toBe(false);
		});

		it('gir ikke skrivetilgang til journalinnhold som følge av registreringen', async () => {
			const sekretaer = context({ roles: ['helsesekretaer'] });
			expect((await evaluate({ ctx: sekretaer, resourceType: 'Observation', operation: 'c', resource: observation(PATIENT) })).allowed).toBe(false);
		});
	});

	describe('innbygger med innsyn i egen journal', () => {
		it('ser bare sin egen journal, og kan ikke skrive', async () => {
			const patientCtx = context({ roles: ['pasient'], actorRef: `Patient/${PATIENT}`, userId: 'innbygger-1' });
			const own = await evaluate({ ctx: patientCtx, resourceType: 'Observation', operation: 'r', resource: observation(PATIENT) });
			expect(own.allowed).toBe(true);
			expect(own.purposeOfUse).toBe('PATRQT');

			const annen = await evaluate({ ctx: patientCtx, resourceType: 'Observation', operation: 'r', resource: observation(ANNEN_PATIENT) });
			expect(annen.allowed).toBe(false);

			const write = await evaluate({ ctx: patientCtx, resourceType: 'Observation', operation: 'u', resource: observation(PATIENT) });
			expect(write.allowed).toBe(false);
		});
	});

	describe('avgrensning av søk', () => {
		it('gir bare pasientene brukeren har relasjon til', async () => {
			await givesRelationship('bruker-1', PATIENT);
			await givesRelationship('bruker-1', ANNEN_PATIENT);
			const allowed = await allowedPatients(context());
			expect(allowed).not.toBe('alle');
			expect([...(allowed as string[])].sort()).toEqual([PATIENT, ANNEN_PATIENT].sort());
		});

		it('tar med pasienter det er nødrett på', async () => {
			await setIn(
				"INSERT INTO break_glass (id, user_id, patient_id, justification, expires_at) VALUES ($1,$2,$3,'Nød', now() + interval '1 hour')",
				[newId(), 'bruker-1', 'pas-9']
			);
			expect(await allowedPatients(context())).toContain('pas-9');
		});

		it('gir «alle» til personvernombudet', async () => {
			expect(await allowedPatients(context({ roles: ['personvernombud'] }))).toBe('alle');
		});

		it('avgrenser til launch-pasienten når appen bare har patient/-scope', async () => {
			await givesRelationship('bruker-1', ANNEN_PATIENT);
			const app = appContext('patient/Observation.rs', PATIENT);
			expect(await allowedPatients(app)).toEqual([PATIENT]);
		});

		it('lister sperrede pasienter som skal filtreres bort', async () => {
			await setIn("INSERT INTO record_restriction (id, patient_id, scope_extent, registered_by) VALUES ($1,$2,'alle','bruker-1')", [newId(), ANNEN_PATIENT]);
			const blocked = await blockedPatients(context());
			expect(blocked.has(ANNEN_PATIENT)).toBe(true);
		});

		it('fjerner sperring fra listen når det finnes nødrett', async () => {
			await setIn("INSERT INTO record_restriction (id, patient_id, scope_extent, registered_by) VALUES ($1,$2,'alle','bruker-1')", [newId(), ANNEN_PATIENT]);
			await setIn(
				"INSERT INTO break_glass (id, user_id, patient_id, justification, expires_at) VALUES ($1,$2,$3,'Nød', now() + interval '1 hour')",
				[newId(), 'bruker-1', ANNEN_PATIENT]
			);
			expect((await blockedPatients(context())).has(ANNEN_PATIENT)).toBe(false);
		});
	});

	describe('ressurser der pasienten ikke kan avgjøres', () => {
		/**
		 * Legitimate need and restriction both presuppose that we know which
		 * patient the information concerns. Before this, a lookup where the
		 * patient could not be derived passed straight through - `Binary` was
		 * such a type, and it carries attachments: scans, results, images.
		 */
		it('nekter oppslag på en pasientnær type uten pasientreferanse', async () => {
			await givesRelationship('bruker-1', PATIENT);
			const b = await evaluate({
				ctx: context({ scopes: parseScopes('user/Binary.rs user/Observation.rs') }),
				resourceType: 'Binary',
				operation: 'r',
				resource: { resourceType: 'Binary', id: 'bin-1', contentType: 'application/pdf' }
			});
			expect(b.allowed).toBe(false);
			expect(b.reason).toMatch(/pasientreferanse/);
		});

		it('nekter oppslag når referansen mangler på en type som ellers har den', async () => {
			await givesRelationship('bruker-1', PATIENT);
			const withoutSubject = { resourceType: 'Observation', id: 'obs-2', status: 'final', code: { text: 'Uten pasient' } };
			const b = await evaluate({ ctx: context(), resourceType: 'Observation', operation: 'r', resource: withoutSubject });
			expect(b.allowed).toBe(false);
			expect(b.reason).toMatch(/pasientreferanse/);
		});

		it('lar søk slippe gjennom - der avgrenses det per treff i stedet', async () => {
			const b = await evaluate({ ctx: context(), resourceType: 'Observation', operation: 's' });
			expect(b.allowed).toBe(true);
		});

		/**
		 * A structural check, not a list to maintain: if someone adds a resource
		 * type without a `patient`/`subject` parameter, it must either be exempted
		 * explicitly as non-patient data, or fail here.
		 */
		it('alle støttede pasientnære typer har en pasientreferanse å avgrense på', () => {
			const uavklarte = STOTTEDE_RESSURSTYPER.filter((t) => isPatientRelated(t) && !canDeterminePatient(t));
			expect(uavklarte).toEqual([]);
		});
	});
});

describe('pasient-id fra ressurs', () => {
	it('finner pasienten via subject, patient og beneficiary', () => {
		expect(patientIdFromResource({ resourceType: 'Observation', subject: { reference: 'Patient/p1' } })).toBe('p1');
		expect(patientIdFromResource({ resourceType: 'AllergyIntolerance', patient: { reference: 'Patient/p2' } })).toBe('p2');
		expect(patientIdFromResource({ resourceType: 'Coverage', beneficiary: { reference: 'Patient/p3' } })).toBe('p3');
	});

	it('bruker id-en når ressursen er pasienten selv', () => {
		expect(patientIdFromResource({ resourceType: 'Patient', id: 'p4' })).toBe('p4');
	});

	it('gir null når ressursen ikke gjelder en pasient', () => {
		expect(patientIdFromResource({ resourceType: 'Organization', id: 'o1' })).toBeNull();
	});
});
