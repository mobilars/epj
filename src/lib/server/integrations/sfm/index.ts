import { one, exec, query } from '../../db';
import { requireTenant } from '../../tenant/context';
import { config } from '../../config';
import { newId } from '../../util/ids';
import { SYSTEM } from '../../fhir/codesystems';
import type { FhirResource } from '../../fhir/types';
import { fhirClient } from '../../fhir/client';
import { log, type AuditActor } from '../../audit';
import { mockSfm } from './mock';

/**
 * Sentral forskrivningsmodul (SFM), the national prescribing module.
 *
 * This file is the record's own prescribing screen, and it only ever talks to a
 * local simulator. It exists to show the flow: nothing here reaches NHN.
 *
 * The real integration is SFM Full, where SFM's own screen runs in a frame: see
 * `session-gateway.ts` and docs/sfm.md. SFM Basis, which is what a screen like
 * this one would need, is meant for major vendors with their own medication
 * module, and is approved through the e-resept value chain.
 */

export type SfmOperation =
	| 'hentLegemiddelliste'
	| 'forskriv'
	| 'fornye'
	| 'seponer'
	| 'tilbakekall'
	| 'hentUtleveringer';

export interface SfmResponse<T = unknown> {
	ok: boolean;
	data?: T;
	error?: string;
	prescriptionId?: string;
}

export interface MedicationList {
	patientId: string;
	updated_at: string;
	/** Source: `sfm` (the patient's medication list) or `lokal` (record only). */
	source: 'sfm' | 'lokal';
	medications: MedicationEntry[];
	/** Discrepancy between PLL and the local medication list, for a doctor to reconcile. */
	deviation: string[];
}

export interface MedicationEntry {
	prescriptionId?: string;
	name: string;
	atc?: string;
	form?: string;
	strength?: string;
	dosage: string;
	indication?: string;
	started_at?: string;
	discontinued?: string;
	forskriver?: string;
	reimbursement?: { legalBasis: string; code: string } | null;
	status: 'aktiv' | 'seponert' | 'utgatt' | 'utkast';
	multidose?: boolean;
	/** Last package dispensed by a pharmacy, if reported. */
	lastDisclosure?: string;
}

export interface PrescribingIn {
	patientId: string;
	forskriverHpr: string;
	forskriverName: string;
	medication: {
		name: string;
		atc?: string;
		varenummer?: string;
		form?: string;
		strength?: string;
	};
	dosage: string;
	quantity: string;
	indication?: string;
	/** ICPC-2 or ICD-10 code justifying any reimbursement. */
	reimbursementCode?: string;
	reimbursementLegalBasis?: string;
	reiterasjon?: number;
	validityMnd?: number;
	kommentarToApotek?: string;
	/** Class A and B products need extra confirmation from the prescriber. */
	isVanedannende?: boolean;
}

async function call<T>(operation: SfmOperation, body: unknown, patientId: string, actor: AuditActor): Promise<SfmResponse<T>> {
	const id = newId();
	await exec(
		`INSERT INTO sfm_sync (id, tenant_id, patient_id, operation, status, request, performed_by) VALUES ($1,$6,$2,$3,'kø',$4,$5)`,
		[id, patientId, operation, JSON.stringify(body), actor.userId, requireTenant().id]
	);

	try {
		const response =
			config.integrations.mode === 'mock'
				? await mockSfm<T>(operation, body, patientId)
				: notConnected<T>();

		await exec(
			`UPDATE sfm_sync SET status = $2, response = $3, feilmelding = $4, reseptid = $5, updated_at = now()
			 WHERE id = $1 AND tenant_id = $6`,
			[id, response.ok ? 'ok' : 'feilet', JSON.stringify(response.data ?? null), response.error ?? null, response.prescriptionId ?? null, requireTenant().id]
		);
		await log(
			{
				type: 'integrasjon', subtype: `sfm:${operation}`, action: operation === 'hentLegemiddelliste' ? 'R' : 'U',
				outcome: response.ok ? '0' : '8', outcomeDescription: response.error,
				patientId, entityRef: response.prescriptionId ? `urn:resept:${response.prescriptionId}` : null, purposeOfUse: 'TREAT'
			},
			actor
		);
		return response;
	} catch (err) {
		const message = (err as Error).message;
		await exec("UPDATE sfm_sync SET status = 'feilet', feilmelding = $2, updated_at = now() WHERE id = $1 AND tenant_id = $3", [id, message, requireTenant().id]);
		await log(
			{ type: 'integrasjon', subtype: `sfm:${operation}`, action: 'E', outcome: '8', outcomeDescription: message, patientId },
			actor
		);
		return { ok: false, error: message };
	}
}

/**
 * Says so rather than pretending. There used to be a `live` path here, with a
 * machine token and addresses that do not exist at NHN: SFM acts on the signed-in
 * clinician's own token, through its own screen.
 */
function notConnected<T>(): SfmResponse<T> {
	return { ok: false, error: 'Journalens eget forskrivningsskjema er ikke koblet til SFM. Slå på SFM Full (EPJ_SFM_FULL).' };
}

export async function getMedicationList(patientId: string, actor: AuditActor): Promise<SfmResponse<MedicationList>> {
	return call<MedicationList>('hentLegemiddelliste', { patientId }, patientId, actor);
}

/**
 * Prescribes a medicine. On success the prescription is mirrored as a FHIR
 * MedicationRequest in the record, so it is searchable via /fhir and visible to
 * SMART apps. SFM is the source - the record keeps a copy.
 */
export async function prescribe(inValue: PrescribingIn, actor: AuditActor): Promise<SfmResponse<{ prescriptionId: string }>> {
	const response = await call<{ prescriptionId: string }>('forskriv', inValue, inValue.patientId, actor);
	if (!response.ok || !response.prescriptionId) return response;

	const medicationRequest: FhirResource = {
		resourceType: 'MedicationRequest',
		status: 'active',
		intent: 'order',
		identifier: [{ system: 'urn:oid:2.16.578.1.12.4.1.4.10', value: response.prescriptionId }],
		medication: {
			concept: {
				coding: [
					...(inValue.medication.atc ? [{ system: SYSTEM.ATC, code: inValue.medication.atc, display: inValue.medication.name }] : []),
					...(inValue.medication.varenummer ? [{ system: SYSTEM.LEGEMIDDELVERK_VARENR, code: inValue.medication.varenummer }] : [])
				],
				text: [inValue.medication.name, inValue.medication.strength, inValue.medication.form].filter(Boolean).join(' ')
			}
		},
		subject: { reference: `Patient/${inValue.patientId}` },
		authoredOn: new Date().toISOString(),
		requester: { display: inValue.forskriverName, identifier: { system: SYSTEM.HPR, value: inValue.forskriverHpr } },
		dosageInstruction: [{ text: inValue.dosage }],
		dispenseRequest: {
			quantity: { value: Number.parseFloat(inValue.quantity) || 1, unit: 'pakning' },
			numberOfRepeatsAllowed: inValue.reiterasjon ?? 0,
			validityPeriod: {
				start: new Date().toISOString().slice(0, 10),
				end: new Date(Date.now() + (inValue.validityMnd ?? 12) * 30 * 86400_000).toISOString().slice(0, 10)
			}
		},
		...(inValue.indication ? { reason: [{ concept: { text: inValue.indication } }] } : {}),
		...(inValue.reimbursementCode
			? {
					extension: [
						{
							url: 'urn:epj:refusjon',
							extension: [
								{ url: 'hjemmel', valueString: inValue.reimbursementLegalBasis ?? '' },
								{ url: 'kode', valueString: inValue.reimbursementCode }
							]
						}
					]
				}
			: {}),
		note: inValue.kommentarToApotek ? [{ text: inValue.kommentarToApotek }] : undefined,
		meta: { source: 'urn:epj:sfm', tag: [{ system: 'urn:epj:kilde', code: 'sfm' }] }
	};

	await fhirClient.create(medicationRequest).catch((err) => {
		console.error('[sfm] klarte ikke å speile resept i journalen', err);
	});
	return response;
}

export async function discontinue(
	patientId: string,
	prescriptionId: string,
	arsak: string,
	actor: AuditActor
): Promise<SfmResponse<{ prescriptionId: string }>> {
	return call<{ prescriptionId: string }>('seponer', { patientId, prescriptionId, arsak }, patientId, actor);
}

export async function fornye(
	patientId: string,
	prescriptionId: string,
	actor: AuditActor
): Promise<SfmResponse<{ prescriptionId: string }>> {
	return call<{ prescriptionId: string }>('fornye', { patientId, prescriptionId }, patientId, actor);
}

export async function getUtleveringer(patientId: string, actor: AuditActor): Promise<SfmResponse<{ utleveringer: unknown[] }>> {
	return call<{ utleveringer: unknown[] }>('hentUtleveringer', { patientId }, patientId, actor);
}

export interface SynkLog {
	id: string;
	operation: string;
	status: string;
	feilmelding: string | null;
	reseptid: string | null;
	created_at: string;
}

export async function synkHistory(patientId: string, limit = 50): Promise<SynkLog[]> {
	return query<SynkLog>(
		`SELECT id, operation, status, feilmelding, reseptid, created_at FROM sfm_sync
		 WHERE tenant_id = $3 AND patient_id = $1 ORDER BY created_at DESC LIMIT $2`,
		[patientId, limit, requireTenant().id]
	);
}

export async function lastSynk(patientId: string): Promise<SynkLog | null> {
	return one<SynkLog>(
		`SELECT id, operation, status, feilmelding, reseptid, created_at FROM sfm_sync
		 WHERE tenant_id = $2 AND patient_id = $1 AND operation = 'hentLegemiddelliste' AND status = 'ok'
		 ORDER BY created_at DESC LIMIT 1`,
		[patientId, requireTenant().id]
	);
}
