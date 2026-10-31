import type { AuthContext } from '../authz/context';
import { exec, one, query, transaction } from '../db';
import { fhirClient } from '../fhir/client';
import { toPatientDisplay } from '../fhir/display';
import { resources } from '../fhir/internal';
import type { FhirResource } from '../fhir/types';
import { requireTenant } from '../tenant/context';
import { newId } from '../util/ids';
import { retireIdentifiers } from './patientdetails';

/**
 * Joining two records of the same person.
 *
 * Nothing is deleted: a record is a legal document, and the mistake may be the merge.
 * Everything that points at the merged record is pointed at the kept one instead, and
 * the FHIR server keeps the earlier version of each. The merged record stays behind,
 * inactive, saying what replaced it.
 *
 * This reads around the access guard on purpose, since a duplicate is usually the one a
 * clinician cannot see. The preview shows counts and identity only, never content.
 */

/** Tables on the platform's side holding a patient. Apps move their own. */
const PATIENT_TABLES = ['care_relationship', 'break_glass', 'record_restriction', 'binary_patient'];

export interface MergeCandidate {
	id: string;
	name: string;
	nationalIdMasked: string | null;
	birthDate: string | null;
	age: number | null;
	/** How many entries of each kind the record holds. */
	counts: { type: string; count: number }[];
	sameNumber: boolean;
}

/** The record a merged patient became, if this is one. */
export async function keptPatientFor(patientId: string): Promise<string | null> {
	const row = await one<{ kept_patient_id: string }>(
		'SELECT kept_patient_id FROM patient_merge WHERE tenant_id = $1 AND merged_patient_id = $2',
		[requireTenant().id, patientId]
	);
	return row?.kept_patient_id ?? null;
}

/** Every record that has ended up in this one, through any number of merges. */
export async function mergedPatientIds(patientId: string): Promise<string[]> {
	const rows = await query<{ merged_patient_id: string }>(
		`WITH RECURSIVE chain AS (
			SELECT merged_patient_id FROM patient_merge WHERE tenant_id = $1 AND kept_patient_id = $2
			UNION
			SELECT m.merged_patient_id FROM patient_merge m
			JOIN chain c ON m.kept_patient_id = c.merged_patient_id
			WHERE m.tenant_id = $1
		 )
		 SELECT merged_patient_id FROM chain`,
		[requireTenant().id, patientId]
	);
	return rows.map((row) => row.merged_patient_id);
}

/** Everything in a record but the patient, following the server's paging. */
async function contentsOf(patientId: string): Promise<FhirResource[]> {
	const out: FhirResource[] = [];
	let bundle = await fhirClient.everything(patientId, new URLSearchParams({ _count: '500' }));
	for (;;) {
		out.push(...resources(bundle).filter((r) => r.resourceType !== 'Patient'));
		const next = (bundle.link as { relation?: string; url?: string }[] | undefined)?.find((l) => l.relation === 'next')?.url;
		if (!next) return out;
		bundle = await fhirClient.page(next);
	}
}

export async function mergeCandidate(patient: FhirResource, ownNumber: string): Promise<MergeCandidate> {
	const display = toPatientDisplay(patient);
	const counted = new Map<string, number>();
	for (const resource of await contentsOf(display.id)) {
		counted.set(resource.resourceType, (counted.get(resource.resourceType) ?? 0) + 1);
	}
	return {
		id: display.id,
		name: display.name,
		nationalIdMasked: display.nationalIdMasked,
		birthDate: display.birthDate,
		age: display.age,
		counts: [...counted].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
		sameNumber: Boolean(display.nationalId) && display.nationalId === ownNumber
	};
}

/** Points every reference to one patient at another. Returns whether anything changed. */
export function repointReferences(node: unknown, from: string, to: string): boolean {
	if (Array.isArray(node)) {
		return node.map((item) => repointReferences(item, from, to)).some(Boolean);
	}
	if (!node || typeof node !== 'object') return false;
	let changed = false;
	const object = node as Record<string, unknown>;
	for (const [key, value] of Object.entries(object)) {
		if (key === 'reference' && typeof value === 'string' && (value === `Patient/${from}` || value.endsWith(`/Patient/${from}`))) {
			object[key] = value.slice(0, value.length - from.length) + to;
			changed = true;
		} else if (repointReferences(value, from, to)) {
			changed = true;
		}
	}
	return changed;
}

export interface MergeRequest {
	keptId: string;
	mergedId: string;
	reason: string;
	/** What the apps do with their own tables. Given by the caller, who may know of apps. */
	moveInApps: (from: string, to: string) => Promise<void>;
}

/**
 * Carries out the merge. The clinical entries move first, one at a time, and the merge
 * is recorded last: if it stops half way, nothing says it is done, and running it again
 * moves what is left.
 */
export async function mergePatients(ctx: AuthContext, { keptId, mergedId, reason, moveInApps }: MergeRequest): Promise<{ moved: number }> {
	if (keptId === mergedId) throw new Error('A patient cannot be merged with itself');
	if (await keptPatientFor(mergedId)) throw new Error('This patient has already been merged');
	if (await keptPatientFor(keptId)) throw new Error('The patient to keep has itself been merged');

	const tenantId = requireTenant().id;
	const [kept, merged] = await Promise.all([fhirClient.read('Patient', keptId), fhirClient.read('Patient', mergedId)]);

	let moved = 0;
	for (const resource of await contentsOf(mergedId)) {
		if (repointReferences(resource, mergedId, keptId)) {
			await fhirClient.update(resource.resourceType, resource.id as string, resource);
			moved++;
		}
	}

	await transaction(async () => {
		for (const table of PATIENT_TABLES) {
			await exec(`UPDATE ${table} SET patient_id = $3 WHERE tenant_id = $1 AND patient_id = $2`, [tenantId, mergedId, keptId]);
		}
		await moveInApps(mergedId, keptId);
		await exec(
			`INSERT INTO patient_merge (id, tenant_id, kept_patient_id, merged_patient_id, merged_by, reason, moved_resources)
			 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			[newId(), tenantId, keptId, mergedId, ctx.userId, reason, moved]
		);

		// Inside the transaction, so a failure here leaves the merge unrecorded and it can
		// be run again. The number and phone go from the merged record, or it would still
		// be found by them: the earlier version keeps them.
		const replaced = retireIdentifiers(merged);
		delete replaced.telecom;
		await fhirClient.update('Patient', mergedId, {
			...replaced,
			active: false,
			link: [{ other: { reference: `Patient/${keptId}` }, type: 'replaced-by' }]
		});
		await fhirClient.update('Patient', keptId, {
			...kept,
			link: [...((kept.link as unknown[]) ?? []), { other: { reference: `Patient/${mergedId}` }, type: 'replaces' }]
		});
	});

	return { moved };
}
