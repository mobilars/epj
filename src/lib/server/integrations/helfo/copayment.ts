import { one, exec } from '../../db';
import { requireTenant } from '../../tenant/context';
import { config } from '../../config';
import { newId } from '../../util/ids';
import { log, type AuditActor } from '../../audit';

/**
 * Lookups against Helfo's copayment and exemption card service.
 *
 * Copayment ceiling 1 covers doctors, psychologists, outpatient clinics,
 * radiology, travel and medicines on blue prescription. When the ceiling is
 * reached Helfo issues an exemption card automatically, and the practitioner
 * collects no further copayment.
 *
 * The lookup is itself processing of personal data and is logged separately.
 */
/** Copayment ceiling 1. Set annually in the national budget - must be updated. */
export const EGENANDELSTAK_ORE = 327_800;
export const EGENANDELSTAK_AR = 2026;

export interface CopaymentStatus {
	patientId: string;
	hasExemptionCard: boolean;
	exemptionCardValidTo: string | null;
	earnedOre: number;
	remainingOre: number;
	source: 'helfo' | 'cache' | 'manuell';
	fetchedAt: string;
}

const CACHE_MINUTTER = 60;

export async function getCopaymentStatus(
	patientId: string,
	fnr: string,
	actor: AuditActor,
	forceOppfrisking = false
): Promise<CopaymentStatus> {
	if (!forceOppfrisking) {
		const cached = await one<{ has_exemption_card: boolean; exemption_card_until: string | null; earned_ore: number; utfort: string }>(
			`SELECT has_exemption_card, exemption_card_until, earned_ore, utfort FROM copayment_lookup
			 WHERE tenant_id = $3 AND patient_id = $1 AND utfort > now() - ($2 || ' minutes')::interval
			 ORDER BY utfort DESC LIMIT 1`,
			[patientId, String(CACHE_MINUTTER), requireTenant().id]
		);
		if (cached) {
			return {
				patientId,
				hasExemptionCard: cached.has_exemption_card,
				exemptionCardValidTo: cached.exemption_card_until,
				earnedOre: cached.earned_ore ?? 0,
				remainingOre: Math.max(0, EGENANDELSTAK_ORE - (cached.earned_ore ?? 0)),
				source: 'cache',
				fetchedAt: cached.utfort
			};
		}
	}

	const response = config.integrations.mode === 'mock' ? mockStatus(fnr) : await getFromHelfo(fnr);

	await exec(
		`INSERT INTO copayment_lookup (id, tenant_id, patient_id, performed_by, has_exemption_card, exemption_card_until, earned_ore, source)
		 VALUES ($1,$8,$2,$3,$4,$5,$6,$7)`,
		[newId(), patientId, actor.userId ?? 'system', response.hasExemptionCard, response.exemptionCardValidTo, response.earnedOre, response.source, requireTenant().id]
	);
	await log(
		{
			type: 'integrasjon', subtype: 'helfo:egenandel', action: 'R', outcome: '0',
			patientId, purposeOfUse: 'HPAYMT',
			details: { exemption_card: response.hasExemptionCard, source: response.source }
		},
		actor
	);

	return { ...response, patientId, remainingOre: Math.max(0, EGENANDELSTAK_ORE - response.earnedOre), fetchedAt: new Date().toISOString() };
}

async function getFromHelfo(fnr: string): Promise<Omit<CopaymentStatus, 'patientId' | 'remainingOre' | 'fetchedAt'>> {
	const url = config.integrations.helfo.copaymentUrl;
	if (!url) throw new Error('Helfo egenandelstjeneste er ikke konfigurert (EPJ_HELFO_COPAYMENT_URL)');
	const response = await fetch(`${url}/frikortstatus`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		// The field names are Helfo's, not ours: they go on the wire as they stand.
		body: JSON.stringify({ foedselsnummer: fnr, avtaleId: config.integrations.helfo.agreementId }),
		signal: AbortSignal.timeout(20_000)
	});
	if (!response.ok) throw new Error(`Helfo svarte ${response.status}`);
	const body = (await response.json()) as { hasExemptionCard: boolean; validTo?: string; earnedAmount?: number };
	return {
		hasExemptionCard: body.hasExemptionCard,
		exemptionCardValidTo: body.validTo ?? null,
		earnedOre: Math.round((body.earnedAmount ?? 0) * 100),
		source: 'helfo'
	};
}

/**
 * Deterministic simulation: the last digit of the national identity number
 * decides the status, so test data gives predictable, repeatable results.
 */
function mockStatus(fnr: string): Omit<CopaymentStatus, 'patientId' | 'remainingOre' | 'fetchedAt'> {
	const siffer = Number(fnr.slice(-1)) || 0;
	if (siffer >= 8) {
		return {
			hasExemptionCard: true,
			exemptionCardValidTo: `${EGENANDELSTAK_AR}-12-31`,
			earnedOre: EGENANDELSTAK_ORE,
			source: 'helfo'
		};
	}
	return {
		hasExemptionCard: false,
		exemptionCardValidTo: null,
		earnedOre: Math.round((siffer / 10) * EGENANDELSTAK_ORE),
		source: 'helfo'
	};
}
