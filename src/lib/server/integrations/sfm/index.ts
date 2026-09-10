import { one, exec, query } from '../../db';
import { requireTenant } from '../../tenant/context';
import { config } from '../../config';
import { newId } from '../../util/ids';
import { getMachineToken } from '../helseid-machine';
import { SYSTEM } from '../../fhir/codesystems';
import type { FhirResource } from '../../fhir/types';
import { fhirClient } from '../../fhir/client';
import { log, type AuditActor } from '../../audit';
import { mockSfm } from './mock';

/**
 * Sentral forskrivningsmodul (SFM).
 *
 * SFM driftes av Norsk helsenett og er veien inn til e-resept og Pasientens
 * legemiddelliste (PLL). EPJ-leverandører kan enten bruke SFM sitt eget
 * brukergrensesnitt eller integrere mot SFM Basis-API-et. Denne journalen
 * bruker API-varianten: forskrivning skjer i journalens eget bilde, og SFM
 * håndterer kommunikasjonen mot Reseptformidleren.
 *
 * Alle kall autentiseres med HelseID-maskintoken. I `mock`-modus svarer en
 * lokal simulator, slik at hele forskrivningsflyten kan kjøres og testes uten
 * oppkobling mot NHN sitt testmiljø.
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
	/** Kilde: `sfm` (Pasientens legemiddelliste) eller `lokal` (kun i journal). */
	source: 'sfm' | 'lokal';
	medications: MedicationEntry[];
	/** Avvik mellom PLL og lokal legemiddelliste som må avstemmes av lege. */
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
	/** Sist utleverte pakning fra apotek, hvis rapportert. */
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
	/** ICPC-2- eller ICD-10-kode som begrunner eventuell refusjon. */
	reimbursementCode?: string;
	reimbursementLegalBasis?: string;
	reiterasjon?: number;
	validityMnd?: number;
	kommentarToApotek?: string;
	/** A- og B-preparater krever ekstra bekreftelse fra forskriver. */
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
			config.integrations.modus === 'mock'
				? await mockSfm<T>(operation, body, patientId)
				: await callLive<T>(operation, body);

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

async function callLive<T>(operation: SfmOperation, body: unknown): Promise<SfmResponse<T>> {
	const { baseUrl, scope } = config.integrations.sfm;
	if (!baseUrl) throw new Error('SFM-endepunkt er ikke konfigurert (EPJ_SFM_BASE_URL)');
	const token = await getMachineToken(scope);
	const response = await fetch(`${baseUrl}/${operation}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			accept: 'application/json'
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000)
	});
	if (!response.ok) {
		return { ok: false, error: `SFM svarte ${response.status}: ${(await response.text()).slice(0, 300)}` };
	}
	const data = (await response.json()) as T & { prescriptionId?: string };
	return { ok: true, data, prescriptionId: data.prescriptionId };
}

export async function getMedicationList(patientId: string, actor: AuditActor): Promise<SfmResponse<MedicationList>> {
	return call<MedicationList>('hentLegemiddelliste', { patientId }, patientId, actor);
}

/**
 * Forskriver et legemiddel. Ved suksess speiles resepten som FHIR
 * MedicationRequest i journalen, slik at den er søkbar via /fhir og synlig for
 * SMART-apper. SFM er kilden - journalen holder en kopi.
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
