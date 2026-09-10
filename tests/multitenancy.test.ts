import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { one, exec, query } from '../src/lib/server/db/index';
import { hasTestDatabase, createTestDatabase, emptyTables, type TestDatabase } from './fixtures/db';
import { fhirForTest, type TestFhirServer } from './fixtures/fhir-testserver';
import { withTenant, requireTenant, currentTenant, time, fhirBaseFor, issuerFor, PLATFORM_TENANT } from '../src/lib/server/tenant/context';
import { getTenant, getTenantOnHostname, listTenanter, createTenant, updateTenant, setTenantstatus, tenantOverview } from '../src/lib/server/tenant/tenant';
import { listPartitions, partitioningWorks } from '../src/lib/server/tenant/partition';
import { getUser, getUserAtUsername, listUsers, logIn, createUser } from '../src/lib/server/auth/users';
import { getClient, listClients, registerClient } from '../src/lib/server/auth/clients';
import { activeSigningKey, jwks } from '../src/lib/server/auth/keys';
import { getLog, log, verifyLogChain, type AuditActor } from '../src/lib/server/audit';
import { fhirClient } from '../src/lib/server/fhir/client';
import { listCard, createBillingCard } from '../src/lib/server/integrations/helfo/billing';
import { queueOut, listMessages } from '../src/lib/server/integrations/nhn/message-queue';
import { buildReferral } from '../src/lib/server/integrations/nhn/messages';
import { toPart } from '../src/lib/server/integrations/nhn/address-registry';
import { rateLimit } from '../src/lib/server/http';
import { SYSTEM } from '../src/lib/server/fhir/codesystems';
import { TEST_TENANT } from './fixtures/context';
import type { Tenant } from '../src/lib/server/tenant/context';

const describeIf = hasTestDatabase() ? describe : describe.skip;

const actor: AuditActor = {
	userId: null, actorRef: 'Device/test', name: 'Test', role: null,
	clientId: null, ip: '192.0.2.10', requestId: 'req-tenant'
};

/**
 * Multitenancy.
 *
 * Isolation is a claim until it has been tried. The tests here write data in
 * one organisation and check that it is invisible from another - through the
 * same modules the application itself uses, not through raw SQL.
 *
 * Clinical data is separated by HAPI's partitioning, and is therefore tried
 * over real HTTP against a partition-aware FHIR server.
 */
describeIf('multitenancy', () => {
	let db: TestDatabase;
	let fhir: TestFhirServer;
	/** Organisation A is the default organisation the migration inserts. */
	let a: Tenant;
	/** Organisation B is created by the test, with its own partition. */
	let b: Tenant;

	beforeAll(async () => {
		db = await createTestDatabase('tenant');
		fhir = await fhirForTest();
		process.env.EPJ_HAPI_BASE_URL = fhir.url;
	});

	afterAll(async () => {
		await fhir.close();
		await db.riv();
	});

	beforeEach(async () => {
		await emptyTables();
		await exec("DELETE FROM tenant WHERE id NOT IN ('standard', 'plattform')");
		fhir.nullstill();

		a = (await getTenant('standard')) as Tenant;
		expect(a).toBeTruthy();

		const created_at = await withTenant(a, () =>
			createTenant(
				{
					id: 'legekontor-b',
					name: 'Legekontor B',
					organisation_number: '994598759',
					hostname: 'b.epj.test',
					baseUrl: 'https://b.epj.test'
				},
				actor
			)
		);
		if (!created_at.ok) throw new Error(created_at.error);
		b = created_at.tenant;
	});

	describe('virksomhetskontekst', () => {
		it('gjenoppretter den ytre konteksten etter et nøstet kall', async () => {
			await withTenant(a, async () => {
				expect(requireTenant().id).toBe(a.id);
				await withTenant(b, async () => expect(requireTenant().id).toBe(b.id));
				// The inner context does not leak back out.
				expect(requireTenant().id).toBe(a.id);
			});
			expect(currentTenant()?.id).toBe(TEST_TENANT.id);
		});

		it('holder konteksten over await, slik at samtidige forespørsler ikke blandes', async () => {
			const treg = async (t: Tenant, ms: number) =>
				withTenant(t, async () => {
					await new Promise((r) => setTimeout(r, ms));
					return time();
				});
			// B starts last and finishes first; A must still see its own.
			const [iA, iB] = await Promise.all([treg(a, 20), treg(b, 1)]);
			expect([iA, iB]).toEqual([a.id, b.id]);
		});

		it('gir hver virksomhet sin egen FHIR-base og issuer', () => {
			expect(fhirBaseFor(a)).not.toBe(fhirBaseFor(b));
			expect(issuerFor(b)).toBe('https://b.epj.test');
			expect(fhirBaseFor(b)).toBe('https://b.epj.test/fhir');
		});

		it('tid() følger den omsluttende konteksten', async () => {
			expect(await withTenant(a, async () => time())).toBe('standard');
			expect(await withTenant(b, async () => time())).toBe('legekontor-b');
		});
	});

	describe('registeret', () => {
		it('avviser ugyldig maskinnavn', async () => {
			const r = await withTenant(a, () =>
				createTenant({ id: 'Ugyldig Navn', name: 'X', organisation_number: '994598759', baseUrl: 'https://x.test' }, actor)
			);
			expect(r.ok).toBe(false);
		});

		it('avviser organisasjonsnummer som ikke består mod11', async () => {
			const r = await withTenant(a, () =>
				createTenant({ id: 'feilorgnr', name: 'X', organisation_number: '123456789', baseUrl: 'https://x.test' }, actor)
			);
			expect(r.ok).toBe(false);
			expect(r.ok === false && r.error).toMatch(/mod11/i);
		});

		it('avviser maskinnavn og vertsnavn som allerede er i bruk', async () => {
			const likId = await withTenant(a, () =>
				createTenant({ id: 'legekontor-b', name: 'Dublett', organisation_number: '994598759', baseUrl: 'https://c.test' }, actor)
			);
			expect(likId.ok).toBe(false);

			const likVert = await withTenant(a, () =>
				createTenant(
					{ id: 'legekontor-c', name: 'Dublett', organisation_number: '994598759', hostname: 'b.epj.test', baseUrl: 'https://c.test' },
					actor
				)
			);
			expect(likVert.ok).toBe(false);
		});

		it('gir hver virksomhet sin egen partisjons-id', async () => {
			const all = await listTenanter();
			const ider = all.filter((t) => t.id !== PLATFORM_TENANT).map((t) => t.partition_id);
			expect(new Set(ider).size).toBe(ider.length);
		});

		it('oppretter partisjonen i FHIR-serveren', async () => {
			const partitions = await listPartitions();
			expect(partitions.ok).toBe(true);
			expect(partitions.ok && partitions.partitions.map((p) => p.name)).toContain('legekontor-b');
			expect((await partitioningWorks()).ok).toBe(true);
		});

		it('finner virksomheten på vertsnavn, uavhengig av store og små bokstaver', async () => {
			expect((await getTenantOnHostname('B.EPJ.TEST'))?.id).toBe('legekontor-b');
			expect(await getTenantOnHostname('ukjent.test')).toBeNull();
		});

		it('oppretter den første systemansvarlige inne i den nye virksomheten', async () => {
			const r = await withTenant(a, () =>
				createTenant(
					{
						id: 'legekontor-d',
						name: 'Legekontor D',
						organisation_number: '994598759',
						baseUrl: 'https://d.epj.test',
						adminUsername: 'sjefen',
						adminName: 'Dagny Sjef'
					},
					actor
				)
			);
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.temporaryPassword).toBeTruthy();

			const d = r.tenant;
			const iD = await withTenant(d, () => getUserAtUsername('sjefen'));
			expect(iD?.name).toBe('Dagny Sjef');

			// The same user does not exist in the other organisations.
			expect(await withTenant(a, () => getUserAtUsername('sjefen'))).toBeNull();
			expect(await withTenant(b, () => getUserAtUsername('sjefen'))).toBeNull();
		});

		it('kan endre navn og adresse, men ikke maskinnavn', async () => {
			await withTenant(a, () => updateTenant('legekontor-b', { name: 'Legekontor B AS' }, actor));
			expect((await getTenant('legekontor-b'))?.name).toBe('Legekontor B AS');
		});

		it('nekter å flytte et vertsnavn som er i bruk', async () => {
			await withTenant(a, () => updateTenant('standard', { hostname: 'a.epj.test' }, actor));
			const r = await withTenant(a, () => updateTenant('legekontor-b', { hostname: 'a.epj.test' }, actor));
			expect(r.ok).toBe(false);
		});
	});

	describe('brukere', () => {
		it('holder brukerne adskilt', async () => {
			const iA = await withTenant(a, () => createUser({ username: 'lege', name: 'Lege A', roles: ['lege'] }));
			const iB = await withTenant(b, () => createUser({ username: 'lege', name: 'Lege B', roles: ['lege'] }));
			expect(iA.id).not.toBe(iB.id);

			expect((await withTenant(a, () => listUsers())).map((u) => u.name)).toEqual(['Lege A']);
			expect((await withTenant(b, () => listUsers())).map((u) => u.name)).toEqual(['Lege B']);

			// A lookup by id from the wrong organisation yields nothing.
			expect(await withTenant(b, () => getUser(iA.id))).toBeNull();
			expect(await withTenant(a, () => getUser(iB.id))).toBeNull();
		});

		it('lar samme brukernavn finnes i flere virksomheter, men ikke to ganger i én', async () => {
			await withTenant(a, () => createUser({ username: 'lege', name: 'Lege A', roles: ['lege'] }));
			await expect(
				withTenant(a, () => createUser({ username: 'LEGE', name: 'Dublett', roles: ['lege'] }))
			).rejects.toThrow();
			await expect(
				withTenant(b, () => createUser({ username: 'lege', name: 'Lege B', roles: ['lege'] }))
			).resolves.toBeTruthy();
		});

		it('lar samme HelseID-identitet ha én konto per virksomhet', async () => {
			const iA = await withTenant(a, () => createUser({ username: 'ingrid', name: 'Ingrid', roles: ['lege'] }));
			const iB = await withTenant(b, () => createUser({ username: 'ingrid', name: 'Ingrid', roles: ['lege'] }));
			await exec('UPDATE user_account SET helseid_sub = $2 WHERE id = $1', [iA.id, 'helseid-1']);
			await exec('UPDATE user_account SET helseid_sub = $2 WHERE id = $1', [iB.id, 'helseid-1']);

			const rows = await query<{ n: number }>("SELECT count(*)::int AS n FROM user_account WHERE helseid_sub = 'helseid-1'");
			expect(rows[0]?.n).toBe(2);
		});

		it('nekter pålogging med et brukernavn som hører hjemme i en annen virksomhet', async () => {
			await withTenant(a, () => createUser({ username: 'lege', name: 'Lege A', password: 'Testpassord1!', roles: ['lege'] }));
			// In its own organisation the system knows the user (and goes on to MFA).
			expect((await withTenant(a, () => logIn('lege', 'Testpassord1!'))).outcome).not.toBe('ukjent-bruker');
			// In the neighbouring organisation the username simply does not exist.
			expect((await withTenant(b, () => logIn('lege', 'Testpassord1!'))).outcome).toBe('ukjent-bruker');
		});
	});

	describe('kliniske data', () => {
		it('skiller pasientene i hver sin FHIR-partisjon', async () => {
			const pA = await withTenant(a, () =>
				fhirClient.create({
					resourceType: 'Patient',
					identifier: [{ system: SYSTEM.FNR, value: '13086510035' }],
					name: [{ family: 'Bakken', given: ['Anne'] }]
				})
			);
			const pB = await withTenant(b, () =>
				fhirClient.create({
					resourceType: 'Patient',
					identifier: [{ system: SYSTEM.FNR, value: '24035810281' }],
					name: [{ family: 'Vik', given: ['Ola'] }]
				})
			);

			// A search in A sees only A's patient.
			const searchA = await withTenant(a, () => fhirClient.search('Patient', new URLSearchParams()));
			expect((searchA.entry ?? []).map((e) => (e.resource as { id: string }).id)).toEqual([pA.resource.id]);

			const searchB = await withTenant(b, () => fhirClient.search('Patient', new URLSearchParams()));
			expect((searchB.entry ?? []).map((e) => (e.resource as { id: string }).id)).toEqual([pB.resource.id]);
		});

		it('nekter direkte oppslag på en id fra en annen virksomhet', async () => {
			const pA = await withTenant(a, () =>
				fhirClient.create({ resourceType: 'Patient', name: [{ family: 'Bakken' }] })
			);
			const fromB = await withTenant(b, () => fhirClient.read('Patient', pA.resource.id as string).catch(() => null));
			expect(fromB).toBeNull();
		});

		it('legger partisjonsnavnet i FHIR-adressen', async () => {
			await withTenant(b, () => fhirClient.create({ resourceType: 'Patient', name: [{ family: 'Vik' }] }));
			if (fhir.isEkte) return;
			expect(fhir.call.some((k) => k.partition === 'legekontor-b')).toBe(true);
			expect(fhir.storeFor('legekontor-b').get('Patient')?.size).toBe(1);
			expect(fhir.storeFor('standard').get('Patient')?.size ?? 0).toBe(0);
		});
	});

	describe('sikkerhetsloggen', () => {
		it('lenker hver virksomhets kjede for seg', async () => {
			for (let i = 0; i < 3; i++) {
				await withTenant(a, () => log({ type: 'admin', subtype: `a-${i}`, action: 'E', outcome: '0' }, actor));
				await withTenant(b, () => log({ type: 'admin', subtype: `b-${i}`, action: 'E', outcome: '0' }, actor));
			}

			const iA = await withTenant(a, () => getLog({ limit: 50 }));
			const iB = await withTenant(b, () => getLog({ limit: 50 }));
			// Each organisation sees its own entries, and none of the neighbour's.
			expect(iA.rows.filter((r) => r.subtype?.startsWith('a-'))).toHaveLength(3);
			expect(iA.rows.some((r) => r.subtype?.startsWith('b-'))).toBe(false);
			expect(iB.rows.filter((r) => r.subtype?.startsWith('b-'))).toHaveLength(3);
			expect(iB.rows.some((r) => r.subtype?.startsWith('a-'))).toBe(false);

			// Both chains verify separately, even though the rows lie interleaved
			// in the table.
			expect((await withTenant(a, () => verifyLogChain())).valid).toBe(true);
			expect((await withTenant(b, () => verifyLogChain())).valid).toBe(true);
		});

		it('oppdager tukling i én virksomhet uten å underkjenne den andre', async () => {
			await withTenant(a, () => log({ type: 'admin', subtype: 'a-1', action: 'E', outcome: '0' }, actor));
			await withTenant(a, () => log({ type: 'admin', subtype: 'a-2', action: 'E', outcome: '0' }, actor));
			await withTenant(b, () => log({ type: 'admin', subtype: 'b-1', action: 'E', outcome: '0' }, actor));

			const row = await one<{ seq: number }>(
				"SELECT seq FROM audit_event WHERE tenant_id = 'standard' AND subtype = 'a-1' ORDER BY seq LIMIT 1"
			);
			// The trigger must be detached to simulate an attack at the database level.
			await exec('ALTER TABLE audit_event DISABLE TRIGGER trg_audit_append_only');
			await exec(`UPDATE audit_event SET content = jsonb_set(content, '{action}', '"C"') WHERE seq = $1`, [row?.seq]);
			await exec('ALTER TABLE audit_event ENABLE TRIGGER trg_audit_append_only');

			expect((await withTenant(a, () => verifyLogChain())).valid).toBe(false);
			expect((await withTenant(b, () => verifyLogChain())).valid).toBe(true);
		});
	});

	describe('OAuth', () => {
		it('holder klientregisteret adskilt', async () => {
			const kA = await withTenant(a, () =>
				registerClient({ name: 'App A', type: 'public', category: 'smart-ehr', redirectUris: ['https://a.test/cb'], scopes: ['user/Patient.rs'] })
			);
			await withTenant(b, () =>
				registerClient({ name: 'App B', type: 'public', category: 'smart-ehr', redirectUris: ['https://b.test/cb'], scopes: ['user/Patient.rs'] })
			);

			expect((await withTenant(a, () => listClients())).map((k) => k.name)).toEqual(['App A']);
			expect((await withTenant(b, () => listClients())).map((k) => k.name)).toEqual(['App B']);

			// A client_id from A does not exist in B, even though it is valid in A.
			expect(await withTenant(b, () => getClient(kA.client.client_id))).toBeNull();
		});

		it('gir hver virksomhet sitt eget signeringsnøkkelsett', async () => {
			const nA = await withTenant(a, () => activeSigningKey());
			const nB = await withTenant(b, () => activeSigningKey());
			expect(nA.kid).not.toBe(nB.kid);

			const jwksA = await withTenant(a, () => jwks());
			const jwksB = await withTenant(b, () => jwks());
			expect(jwksA.keys.map((k) => k.kid)).toEqual([nA.kid]);
			expect(jwksB.keys.map((k) => k.kid)).toEqual([nB.kid]);
		});
	});

	describe('meldinger og oppgjør', () => {
		const recipient = toPart({
			herId: '8142519', name: 'Oslo universitetssykehus HF', type: 'sykehus',
			supportsMessages: ['HENVIS'], active: true
		});
		const message = (msgId: string) => ({
			message_type: 'HENVIS',
			msgId,
			patientId: null,
			recipientHer: '8142519',
			payloadXml: buildReferral({
				msgId,
				recipient,
				patient: { fnr: '13086510035', givenName: 'Anne', familyName: 'Bakken', birthDate: '1965-08-13', gender: 'K' as const },
				practitioner: { name: 'Ingrid Fastlege', hpr: '9144889' },
				problem: 'Behov for utredning.',
				hastegrad: 'ordinaer' as const
			}),
			createdOf: 'bruker-1'
		});

		it('holder meldingskøen adskilt', async () => {
			const iA = await withTenant(a, () => queueOut(message('msg-a'), actor));
			const iB = await withTenant(b, () => queueOut(message('msg-b'), actor));
			expect(iA.ok && iB.ok).toBe(true);

			expect((await withTenant(a, () => listMessages({}))).map((m) => m.msg_id)).toEqual(['msg-a']);
			expect((await withTenant(b, () => listMessages({}))).map((m) => m.msg_id)).toEqual(['msg-b']);
		});

		it('lar samme meldings-id finnes i to virksomheter', async () => {
			expect((await withTenant(a, () => queueOut(message('samme-id'), actor))).ok).toBe(true);
			expect((await withTenant(b, () => queueOut(message('samme-id'), actor))).ok).toBe(true);
		});

		it('holder regningskortene adskilt', async () => {
			const card = (patientId: string) => ({
				patientId,
				practitionerId: 'bruker-1',
				hprNumber: '9144889',
				date: new Date().toISOString().slice(0, 10),
				kontakttype: 'kontor' as const,
				tariffs: [{ tariff_code: '2ad', count: 1 }]
			});
			expect((await withTenant(a, () => createBillingCard(card('pasient-a'), actor))).ok).toBe(true);
			expect((await withTenant(b, () => createBillingCard(card('pasient-b'), actor))).ok).toBe(true);

			expect((await withTenant(a, () => listCard({}))).map((k) => k.patient_id)).toEqual(['pasient-a']);
			expect((await withTenant(b, () => listCard({}))).map((k) => k.patient_id)).toEqual(['pasient-b']);
		});
	});

	describe('ratebegrensning', () => {
		it('lar ikke én virksomhets trafikk stenge ute en annen', async () => {
			await withTenant(a, () => rateLimit('login:lege', 1, 60));
			expect((await withTenant(a, () => rateLimit('login:lege', 1, 60))).allowed).toBe(false);
			expect((await withTenant(b, () => rateLimit('login:lege', 1, 60))).allowed).toBe(true);
		});
	});

	describe('suspensjon', () => {
		it('avslutter sesjoner og trekker tilbake tokens umiddelbart', async () => {
			const user = await withTenant(b, () => createUser({ username: 'lege', name: 'Lege B', roles: ['lege'] }));
			await exec(
				"INSERT INTO user_session (id, user_id, token_hash, expires_at, amr) VALUES ($1,$2,'x', now() + interval '1 hour','pwd')",
				['sesjon-b', user.id]
			);
			await exec(
				`INSERT INTO oauth_token (id, tenant_id, kind, familie, token_hash, client_id, user_id, scope, expires_at)
				 VALUES ($1,$2,'access',$3,'h','app-b',$4,'user/Patient.rs', now() + interval '1 hour')`,
				['token-b', b.id, 'familie-b', user.id]
			);

			await withTenant(a, () => setTenantstatus(b.id, 'suspendert', actor));

			const session = await one<{ ended: boolean }>('SELECT ended FROM user_session WHERE id = $1', ['sesjon-b']);
			const token = await one<{ revoked: boolean }>('SELECT revoked FROM oauth_token WHERE id = $1', ['token-b']);
			expect(session?.ended).toBe(true);
			expect(token?.revoked).toBe(true);
			expect((await getTenant(b.id))?.status).toBe('suspendert');
		});

		it('rører ikke de andre virksomhetenes sesjoner', async () => {
			const iA = await withTenant(a, () => createUser({ username: 'lege', name: 'Lege A', roles: ['lege'] }));
			await exec(
				"INSERT INTO user_session (id, user_id, token_hash, expires_at, amr) VALUES ($1,$2,'y', now() + interval '1 hour','pwd')",
				['sesjon-a', iA.id]
			);

			await withTenant(a, () => setTenantstatus(b.id, 'suspendert', actor));

			const session = await one<{ ended: boolean }>('SELECT ended FROM user_session WHERE id = $1', ['sesjon-a']);
			expect(session?.ended).toBe(false);
		});
	});

	describe('plattformoversikten', () => {
		it('teller brukere og loggeinnslag per virksomhet, og krysser av mot HAPI', async () => {
			await withTenant(a, () => createUser({ username: 'lege', name: 'Lege A', roles: ['lege'] }));
			await withTenant(b, () => createUser({ username: 'lege', name: 'Lege B', roles: ['lege'] }));
			await withTenant(b, () => createUser({ username: 'sek', name: 'Sek B', roles: ['helsesekretaer'] }));
			await withTenant(b, () => log({ type: 'admin', subtype: 'b', action: 'E', outcome: '0' }, actor));

			const overview = await tenantOverview();
			const forB = overview.find((t) => t.id === 'legekontor-b');
			expect(forB?.countUsers).toBe(2);
			expect(forB?.countAuditEntry).toBeGreaterThanOrEqual(1);
			if (!fhir.isEkte) expect(forB?.partitionExists).toBe(true);

			const forA = overview.find((t) => t.id === 'standard');
			expect(forA?.countUsers).toBe(1);
		});

		it('melder fra når registeret peker på en partisjon HAPI ikke har', async () => {
			await exec(
				`INSERT INTO tenant (id, name, organisation_number, base_url, partition_id)
				 VALUES ('foreldrelos', 'Uten partisjon', '994598759', 'https://x.test', 4242)`
			);
			const overview = await tenantOverview();
			if (!fhir.isEkte) {
				expect(overview.find((t) => t.id === 'foreldrelos')?.partitionExists).toBe(false);
			}
		});
	});
});
