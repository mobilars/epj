import { createHash } from 'node:crypto';
import { en, exec, query, transaction } from '../db';
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
 */

export type Handling = 'C' | 'R' | 'U' | 'D' | 'E';
export type Utfall = '0' | '4' | '8' | '12';

export interface AuditInnslag {
	type: string;
	subtype?: string;
	handling: Handling;
	utfall: Utfall;
	utfallBeskrivelse?: string;
	patientId?: string | null;
	entityRef?: string | null;
	entityNavn?: string | null;
	purposeOfUse?: string;
	/** Ekstra felt som legges på AuditEvent.entity[].detail. */
	detaljer?: Record<string, string | number | boolean | null | undefined>;
}

export interface AuditAktor {
	userId: string | null;
	actorRef: string;
	navn: string;
	rolle: string | null;
	clientId: string | null;
	ip: string;
	requestId: string;
}

export function aktorFraKontekst(ctx: AuthContext): AuditAktor {
	return {
		userId: ctx.userId,
		actorRef: ctx.actorRef,
		navn: ctx.navn,
		rolle: ctx.roller[0] ?? null,
		clientId: ctx.clientId,
		ip: ctx.ip,
		requestId: ctx.requestId
	};
}

const AUDIT_HANDLING_TIL_KODE: Record<Handling, string> = {
	C: 'create', R: 'read', U: 'update', D: 'delete', E: 'execute'
};

function byggAuditEvent(innslag: AuditInnslag, aktor: AuditAktor, tidspunkt: string): FhirResource {
	const detaljer = Object.entries(innslag.detaljer ?? {})
		.filter(([, v]) => v !== undefined && v !== null)
		.map(([k, v]) => ({ type: { text: k }, valueString: String(v) }));

	return {
		resourceType: 'AuditEvent',
		category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: innslag.type }] }],
		code: { coding: [{ system: 'http://hl7.org/fhir/restful-interaction', code: innslag.subtype ?? AUDIT_HANDLING_TIL_KODE[innslag.handling] }] },
		action: innslag.handling,
		recorded: tidspunkt,
		outcome: {
			code: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-outcome', code: innslag.utfall },
			...(innslag.utfallBeskrivelse ? { detail: [{ text: innslag.utfallBeskrivelse }] } : {})
		},
		...(innslag.purposeOfUse
			? { authorization: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: innslag.purposeOfUse }] }] }
			: {}),
		agent: [
			{
				type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/extra-security-role-type', code: 'humanuser' }] },
				who: { reference: aktor.actorRef, display: aktor.navn },
				requestor: true,
				...(aktor.rolle ? { role: [{ text: aktor.rolle }] } : {}),
				networkString: aktor.ip
			},
			...(aktor.clientId
				? [{
						type: { coding: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: '110150', display: 'Application' }] },
						who: { identifier: { value: aktor.clientId } },
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
			...(innslag.patientId
				? [{ what: { reference: `Patient/${innslag.patientId}` }, role: { coding: [{ code: '1', display: 'Patient' }] } }]
				: []),
			...(innslag.entityRef
				? [{ what: { reference: innslag.entityRef, display: innslag.entityNavn ?? undefined }, detail: detaljer.length ? detaljer : undefined }]
				: detaljer.length
					? [{ detail: detaljer }]
					: [])
		],
		extension: [{ url: 'urn:epj:requestId', valueString: aktor.requestId }]
	};
}

function beregnHash(forrigeHash: string, kanonisk: string): string {
	return createHash('sha256').update(`${forrigeHash}\n${kanonisk}`).digest('hex');
}

/**
 * Skriver ett innslag. Kalles for hvert API-kall, hver innlogging og hver
 * integrasjonshendelse. Feiler aldri stille: klarer vi ikke å logge, skal
 * operasjonen avvises av kalleren.
 */
export async function logg(innslag: AuditInnslag, aktor: AuditAktor): Promise<{ seq: number; hash: string }> {
	return transaction(async () => {
		// Lås tabellen kort for å garantere at kjeden bygges sekvensielt.
		await exec('LOCK TABLE audit_event IN EXCLUSIVE MODE');
		const forrige = await en<{ hash: string }>('SELECT hash FROM audit_event ORDER BY seq DESC LIMIT 1');
		const forrigeHash = forrige?.hash ?? 'genesis';
		const tidspunkt = new Date().toISOString();
		const event = byggAuditEvent(innslag, aktor, tidspunkt);
		const kanonisk = JSON.stringify(event);
		const hash = beregnHash(forrigeHash, kanonisk);

		const rad = await en<{ seq: number }>(
			`INSERT INTO audit_event
			 (recorded, type_code, subtype, action, outcome, outcome_desc, actor_user_id, actor_ref, actor_navn,
			  actor_rolle, client_id, source_ip, patient_id, entity_ref, purpose_of_use, request_id, content, prev_hash, hash)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING seq`,
			[
				tidspunkt, innslag.type, innslag.subtype ?? null, innslag.handling, innslag.utfall,
				innslag.utfallBeskrivelse ?? null, aktor.userId, aktor.actorRef, aktor.navn, aktor.rolle,
				aktor.clientId, aktor.ip, innslag.patientId ?? null, innslag.entityRef ?? null,
				innslag.purposeOfUse ?? null, aktor.requestId, kanonisk, forrigeHash, hash
			]
		);
		return { seq: rad?.seq ?? 0, hash };
	});
}

export interface LoggFilter {
	patientId?: string;
	userId?: string;
	fra?: string;
	til?: string;
	type?: string;
	kunNodrett?: boolean;
	offset?: number;
	limit?: number;
}

export interface LoggRad {
	seq: number;
	recorded: string;
	type_code: string;
	subtype: string | null;
	action: string;
	outcome: string;
	actor_navn: string | null;
	actor_rolle: string | null;
	actor_user_id: string | null;
	client_id: string | null;
	source_ip: string | null;
	patient_id: string | null;
	entity_ref: string | null;
	purpose_of_use: string | null;
	request_id: string | null;
}

export async function hentLogg(filter: LoggFilter): Promise<{ rader: LoggRad[]; total: number }> {
	const vilkar: string[] = ['true'];
	const params: unknown[] = [];
	const legg = (sql: string, verdi: unknown) => {
		params.push(verdi);
		vilkar.push(sql.replace('?', `$${params.length}`));
	};
	if (filter.patientId) legg('patient_id = ?', filter.patientId);
	if (filter.userId) legg('actor_user_id = ?', filter.userId);
	if (filter.fra) legg('recorded >= ?', filter.fra);
	if (filter.til) legg('recorded <= ?', filter.til);
	if (filter.type) legg('type_code = ?', filter.type);
	if (filter.kunNodrett) vilkar.push("purpose_of_use = 'ETREAT'");

	const where = vilkar.join(' AND ');
	const totalRad = await en<{ n: number }>(`SELECT COUNT(*)::bigint AS n FROM audit_event WHERE ${where}`, params);
	const limit = Math.min(filter.limit ?? 50, 500);
	const offset = filter.offset ?? 0;
	const rader = await query<LoggRad>(
		`SELECT seq, recorded, type_code, subtype, action, outcome, actor_navn, actor_rolle, actor_user_id,
		        client_id, source_ip, patient_id, entity_ref, purpose_of_use, request_id
		 FROM audit_event WHERE ${where} ORDER BY seq DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
		[...params, limit, offset]
	);
	return { rader, total: Number(totalRad?.n ?? 0) };
}

export async function hentAuditEvent(seq: number): Promise<FhirResource | null> {
	const rad = await en<{ content: FhirResource; seq: number }>('SELECT seq, content FROM audit_event WHERE seq = $1', [seq]);
	if (!rad) return null;
	return { ...rad.content, id: String(rad.seq) };
}

export interface KjedeResultat {
	gyldig: boolean;
	kontrollerte: number;
	forsteBrudd?: { seq: number; forventet: string; funnet: string };
}

/**
 * Verifiserer hash-kjeden. Kjøres som periodisk kontroll og av personvernombudet.
 * Et brudd betyr at rader er endret eller fjernet utenom applikasjonen.
 */
export async function verifiserLoggkjede(fraSeq = 0, maks = 100_000): Promise<KjedeResultat> {
	const rader = await query<{ seq: number; content: FhirResource; prev_hash: string; hash: string }>(
		'SELECT seq, content, prev_hash, hash FROM audit_event WHERE seq > $1 ORDER BY seq ASC LIMIT $2',
		[fraSeq, maks]
	);
	let forrige: string | null = null;
	for (const rad of rader) {
		if (forrige !== null && rad.prev_hash !== forrige) {
			return { gyldig: false, kontrollerte: rader.length, forsteBrudd: { seq: rad.seq, forventet: forrige, funnet: rad.prev_hash } };
		}
		const forventet = beregnHash(rad.prev_hash, JSON.stringify(rad.content));
		if (forventet !== rad.hash) {
			return { gyldig: false, kontrollerte: rader.length, forsteBrudd: { seq: rad.seq, forventet, funnet: rad.hash } };
		}
		forrige = rad.hash;
	}
	return { gyldig: true, kontrollerte: rader.length };
}

/** Nødrettsoppslag som ennå ikke er gjennomgått av ledelsen. */
export async function ugjennomgattNodrett(): Promise<LoggRad[]> {
	return query<LoggRad>(
		`SELECT a.seq, a.recorded, a.type_code, a.subtype, a.action, a.outcome, a.actor_navn, a.actor_rolle,
		        a.actor_user_id, a.client_id, a.source_ip, a.patient_id, a.entity_ref, a.purpose_of_use, a.request_id
		 FROM audit_event a
		 WHERE a.purpose_of_use = 'ETREAT'
		   AND NOT EXISTS (
		     SELECT 1 FROM break_glass b
		     WHERE b.user_id = a.actor_user_id AND b.patient_id = a.patient_id AND b.gjennomgatt_tid IS NOT NULL)
		 ORDER BY a.recorded DESC LIMIT 200`
	);
}
