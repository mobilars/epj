import { one, exec, query, transaction } from '../db';
import { withTenant, PLATFORM_TENANT, type Tenant } from './context';
import { config } from '../config';
import { createPartition, listPartitions } from './partition';
import { log, type AuditActor } from '../audit';
import { validNorwegianNationalId, validOrganisationNumber } from '../fhir/codesystems';
import { createUser } from '../auth/users';
import { newToken } from '../util/ids';

/**
 * Organisation registry.
 *
 * This is the only module that reads and writes across organisations. It is
 * used only by the lookup that derives the organisation from the hostname, and
 * by platform administration.
 */

const FIELD = `id, name, organisation_number, her_id, municipality_code, hostname, base_url,
	partition_id, status, note, created_at`;

/**
 * Keeps the default organisation in step with the configuration.
 *
 * The migration inserts it with a placeholder address, since SQL cannot read
 * environment variables. Without this, an installation on a different address
 * than the development environment would get the wrong `issuer` in its OAuth
 * metadata, and the wrong `iss` at app launch - which the `aud` check rejects.
 *
 * Syncing stops the moment somebody edits the organisation in platform
 * administration: `updated_at` is then newer than `created_at`, and the
 * configuration must not override a deliberate choice.
 *
 * Runs at startup, after the migrations.
 */
export async function ensureDefaultOrganisation(): Promise<void> {
	const issuer = config.baseUrl.replace(/\/$/, '');
	await exec(
		`UPDATE tenant SET
			name = $2, organisation_number = $3, her_id = $4, municipality_code = $5, base_url = $6
		 WHERE id = $1 AND updated_at = created_at
		   AND (name, organisation_number, her_id, municipality_code, base_url)
		       IS DISTINCT FROM ($2, $3, $4, $5, $6)`,
		[
			config.tenant.defaultValue,
			config.organisation.name,
			config.organisation.organisation_number,
			config.organisation.herId,
			config.organisation.municipality_code,
			issuer
		]
	);
	// Platform administration is reached on its own hostname when one is set.
	// The port is kept, so a test environment on another port works.
	let platformUrl = issuer;
	if (config.tenant.platformHostname) {
		const address = new URL(issuer);
		address.hostname = config.tenant.platformHostname;
		platformUrl = address.origin;
	}
	await exec(
		`UPDATE tenant SET base_url = $2, hostname = $3
		 WHERE id = $1 AND updated_at = created_at
		   AND (base_url, hostname) IS DISTINCT FROM ($2, $3)`,
		[PLATFORM_TENANT, platformUrl, config.tenant.platformHostname || null]
	);

	// The default organisation needs its partition in HAPI just as organisations
	// created from platform administration do. The migration cannot create it -
	// it lives in another service.
	//
	// Best effort: if the FHIR server is down at startup, the record should not
	// refuse to start. The discrepancy shows in the platform overview, and
	// corrects itself at the next startup once the server is back.
	if (config.fhirServer.multitenant) {
		const defaultValue = await getTenant(config.tenant.defaultValue);
		if (defaultValue?.partition_id) {
			const partitions = await listPartitions();
			if (partitions.ok && !partitions.partitions.some((p) => p.name === defaultValue.id)) {
				const response = await createPartition(defaultValue.partition_id, defaultValue.id, defaultValue.name);
				if (!response.ok) {
					console.warn(`[oppstart] klarte ikke å opprette partisjonen «${defaultValue.id}»: ${response.error}`);
				}
			}
		}
	}
}

export async function getTenant(id: string): Promise<Tenant | null> {
	return one<Tenant>(`SELECT ${FIELD} FROM tenant WHERE id = $1`, [id]);
}

export async function getTenantOnHostname(hostname: string): Promise<Tenant | null> {
	return one<Tenant>(`SELECT ${FIELD} FROM tenant WHERE lower(hostname) = lower($1)`, [hostname]);
}

export async function listTenanter(): Promise<Tenant[]> {
	return query<Tenant>(`SELECT ${FIELD} FROM tenant ORDER BY name`);
}

export interface NewTenant {
	id: string;
	name: string;
	organisation_number: string;
	herId?: string;
	municipality_code?: string;
	hostname?: string;
	baseUrl: string;
	note?: string;
	/** First administrator user in the organisation. */
	adminUsername?: string;
	adminName?: string;
	/** Fødselsnummer, so the administrator can sign in with HelseID. */
	adminNationalId?: string;
	createdOf?: string;
}

export type CreateResult =
	| { ok: true; tenant: Tenant; adminUsername?: string; temporaryPassword?: string }
	| { ok: false; error: string };

/**
 * Creates an organisation.
 *
 * The order matters: the partition in HAPI is created *before* the row is
 * stored. If the partition fails we end up with no organisation pointing at a
 * partition that does not exist - and an organisation without a working
 * clinical store is worse than no organisation.
 */
export async function createTenant(inValue: NewTenant, actor: AuditActor): Promise<CreateResult> {
	if (!/^[a-z][a-z0-9-]{1,30}$/.test(inValue.id)) {
		return { ok: false, error: 'Maskinnavnet må starte med en bokstav og bare inneholde små bokstaver, tall og bindestrek.' };
	}
	if (inValue.adminNationalId && !validNorwegianNationalId(inValue.adminNationalId)) {
		return { ok: false, error: 'Ugyldig fødselsnummer for systemansvarlig (kontrollsiffer stemmer ikke).' };
	}
	if (!validOrganisationNumber(inValue.organisation_number)) {
		return { ok: false, error: 'Ugyldig organisasjonsnummer (mod11-kontroll feilet).' };
	}
	if (await getTenant(inValue.id)) {
		return { ok: false, error: `Virksomheten «${inValue.id}» finnes allerede.` };
	}
	if (inValue.hostname && (await getTenantOnHostname(inValue.hostname))) {
		return { ok: false, error: `Vertsnavnet ${inValue.hostname} er allerede i bruk.` };
	}
	try {
		new URL(inValue.baseUrl);
	} catch {
		return { ok: false, error: 'Ugyldig adresse (base_url).' };
	}

	// Partition id is an integer in HAPI. System organisations have NULL and do
	// not count, so the numbering does not run away.
	const next = await one<{ n: number }>('SELECT COALESCE(MAX(partition_id), 0) + 1 AS n FROM tenant');
	const partitionId = next?.n ?? 1;
	if (partitionId > 2147483646) {
		return { ok: false, error: 'Partisjonsnummereringen er oppbrukt.' };
	}

	const partition = await createPartition(partitionId, inValue.id, inValue.name);
	if (!partition.ok) {
		return { ok: false, error: `Klarte ikke å opprette FHIR-partisjon: ${partition.error}` };
	}

	const tenant = await transaction(async () => {
		await exec(
			`INSERT INTO tenant (id, name, organisation_number, her_id, municipality_code, hostname,
				base_url, partition_id, note, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			[
				inValue.id, inValue.name, inValue.organisation_number, inValue.herId ?? null, inValue.municipality_code ?? null,
				inValue.hostname ?? null, inValue.baseUrl.replace(/\/$/, ''), partitionId,
				inValue.note ?? null, actor.userId
			]
		);
		return (await getTenant(inValue.id)) as Tenant;
	});

	let adminUsername: string | undefined;
	let temporaryPassword: string | undefined;
	if (inValue.adminUsername) {
		temporaryPassword = newToken(9);
		// The user is created in the new organisation's context.
		await withTenant(tenant, async () => {
			const user = await createUser({
				username: inValue.adminUsername as string,
				name: inValue.adminName ?? 'Systemansvarlig',
				password: temporaryPassword,
				roles: ['systemansvarlig'],
				createdOf: actor.userId ?? undefined
			});
			// With the national identity number recorded, the administrator's first
			// HelseID sign-in attaches to this account and inherits the role. Without
			// it they would arrive as a new user with no access, and the temporary
			// password would be the only way in.
			if (inValue.adminNationalId) {
				await exec('UPDATE user_account SET national_id = $2 WHERE id = $1', [user.id, inValue.adminNationalId]);
			}
		});
		adminUsername = inValue.adminUsername;
	}

	await log(
		{
			type: 'admin', subtype: 'tenant:opprettet', action: 'C', outcome: '0',
			entityRef: `Organization/${tenant.id}`,
			details: { name: tenant.name, orgnr: tenant.organisation_number, partition: partitionId }
		},
		actor,
		tenant.id
	);

	return { ok: true, tenant, adminUsername, temporaryPassword };
}

export async function setTenantstatus(
	id: string,
	status: 'aktiv' | 'suspendert' | 'avviklet',
	actor: AuditActor
): Promise<void> {
	await transaction(async () => {
		await exec('UPDATE tenant SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
		if (status !== 'aktiv') {
			// Suspension must take effect immediately, not at the next expiry.
			await exec('UPDATE user_session SET ended = true WHERE user_id IN (SELECT id FROM user_account WHERE tenant_id = $1)', [id]);
			await exec(
				"UPDATE oauth_token SET revoked = true, revoked_reason = $2 WHERE tenant_id = $1 AND revoked = false",
				[id, `virksomhet ${status}`]
			);
		}
	});
	await log(
		{ type: 'admin', subtype: 'tenant:status', action: 'U', outcome: '0', entityRef: `Organization/${id}`, details: { status } },
		actor,
		id
	);
}

export async function updateTenant(
	id: string,
	change: { name?: string; hostname?: string | null; baseUrl?: string; herId?: string | null; municipality_code?: string | null; note?: string | null },
	actor: AuditActor
): Promise<{ ok: boolean; error?: string }> {
	if (change.hostname) {
		const annen = await getTenantOnHostname(change.hostname);
		if (annen && annen.id !== id) return { ok: false, error: 'Vertsnavnet er allerede i bruk.' };
	}
	await exec(
		`UPDATE tenant SET
			name = COALESCE($2, name),
			hostname = COALESCE($3, hostname),
			base_url = COALESCE($4, base_url),
			her_id = COALESCE($5, her_id),
			municipality_code = COALESCE($6, municipality_code),
			note = COALESCE($7, note),
			updated_at = now()
		 WHERE id = $1`,
		[id, change.name ?? null, change.hostname ?? null, change.baseUrl ?? null,
		 change.herId ?? null, change.municipality_code ?? null, change.note ?? null]
	);
	await log(
		{ type: 'admin', subtype: 'tenant:endret', action: 'U', outcome: '0', entityRef: `Organization/${id}` },
		actor,
		id
	);
	return { ok: true };
}

export interface TenantOverview extends Tenant {
	countUsers: number;
	countAuditEntry: number;
	lastAktivitet: string | null;
	partitionExists: boolean | null;
}

/** Overview for platform administration, checked against HAPI. */
export async function tenantOverview(): Promise<TenantOverview[]> {
	const tenanter = await listTenanter();
	const partitions = await listPartitions();

	const number = await query<{ tenant_id: string; users: number; entry: number; last: string | null }>(
		`SELECT t.id AS tenant_id,
			(SELECT count(*)::int FROM user_account u WHERE u.tenant_id = t.id) AS users,
			(SELECT count(*)::int FROM audit_event a WHERE a.tenant_id = t.id) AS entry,
			(SELECT max(a.recorded)::text FROM audit_event a WHERE a.tenant_id = t.id) AS last
		 FROM tenant t`
	);
	const map = new Map(number.map((r) => [r.tenant_id, r]));

	return tenanter.map((t) => ({
		...t,
		countUsers: map.get(t.id)?.users ?? 0,
		countAuditEntry: map.get(t.id)?.entry ?? 0,
		lastAktivitet: map.get(t.id)?.last ?? null,
	// System organisations have no partition, and must not be reported as a discrepancy.
		partitionExists:
			t.partition_id === null ? null : partitions.ok ? partitions.partitions.some((p) => p.name === t.id) : null
	}));
}
