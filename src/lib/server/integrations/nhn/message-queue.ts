import { one, exec, withLock, query, transaction } from '../../db';
import { requireTenant, withTenant } from '../../tenant/context';
import { getTenant } from '../../tenant/tenant';
import { config } from '../../config';
import { newId } from '../../util/ids';
import { log, type AuditActor } from '../../audit';
import { fhirClient } from '../../fhir/client';
import type { FhirResource } from '../../fhir/types';
import { SYSTEM } from '../../fhir/codesystems';
import { buildApprec, readApprec, readMsgHead, APPREC_ERROR, type ApprecStatus } from './apprec';
import { getRecipient, canReceive } from './address-registry';

/**
 * Message queue towards the NHN message server.
 *
 * Outgoing messages are queued, sent, and then wait for an application receipt.
 * A message does not count as delivered until an AppRec with status 1 or 2 has
 * arrived - that distinction is what stops a referral going missing without
 * anyone noticing.
 *
 * Incoming messages are stored, answered with an AppRec, and mirrored as FHIR
 * resources in the record (Communication for dialogue messages,
 * DocumentReference for discharge summaries, ServiceRequest for referrals).
 */

export type Meldingsstatus =
	| 'kladd' | 'kø' | 'sendt' | 'kvittert' | 'avvist' | 'feilet' | 'mottatt' | 'behandlet';

export interface Message {
	id: string;
	direction: 'inn' | 'ut';
	message_type: string;
	msg_id: string;
	ref_msg_id: string | null;
	patient_id: string | null;
	sender_her_id: string | null;
	recipient_her_id: string | null;
	recipient_name: string | null;
	status: Meldingsstatus;
	status_detail: string | null;
	apprec_status: string | null;
	attempts: number;
	next_attempt: string | null;
	fhir_ref: string | null;
	created_at: string;
	updated_at: string;
	created_by: string | null;
}

const FIELD = `id, direction, message_type, msg_id, ref_msg_id, patient_id, sender_her_id, recipient_her_id,
	recipient_name, status, status_detail, apprec_status, attempts, next_attempt, fhir_ref, created_at, updated_at, created_by`;

export interface QueueIn {
	message_type: string;
	msgId: string;
	patientId: string | null;
	recipientHer: string;
	payloadXml: string;
	createdOf: string;
	refMsgId?: string;
}

/** Puts a fully built message on the outgoing queue. */
export async function queueOut(inValue: QueueIn, actor: AuditActor): Promise<{ ok: boolean; id?: string; error?: string }> {
	const check = await canReceive(inValue.recipientHer, inValue.message_type);
	if (!check.ok) {
		await log(
			{ type: 'integrasjon', subtype: 'melding:avvist-for-sending', action: 'E', outcome: '4', outcomeDescription: check.reason, patientId: inValue.patientId },
			actor
		);
		return { ok: false, error: check.reason };
	}
	const recipient = await getRecipient(inValue.recipientHer);
	const tenant = requireTenant();
	const id = newId();
	await exec(
		`INSERT INTO message (id, tenant_id, direction, message_type, msg_id, ref_msg_id, patient_id, sender_her_id, recipient_her_id,
			recipient_name, status, payload_xml, created_by, next_attempt)
		 VALUES ($1,$11,'ut',$2,$3,$4,$5,$6,$7,$8,'kø',$9,$10, now())`,
		[
			id, inValue.message_type, inValue.msgId, inValue.refMsgId ?? null, inValue.patientId,
			tenant.her_id ?? config.organisation.herId, inValue.recipientHer, recipient?.name ?? null,
			inValue.payloadXml, inValue.createdOf, tenant.id
		]
	);
	await log(
		{
			type: 'integrasjon', subtype: `melding:kø:${inValue.message_type}`, action: 'C', outcome: '0',
			patientId: inValue.patientId, entityRef: `urn:melding:${inValue.msgId}`,
			details: { recipient: recipient?.name ?? inValue.recipientHer }, purposeOfUse: 'TREAT'
		},
		actor
	);
	return { ok: true, id };
}

const MAX_ATTEMPT = 6;

/** Stable numeric value of the organisation id, used to separate advisory locks. */
function hashToNumber(id: string): number {
	let h = 0;
	for (const tegn of id) h = (h * 31 + tegn.charCodeAt(0)) % 100_000;
	return h;
}

/** Exponential backoff: 1, 2, 4, 8, 16, 32 minutes. */
function nextAttempt(attempts: number): string {
	return `${Math.min(2 ** attempts, 60)} minutes`;
}

/**
 * Sends everything ready in the queue. Protected by an advisory lock so several
 * app instances do not send the same message twice.
 */
export async function sendQueue(): Promise<{ sent_at: number; failed: number }> {
	const tenantId = requireTenant().id;
	// The lock is per organisation, so slow sending at one does not stall the others.
	const result = await withLock(918_271 + hashToNumber(tenantId), async () => {
		const klare = await query<{ id: string; msg_id: string; message_type: string; recipient_her_id: string; payload_xml: string; attempts: number; patient_id: string | null }>(
			`SELECT id, msg_id, message_type, recipient_her_id, payload_xml, attempts, patient_id FROM message
			 WHERE tenant_id = $1 AND direction = 'ut' AND status IN ('kø','feilet')
			   AND (next_attempt IS NULL OR next_attempt <= now())
			 ORDER BY created_at LIMIT 50`,
			[tenantId]
		);
		let sent_at = 0;
		let failed = 0;
		for (const m of klare) {
			try {
				await transport(m.recipient_her_id, m.payload_xml, m.message_type);
				await exec("UPDATE message SET status = 'sendt', updated_at = now(), status_detail = NULL WHERE id = $1 AND tenant_id = $2", [m.id, tenantId]);
				sent_at++;
			} catch (err) {
				const message = (err as Error).message;
				const attempts = m.attempts + 1;
				const oppgitt = attempts >= MAX_ATTEMPT;
				await exec(
					`UPDATE message SET status = $2, attempts = $3, status_detail = $4,
					 next_attempt = CASE WHEN $5 THEN NULL ELSE now() + $6::interval END, updated_at = now()
					 WHERE id = $1 AND tenant_id = $7`,
					[m.id, oppgitt ? 'avvist' : 'feilet', attempts, message, oppgitt, nextAttempt(attempts), tenantId]
				);
				failed++;
			}
		}
		return { sent_at, failed };
	});
	return result ?? { sent_at: 0, failed: 0 };
}

/**
 * The transport layer towards the message server.
 *
 * In `live` mode the message is placed on the NHN message server (EDI 2.0) over
 * mutually authenticated TLS. In `mock` mode it is delivered locally, so the
 * send and receipt flow can be exercised without a health network connection.
 */
async function transport(recipientHer: string, xml: string, message_type: string): Promise<void> {
	if (config.integrations.modus === 'mock') {
		await mockLevering(recipientHer, xml, message_type);
		return;
	}
	const url = config.integrations.nhn.meldingstjenerUrl;
	if (!url) throw new Error('Meldingstjeneren er ikke konfigurert (EPJ_NHN_MELDINGSTJENER_URL)');
	const response = await fetch(`${url}/messages`, {
		method: 'POST',
		headers: {
			'content-type': 'application/xml',
			'x-receiver-her-id': recipientHer,
			'x-sender-her-id': config.integrations.nhn.herId
		},
		body: xml,
		signal: AbortSignal.timeout(30_000)
	});
	if (!response.ok) throw new Error(`Meldingstjeneren svarte ${response.status}: ${(await response.text()).slice(0, 200)}`);
}

/** Simulates the recipient reading the message and acknowledging it. */
async function mockLevering(recipientHer: string, xml: string, message_type: string): Promise<void> {
	const read = readMsgHead(xml);
	if (!read) throw new Error('Meldingen kunne ikke leses som hodemelding');
	const recipient = await getRecipient(recipientHer);
	// The receipt comes "back" after a short while; here it is recorded directly.
	setTimeout(() => {
		void registerApprec(read.msgId, '1', [], recipient?.name ?? recipientHer).catch(() => undefined);
	}, 50);
}

/** Records a received application receipt against the outgoing message. */
export async function registerApprec(
	refMsgId: string,
	status: ApprecStatus,
	error: { code: string; text: string }[],
	senderName: string
): Promise<boolean> {
	const n = await exec(
		`UPDATE message SET apprec_status = $2, status = $3, status_detail = $4, updated_at = now()
		 WHERE direction = 'ut' AND msg_id = $1 AND tenant_id = $5`,
		[
			refMsgId,
			status,
			status === '3' ? 'avvist' : 'kvittert',
			error.length ? `${senderName}: ${error.map((f) => `${f.code} ${f.text}`).join('; ')}` : null,
			requireTenant().id
		]
	);
	return n > 0;
}

// ---------------------------------------------------------------------------
// Innkommende meldinger
// ---------------------------------------------------------------------------

export interface MottakResult {
	ok: boolean;
	messageId?: string;
	apprec?: string;
	apprecStatus: ApprecStatus;
	error: { code: string; text: string }[];
}

/**
 * Accepts a message, stores it, links it to a patient and builds an AppRec.
 * The message is mirrored as a FHIR resource so it becomes part of the record
 * and available to SMART apps through /fhir.
 */
export async function receiveMessage(xml: string, actor: AuditActor): Promise<MottakResult> {
	const apprecError: { code: string; text: string }[] = [];

	// An application receipt for something we sent.
	const receipt = readApprec(xml);
	if (receipt) {
		await registerApprec(receipt.refMsgId, receipt.status, receipt.error, 'mottaker');
		await log(
			{
				type: 'integrasjon', subtype: 'melding:apprec', action: 'U', outcome: receipt.status === '3' ? '4' : '0',
				entityRef: `urn:melding:${receipt.refMsgId}`,
				outcomeDescription: receipt.error.map((f) => f.text).join('; ') || undefined
			},
			actor
		);
		return { ok: true, apprecStatus: receipt.status, error: receipt.error };
	}

	const read = readMsgHead(xml);
	if (!read) {
		return { ok: false, apprecStatus: '3', error: [APPREC_ERROR.XML_ERROR] };
	}

	const duplikat = await one<{ id: string }>(
		"SELECT id FROM message WHERE direction = 'inn' AND msg_id = $1 AND tenant_id = $2",
		[read.msgId, requireTenant().id]
	);
	if (duplikat) {
		return {
			ok: true,
			messageId: duplikat.id,
			apprecStatus: '2',
			error: [APPREC_ERROR.DUPLIKAT],
			apprec: buildApprec({
				refMsgId: read.msgId, refGenDate: read.genDate, refType: read.type, status: '2',
				error: [APPREC_ERROR.DUPLIKAT], originalSender: read.sender
			})
		};
	}

	let patientId: string | null = null;
	if (read.patientFnr) {
		patientId = await findPatientOnFnr(read.patientFnr);
		if (!patientId) apprecError.push(APPREC_ERROR.UNKNOWN_PATIENT);
	} else {
		apprecError.push(APPREC_ERROR.MISSING_FNR);
	}

	const status: ApprecStatus = apprecError.length === 0 ? '1' : '2';
	const id = newId();

	await transaction(async () => {
		await exec(
			`INSERT INTO message (id, tenant_id, direction, message_type, msg_id, patient_id, sender_her_id, recipient_her_id,
				recipient_name, status, payload_xml, apprec_status)
			 VALUES ($1,$10,'inn',$2,$3,$4,$5,$6,$7,'mottatt',$8,$9)`,
			[id, read.type.code, read.msgId, patientId, read.sender.her,
			 requireTenant().her_id ?? config.organisation.herId, read.sender.name, xml, status, requireTenant().id]
		);
	});

	if (patientId) {
		const fhirRef = await mirrorToFhir(read, patientId, xml);
		if (fhirRef) await exec('UPDATE message SET fhir_ref = $2 WHERE id = $1 AND tenant_id = $3', [id, fhirRef, requireTenant().id]);
	}

	await log(
		{
			type: 'integrasjon', subtype: `melding:mottatt:${read.type.code}`, action: 'C', outcome: status === '1' ? '0' : '4',
			patientId, entityRef: `urn:melding:${read.msgId}`,
			outcomeDescription: apprecError.map((f) => f.text).join('; ') || undefined,
			details: { sender: read.sender.name }
		},
		actor
	);

	return {
		ok: true,
		messageId: id,
		apprecStatus: status,
		error: apprecError,
		apprec: buildApprec({
			refMsgId: read.msgId, refGenDate: read.genDate, refType: read.type,
			status, error: apprecError.length ? apprecError : undefined, originalSender: read.sender
		})
	};
}

async function findPatientOnFnr(fnr: string): Promise<string | null> {
	try {
		const bundle = await fhirClient.search('Patient', new URLSearchParams({ identifier: `${SYSTEM.FNR}|${fnr}`, _count: '2' }));
		const match = bundle.entry?.[0]?.resource;
		return (match?.id as string) ?? null;
	} catch {
		return null;
	}
}

/** Builds the FHIR representation of an incoming message. */
async function mirrorToFhir(
	read: NonNullable<ReturnType<typeof readMsgHead>>,
	patientId: string,
	xml: string
): Promise<string | null> {
	const shared = {
		subject: { reference: `Patient/${patientId}` },
		identifier: [{ system: 'urn:oid:2.16.578.1.12.4.1.1.8279', value: read.msgId }]
	};

	let resource: FhirResource;
	switch (read.type.code) {
		case 'EPIKRISE':
		case 'SVAR_LAB':
			resource = {
				resourceType: 'DocumentReference',
				status: 'current',
				type: { coding: [{ system: SYSTEM.MESSAGETYPE, code: read.type.code, display: read.type.name }] },
				category: [{ text: read.type.code === 'EPIKRISE' ? 'Epikrise' : 'Prøvesvar' }],
				date: read.genDate,
				author: [{ display: read.sender.name }],
				content: [{ attachment: { contentType: 'text/xml', data: Buffer.from(xml).toString('base64'), title: read.type.name } }],
				...shared
			};
			break;
		case 'HENVIS':
			resource = {
				resourceType: 'ServiceRequest',
				status: 'active',
				intent: 'order',
				code: { concept: { coding: [{ system: SYSTEM.MESSAGETYPE, code: 'HENVIS', display: 'Henvisning' }] } },
				authoredOn: read.genDate,
				requester: { display: read.sender.name },
				...shared
			};
			break;
		default:
			resource = {
				resourceType: 'Communication',
				status: 'completed',
				category: [{ coding: [{ system: SYSTEM.MESSAGETYPE, code: read.type.code, display: read.type.name }] }],
				sent: read.genDate,
				received: new Date().toISOString(),
				sender: { display: read.sender.name },
				payload: [{ contentAttachment: { contentType: 'text/xml', data: Buffer.from(xml).toString('base64') } }],
				...shared
			};
	}

	try {
		const response = await fhirClient.create(resource);
		return `${resource.resourceType}/${response.resource.id}`;
	} catch (err) {
		console.error('[nhn] klarte ikke å speile melding til FHIR', err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Oppslag
// ---------------------------------------------------------------------------

export async function listMessages(filter: {
	direction?: 'inn' | 'ut';
	status?: Meldingsstatus;
	patientId?: string;
	limit?: number;
}): Promise<Message[]> {
	const conditions: string[] = ['tenant_id = $1'];
	const params: unknown[] = [requireTenant().id];
	if (filter.direction) { params.push(filter.direction); conditions.push(`direction = $${params.length}`); }
	if (filter.status) { params.push(filter.status); conditions.push(`status = $${params.length}`); }
	if (filter.patientId) { params.push(filter.patientId); conditions.push(`patient_id = $${params.length}`); }
	params.push(Math.min(filter.limit ?? 100, 500));
	return query<Message>(
		`SELECT ${FIELD} FROM message WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
		params
	);
}

export async function getMessage(id: string): Promise<(Message & { payload_xml: string | null }) | null> {
	return one<Message & { payload_xml: string | null }>(
		`SELECT ${FIELD}, payload_xml FROM message WHERE id = $1 AND tenant_id = $2`,
		[id, requireTenant().id]
	);
}

export async function markerProcessed(id: string, actor: AuditActor): Promise<void> {
	const message = await getMessage(id);
	await exec("UPDATE message SET status = 'behandlet', updated_at = now() WHERE id = $1 AND tenant_id = $2", [id, requireTenant().id]);
	await log(
		{ type: 'integrasjon', subtype: 'melding:behandlet', action: 'U', outcome: '0', patientId: message?.patient_id ?? null, entityRef: `urn:melding:${message?.msg_id}` },
		actor
	);
}

/** Messages that were sent but are missing an application receipt. */
export async function pendingKvitteringer(eldreEnnMinutter = 60): Promise<Message[]> {
	return query<Message>(
		`SELECT ${FIELD} FROM message
		 WHERE tenant_id = $2 AND direction = 'ut' AND status = 'sendt' AND apprec_status IS NULL
		   AND updated_at < now() - ($1 || ' minutes')::interval
		 ORDER BY updated_at LIMIT 200`,
		[String(eldreEnnMinutter), requireTenant().id]
	);
}
