import { one, exec, query, transaction } from '../../db';
import { requireTenant } from '../../tenant/context';
import { newId } from '../../util/ids';
import { log, type AuditActor } from '../../audit';
import { fhirClient } from '../../fhir/client';
import { SYSTEM } from '../../fhir/codesystems';
import type { FhirResource } from '../../fhir/types';
import { compute, oreToKroner, TARIFF_KART, type ExemptionReason } from './tariffs';

/**
 * Billing card: the claim the GP sends to Helfo for one patient encounter.
 *
 * The card is built during the consultation, validated against the tariff
 * rules, and mirrored as a FHIR Claim so that settlement data is available on
 * the same API as the rest of the record. Several cards are collected into one
 * settlement submission (KUHR).
 */
export type Kontakttype = 'kontor' | 'sykebesok' | 'e-konsultasjon' | 'telefon' | 'enkel';
export type CardStatus = 'kladd' | 'klar' | 'sendt' | 'godkjent' | 'avvist' | 'delvis';

export interface BillingCard {
	id: string;
	patient_id: string;
	encounter_id: string | null;
	practitioner_id: string;
	hpr_number: string | null;
	date: string;
	kontakttype: Kontakttype;
	diagnosis_code: string | null;
	diagnosis_system: string | null;
	reimbursement_ore: number;
	copayment_ore: number;
	exemption_card: boolean;
	exemption_reason: string | null;
	status: CardStatus;
	settlement_id: string | null;
	rejection: string | null;
	claim_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface BillingLine {
	id: string;
	billing_card_id: string;
	tariff_code: string;
	count: number;
	reimbursement_ore: number;
	copayment_ore: number;
	note: string | null;
}

export interface NewCardIn {
	patientId: string;
	encounterId?: string | null;
	practitionerId: string;
	hprNumber?: string | null;
	date: string;
	kontakttype: Kontakttype;
	diagnosisCode?: string | null;
	diagnosisSystem?: string | null;
	tariffs: { tariff_code: string; count: number; note?: string }[];
	isSpesialistAllmennmedisin?: boolean;
	patientAge?: number;
	hasExemptionCard?: boolean;
	exemption?: ExemptionReason | null;
}

export interface CardResult {
	ok: boolean;
	id?: string;
	error?: string[];
	warnings?: string[];
	sumReimbursementOre?: number;
	requiresCopaymentOre?: number;
}

export async function createBillingCard(inValue: NewCardIn, actor: AuditActor): Promise<CardResult> {
	const calculation = compute(inValue.tariffs, {
		isSpesialistAllmennmedisin: inValue.isSpesialistAllmennmedisin,
		patientAge: inValue.patientAge,
		hasExemptionCard: inValue.hasExemptionCard,
		exemption: inValue.exemption
	});
	if (calculation.error.length > 0) {
		return { ok: false, error: calculation.error, warnings: calculation.warnings };
	}

	const id = newId();
	await transaction(async () => {
		await exec(
			`INSERT INTO billing_card (id, tenant_id, patient_id, encounter_id, practitioner_id, hpr_number, date, kontakttype,
				diagnosis_code, diagnosis_system, reimbursement_ore, copayment_ore, exemption_card, exemption_reason, status)
			 VALUES ($1,$14,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'klar')`,
			[
				id, inValue.patientId, inValue.encounterId ?? null, inValue.practitionerId, inValue.hprNumber ?? null, inValue.date,
				inValue.kontakttype, inValue.diagnosisCode ?? null, inValue.diagnosisSystem ?? SYSTEM.ICPC2,
				calculation.sumReimbursementOre, calculation.requiresCopaymentOre,
				calculation.exemption === 'frikort', calculation.exemption, requireTenant().id
			]
		);
		for (const line of calculation.lines) {
			await exec(
				`INSERT INTO billing_line (id, billing_card_id, tariff_code, count, reimbursement_ore, copayment_ore, note)
				 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				[newId(), id, line.tariff_code, line.count, line.reimbursementOre, line.copaymentOre,
				 inValue.tariffs.find((t) => t.tariff_code === line.tariff_code)?.note ?? null]
			);
		}
	});

	const claimId = await mirrorSomClaim(id, inValue, calculation);
	if (claimId) await exec('UPDATE billing_card SET claim_id = $2 WHERE id = $1 AND tenant_id = $3', [id, claimId, requireTenant().id]);

	await log(
		{
			type: 'oppgjor', subtype: 'regningskort:opprettet', action: 'C', outcome: '0',
			patientId: inValue.patientId, entityRef: claimId ?? `urn:regningskort:${id}`, purposeOfUse: 'HPAYMT',
			details: {
				tariffs: inValue.tariffs.map((t) => `${t.tariff_code}x${t.count}`).join(','),
				reimbursement: oreToKroner(calculation.sumReimbursementOre),
				copayment: oreToKroner(calculation.requiresCopaymentOre)
			}
		},
		actor
	);

	return {
		ok: true, id,
		warnings: calculation.warnings,
		sumReimbursementOre: calculation.sumReimbursementOre,
		requiresCopaymentOre: calculation.requiresCopaymentOre
	};
}

async function mirrorSomClaim(
	id: string,
	inValue: NewCardIn,
	calculation: ReturnType<typeof compute>
): Promise<string | null> {
	const claim: FhirResource = {
		resourceType: 'Claim',
		identifier: [{ system: 'urn:epj:regningskort', value: id }],
		status: 'active',
		type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
		use: 'claim',
		patient: { reference: `Patient/${inValue.patientId}` },
		created: new Date().toISOString(),
		provider: { reference: `Practitioner/${inValue.practitionerId}` },
		priority: { coding: [{ code: 'normal' }] },
		insurer: { display: 'Helfo' },
		...(inValue.encounterId ? { encounter: [{ reference: `Encounter/${inValue.encounterId}` }] } : {}),
		...(inValue.diagnosisCode
			? {
					diagnosis: [
						{
							sequence: 1,
							diagnosisCodeableConcept: {
								coding: [{ system: inValue.diagnosisSystem ?? SYSTEM.ICPC2, code: inValue.diagnosisCode }]
							}
						}
					]
				}
			: {}),
		item: calculation.lines.map((l, i) => ({
			sequence: i + 1,
			productOrService: {
				coding: [{ system: SYSTEM.TARIFF, code: l.tariff_code, display: l.text }]
			},
			quantity: { value: l.count },
			net: { value: (l.reimbursementOre + l.copaymentOre) / 100, currency: 'NOK' }
		})),
		total: { value: (calculation.sumReimbursementOre + calculation.requiresCopaymentOre) / 100, currency: 'NOK' }
	};
	try {
		const response = await fhirClient.create(claim);
		return `Claim/${response.resource.id}`;
	} catch (err) {
		console.error('[helfo] klarte ikke å speile regningskort som Claim', err);
		return null;
	}
}

export async function getCard(id: string): Promise<{ card: BillingCard; lines: BillingLine[] } | null> {
	const card = await one<BillingCard>('SELECT * FROM billing_card WHERE id = $1 AND tenant_id = $2', [id, requireTenant().id]);
	if (!card) return null;
	// Lines inherit the organisation through the card, which is already bounded.
	const lines = await query<BillingLine>('SELECT * FROM billing_line WHERE billing_card_id = $1 ORDER BY tariff_code', [id]);
	return { card, lines };
}

export async function listCard(filter: { status?: CardStatus; patientId?: string; from?: string; to?: string; limit?: number }): Promise<BillingCard[]> {
	const conditions = ['tenant_id = $1'];
	const params: unknown[] = [requireTenant().id];
	if (filter.status) { params.push(filter.status); conditions.push(`status = $${params.length}`); }
	if (filter.patientId) { params.push(filter.patientId); conditions.push(`patient_id = $${params.length}`); }
	if (filter.from) { params.push(filter.from); conditions.push(`date >= $${params.length}`); }
	if (filter.to) { params.push(filter.to); conditions.push(`date <= $${params.length}`); }
	params.push(Math.min(filter.limit ?? 200, 1000));
	return query<BillingCard>(
		`SELECT * FROM billing_card WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT $${params.length}`,
		params
	);
}

export async function deleteDraft(id: string, actor: AuditActor): Promise<boolean> {
	const card = await one<BillingCard>(
		"SELECT * FROM billing_card WHERE id = $1 AND tenant_id = $2 AND status IN ('kladd','klar')",
		[id, requireTenant().id]
	);
	if (!card) return false;
	await exec('DELETE FROM billing_card WHERE id = $1 AND tenant_id = $2', [id, requireTenant().id]);
	await log(
		{ type: 'oppgjor', subtype: 'regningskort:slettet', action: 'D', outcome: '0', patientId: card.patient_id, entityRef: `urn:regningskort:${id}` },
		actor
	);
	return true;
}

/** Kontrollerer at takstkodene på et kort fortsatt finnes i takstregisteret. */
export function ukjenteTariffs(lines: BillingLine[]): string[] {
	return lines.map((l) => l.tariff_code).filter((k) => !TARIFF_KART.has(k));
}
