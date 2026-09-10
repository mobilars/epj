import { createHash } from 'node:crypto';
import { one, exec, query, transaction } from '../db';
import { currentTenant, requireTenant, PLATFORM_TENANT } from '../tenant/context';
import type { AuthContext } from '../authz/context';
import type { FhirResource } from '../fhir/types';

/**
 * Sikkerhetslogg.
 *
 * EPJ-standarden krever at alle oppslag i og endringer av journalen logges, at
 * loggen ikke kan endres, og at pasienten kan få innsyn i hvem som har lest
 * journalen. Hver rad lagres som en fullstendig FHIR R5 AuditEvent, og radene
 * lenkes med SHA-256 slik at fjerning eller endring av en rad brytes opp i
 * verifiseringen (`verifiserLoggkjede`).
 *
 * Databasen har i tillegg en trigger som avviser UPDATE og DELETE på tabellen.
 *
 * Loggen er delt per virksomhet, og hash-kjeden lenkes innenfor virksomheten.
 * Da kan hver virksomhet verifisere sin egen kjede uten å se de andres, og en
 * virksomhet kan ikke bryte en annens kjede ved å skrive et innslag.
 */

export type Action = 'C' | 'R' | 'U' | 'D' | 'E';
export type Outcome = '0' | '4' | '8' | '12';

export interface AuditEntry {
	type: string;
	subtype?: string;
	action: Action;
	outcome: Outcome;
	outcomeDescription?: string;
	patientId?: string | null;
	entityRef?: string | null;
	entityName?: string | null;
	purposeOfUse?: string;
	/** Ekstra felt som legges på AuditEvent.entity[].detail. */
	details?: Record<string, string | number | boolean | null | undefined>;
}

export interface AuditActor {
	userId: string | null;
	actorRef: string;
	name: string;
	role: string | null;
	clientId: string | null;
	ip: string;
	requestId: string;
}

export function actorFromContext(ctx: AuthContext): AuditActor {
	return {
		userId: ctx.userId,
		actorRef: ctx.actorRef,
		name: ctx.name,
		role: ctx.roles[0] ?? null,
		clientId: ctx.clientId,
		ip: ctx.ip,
		requestId: ctx.requestId
	};
}

const AUDIT_ACTION_TO_CODE: Record<Action, string> = {
	C: 'create', R: 'read', U: 'update', D: 'delete', E: 'execute'
};

function buildAuditEvent(entry: AuditEntry, actor: AuditActor, timestamp: string): FhirResource {
	const details = Object.entries(entry.details ?? {})
		.filter(([, v]) => v !== undefined && v !== null)
		.map(([k, v]) => ({ type: { text: k }, valueString: String(v) }));

	return {
		resourceType: 'AuditEvent',
		category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: entry.type }] }],
		code: { coding: [{ system: 'http://hl7.org/fhir/restful-interaction', code: entry.subtype ?? AUDIT_ACTION_TO_CODE[entry.action] }] },
		action: entry.action,
		recorded: timestamp,
		outcome: {
			code: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-outcome', code: entry.outcome },
			...(entry.outcomeDescription ? { detail: [{ text: entry.outcomeDescription }] } : {})
		},
		...(entry.purposeOfUse
			? { authorization: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: entry.purposeOfUse }] }] }
			: {}),
		agent: [
			{
				type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/extra-security-role-type', code: 'humanuser' }] },
				who: { reference: actor.actorRef, display: actor.name },
				requestor: true,
				...(actor.role ? { role: [{ text: actor.role }] } : {}),
				networkString: actor.ip
			},
			...(actor.clientId
				? [{
						type: { coding: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: '110150', display: 'Application' }] },
						who: { identifier: { value: actor.clientId } },
						requestor: false
					}]
				: [])
		],
		source: {
			site: { display: 'EPJ' },
			observer: { reference: 'Device/epj' },
			type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/security-source-type', code: '4', display: 'Application Server' }] }]
		},
		entity: [
			...(entry.patientId
				? [{ what: { reference: `Patient/${entry.patientId}` }, role: { coding: [{ code: '1', display: 'Patient' }] } }]
				: []),
			...(entry.entityRef
				? [{ what: { reference: entry.entityRef, display: entry.entityName ?? undefined }, detail: details.length ? details : undefined }]
				: details.length
					? [{ detail: details }]
					: [])
		],
		extension: [{ url: 'urn:epj:requestId', valueString: actor.requestId }]
	};
}

/**
 * Kanonisk JSON: nøkler sortert rekursivt.
 *
 * Innholdet lagres som `jsonb` for å kunne søkes i, men PostgreSQL normaliserer
 * nøkkelrekkefølgen i jsonb. Hashen må derfor beregnes over en form som er lik
 * både før lagring og etter at raden er lest tilbake - ellers ville
 * verifiseringen slått ut på helt uskadde rader.
 */
export function kanoniserJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(kanoniserJson).join(',')}]`;
	const par = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${JSON.stringify(k)}:${kanoniserJson(v)}`);
	return `{${par.join(',')}}`;
}

function computeHash(previousHash: string, kanonisk: string): string {
	return createHash('sha256').update(`${previousHash}\n${kanonisk}`).digest('hex');
}

/**
 * Skriver ett innslag. Kalles for hvert API-kall, hver innlogging og hver
 * integrasjonshendelse. Feiler aldri stille: klarer vi ikke å logge, skal
 * operasjonen avvises av kalleren.
 */
export async function log(
	entry: AuditEntry,
	actor: AuditActor,
	/** Virksomhet innslaget hører til. Utledes fra konteksten når den ikke oppgis. */
	tenantId?: string
): Promise<{ seq: number; hash: string }> {
	const tenant = tenantId ?? currentTenant()?.id ?? PLATFORM_TENANT;
	return transaction(async () => {
		// Lås tabellen kort for å garantere at kjeden bygges sekvensielt.
		await exec('LOCK TABLE audit_event IN EXCLUSIVE MODE');
		const previous = await one<{ hash: string }>(
			'SELECT hash FROM audit_event WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1',
			[tenant]
		);
		const previousHash = previous?.hash ?? 'genesis';
		const timestamp = new Date().toISOString();
		const event = buildAuditEvent(entry, actor, timestamp);
		const kanonisk = kanoniserJson(event);
		const hash = computeHash(previousHash, kanonisk);

		const row = await one<{ seq: number }>(
			`INSERT INTO audit_event
			 (tenant_id, recorded, type_code, subtype, action, outcome, outcome_desc, actor_user_id, actor_ref, actor_name,
			  actor_role, client_id, source_ip, patient_id, entity_ref, purpose_of_use, request_id, content, prev_hash, hash)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING seq`,
			[
				tenant, timestamp, entry.type, entry.subtype ?? null, entry.action, entry.outcome,
				entry.outcomeDescription ?? null, actor.userId, actor.actorRef, actor.name, actor.role,
				actor.clientId, actor.ip, entry.patientId ?? null, entry.entityRef ?? null,
				entry.purposeOfUse ?? null, actor.requestId, JSON.stringify(event), previousHash, hash
			]
		);
		return { seq: row?.seq ?? 0, hash };
	});
}

export interface LogFilter {
	patientId?: string;
	userId?: string;
	from?: string;
	to?: string;
	type?: string;
	onlyEmergencyAccess?: boolean;
	offset?: number;
	limit?: number;
}

export interface LogRow {
	seq: number;
	recorded: string;
	type_code: string;
	subtype: string | null;
	action: string;
	outcome: string;
	actor_name: string | null;
	actor_role: string | null;
	actor_user_id: string | null;
	client_id: string | null;
	source_ip: string | null;
	patient_id: string | null;
	entity_ref: string | null;
	purpose_of_use: string | null;
	request_id: string | null;
}

export async function getLog(filter: LogFilter): Promise<{ rows: LogRow[]; total: number }> {
	const conditions: string[] = ['tenant_id = $1'];
	const params: unknown[] = [requireTenant().id];
	const add = (sql: string, value: unknown) => {
		params.push(value);
		conditions.push(sql.replace('?', `$${params.length}`));
	};
	if (filter.patientId) add('patient_id = ?', filter.patientId);
	if (filter.userId) add('actor_user_id = ?', filter.userId);
	if (filter.from) add('recorded >= ?', filter.from);
	if (filter.to) add('recorded <= ?', filter.to);
	if (filter.type) add('type_code = ?', filter.type);
	if (filter.onlyEmergencyAccess) conditions.push("purpose_of_use = 'ETREAT'");

	const where = conditions.join(' AND ');
	const totalRow = await one<{ n: number }>(`SELECT COUNT(*)::bigint AS n FROM audit_event WHERE ${where}`, params);
	const limit = Math.min(filter.limit ?? 50, 500);
	const offset = filter.offset ?? 0;
	const rows = await query<LogRow>(
		`SELECT seq, recorded, type_code, subtype, action, outcome, actor_name, actor_role, actor_user_id,
		        client_id, source_ip, patient_id, entity_ref, purpose_of_use, request_id
		 FROM audit_event WHERE ${where} ORDER BY seq DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
		[...params, limit, offset]
	);
	return { rows, total: Number(totalRow?.n ?? 0) };
}

export async function getAuditEvent(seq: number): Promise<FhirResource | null> {
	const row = await one<{ content: FhirResource; seq: number }>(
		'SELECT seq, content FROM audit_event WHERE seq = $1 AND tenant_id = $2',
		[seq, requireTenant().id]
	);
	if (!row) return null;
	return { ...row.content, id: String(row.seq) };
}

export interface ChainResult {
	valid: boolean;
	checked: number;
	firstBrudd?: { seq: number; expected: string; funnet: string };
}

/**
 * Verifiserer hash-kjeden. Kjøres som periodisk kontroll og av personvernombudet.
 * Et brudd betyr at rader er endret eller fjernet utenom applikasjonen.
 */
export async function verifyLogChain(fromSeq = 0, max = 100_000): Promise<ChainResult> {
	const rows = await query<{ seq: number; content: FhirResource; prev_hash: string; hash: string }>(
		'SELECT seq, content, prev_hash, hash FROM audit_event WHERE tenant_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3',
		[requireTenant().id, fromSeq, max]
	);
	let previous: string | null = null;
	for (const row of rows) {
		if (previous !== null && row.prev_hash !== previous) {
			return { valid: false, checked: rows.length, firstBrudd: { seq: row.seq, expected: previous, funnet: row.prev_hash } };
		}
		const expected = computeHash(row.prev_hash, kanoniserJson(row.content));
		if (expected !== row.hash) {
			return { valid: false, checked: rows.length, firstBrudd: { seq: row.seq, expected, funnet: row.hash } };
		}
		previous = row.hash;
	}
	return { valid: true, checked: rows.length };
}

/** Nødrettsoppslag som ennå ikke er gjennomgått av ledelsen. */
export async function unreviewedEmergencyAccess(): Promise<LogRow[]> {
	return query<LogRow>(
		`SELECT a.seq, a.recorded, a.type_code, a.subtype, a.action, a.outcome, a.actor_name, a.actor_role,
		        a.actor_user_id, a.client_id, a.source_ip, a.patient_id, a.entity_ref, a.purpose_of_use, a.request_id
		 FROM audit_event a
		 WHERE a.tenant_id = $1 AND a.purpose_of_use = 'ETREAT'
		   AND NOT EXISTS (
		     SELECT 1 FROM break_glass b
		     WHERE b.tenant_id = a.tenant_id AND b.user_id = a.actor_user_id
		       AND b.patient_id = a.patient_id AND b.reviewed_at IS NOT NULL)
		 ORDER BY a.recorded DESC LIMIT 200`,
		[requireTenant().id]
	);
}
