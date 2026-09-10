import { one, exec, query, transaction } from '../../db';
import { requireTenant } from '../../tenant/context';
import { config } from '../../config';
import { document, el } from '../../util/xml';
import { newId } from '../../util/ids';
import { log, type AuditActor } from '../../audit';
import { oreToKroner } from './tariffs';
import type { BillingCard, BillingLine } from './billing';

/**
 * Settlement against Helfo (KUHR).
 *
 * The doctor sends periodic settlement claims with the period's billing cards.
 * Helfo checks and settles them, returning a settlement report in which some
 * cards may be rejected. Rejected cards must be corrected and resubmitted -
 * which is why we keep the link between card, submission and rejection reason.
 */

export type Oppgjorstatus = 'generert' | 'sendt' | 'mottatt' | 'avregnet' | 'avvist';

export interface Settlement {
	id: string;
	period_from: string;
	period_to: string;
	card_count: number;
	sum_reimbursement_ore: number;
	sum_copayment_ore: number;
	status: Oppgjorstatus;
	receipt: unknown;
	created_at: string;
	sent_at: string | null;
	sent_by: string | null;
}

export interface ForhandsvisningsResult {
	countCard: number;
	sumReimbursementOre: number;
	sumCopaymentOre: number;
	card: { id: string; date: string; patientId: string; reimbursementOre: number; copaymentOre: number }[];
	warnings: string[];
}

export async function forhandsvis(from: string, to: string): Promise<ForhandsvisningsResult> {
	const card = await query<BillingCard>(
		"SELECT * FROM billing_card WHERE tenant_id = $3 AND status = 'klar' AND date >= $1 AND date <= $2 ORDER BY date",
		[from, to, requireTenant().id]
	);
	const warnings: string[] = [];
	if (card.length === 0) warnings.push('Ingen regningskort med status «klar» i perioden.');
	const withoutDiagnosis = card.filter((k) => !k.diagnosis_code);
	if (withoutDiagnosis.length > 0) {
		warnings.push(`${withoutDiagnosis.length} regningskort mangler diagnosekode. Helfo kan avvise disse.`);
	}
	return {
		countCard: card.length,
		sumReimbursementOre: card.reduce((s, k) => s + k.reimbursement_ore, 0),
		sumCopaymentOre: card.reduce((s, k) => s + k.copayment_ore, 0),
		card: card.map((k) => ({
			id: k.id, date: k.date, patientId: k.patient_id,
			reimbursementOre: k.reimbursement_ore, copaymentOre: k.copayment_ore
		})),
		warnings
	};
}

/** Builds the settlement file and marks the cards as sent. */
export async function generateSettlement(from: string, to: string, actor: AuditActor): Promise<{ ok: boolean; id?: string; error?: string }> {
	const tenantId = requireTenant().id;
	const card = await query<BillingCard>(
		"SELECT * FROM billing_card WHERE tenant_id = $3 AND status = 'klar' AND date >= $1 AND date <= $2 ORDER BY date",
		[from, to, tenantId]
	);
	if (card.length === 0) return { ok: false, error: 'Ingen regningskort å sende i perioden' };

	const linesPerCard = new Map<string, BillingLine[]>();
	for (const k of card) {
		linesPerCard.set(k.id, await query<BillingLine>('SELECT * FROM billing_line WHERE billing_card_id = $1', [k.id]));
	}

	const id = newId();
	const file = buildSettlementFile(id, from, to, card, linesPerCard);
	const sumReimbursement = card.reduce((s, k) => s + k.reimbursement_ore, 0);
	const sumCopayment = card.reduce((s, k) => s + k.copayment_ore, 0);

	await transaction(async () => {
		await exec(
			`INSERT INTO settlement (id, tenant_id, period_from, period_to, card_count, sum_reimbursement_ore, sum_copayment_ore, status, file)
			 VALUES ($1,$8,$2,$3,$4,$5,$6,'generert',$7)`,
			[id, from, to, card.length, sumReimbursement, sumCopayment, file, tenantId]
		);
		await exec(
			"UPDATE billing_card SET status = 'sendt', settlement_id = $1, updated_at = now() WHERE id = ANY($2::text[]) AND tenant_id = $3",
			[id, card.map((k) => k.id), tenantId]
		);
	});

	await log(
		{
			type: 'oppgjor', subtype: 'oppgjor:generert', action: 'C', outcome: '0',
			entityRef: `urn:oppgjor:${id}`, purposeOfUse: 'HPAYMT',
			details: { period: `${from}..${to}`, count: card.length, reimbursement: oreToKroner(sumReimbursement) }
		},
		actor
	);
	return { ok: true, id };
}

export async function sendSettlement(id: string, actor: AuditActor): Promise<{ ok: boolean; error?: string }> {
	const settlement = await one<Settlement & { file: string }>('SELECT * FROM settlement WHERE id = $1 AND tenant_id = $2', [id, requireTenant().id]);
	if (!settlement) return { ok: false, error: 'Ukjent oppgjør' };
	if (settlement.status !== 'generert') return { ok: false, error: `Oppgjøret har status ${settlement.status}` };

	try {
		const receipt =
			config.integrations.mode === 'mock'
				? mockInnsending(settlement)
				: await sendToHelfo(settlement.file);

		await exec(
			"UPDATE settlement SET status = 'sendt', sent_at = now(), sent_by = $2, receipt = $3 WHERE id = $1 AND tenant_id = $4",
			[id, actor.userId, JSON.stringify(receipt), requireTenant().id]
		);
		await log(
			{ type: 'oppgjor', subtype: 'oppgjor:sendt', action: 'E', outcome: '0', entityRef: `urn:oppgjor:${id}`, purposeOfUse: 'HPAYMT', details: { reference: receipt.reference } },
			actor
		);
		return { ok: true };
	} catch (err) {
		const message = (err as Error).message;
		await log(
			{ type: 'oppgjor', subtype: 'oppgjor:sendt', action: 'E', outcome: '8', outcomeDescription: message, entityRef: `urn:oppgjor:${id}` },
			actor
		);
		return { ok: false, error: message };
	}
}

async function sendToHelfo(file: string): Promise<{ reference: string; received: string }> {
	const url = config.integrations.helfo.settlementUrl;
	if (!url) throw new Error('Helfo oppgjørstjeneste er ikke konfigurert (EPJ_HELFO_SETTLEMENT_URL)');
	const response = await fetch(`${url}/oppgjor`, {
		method: 'POST',
		headers: { 'content-type': 'application/xml', accept: 'application/json' },
		body: file,
		signal: AbortSignal.timeout(60_000)
	});
	if (!response.ok) throw new Error(`Helfo svarte ${response.status}: ${(await response.text()).slice(0, 300)}`);
	return (await response.json()) as { reference: string; received: string };
}

function mockInnsending(settlement: Settlement): { reference: string; received: string } {
	return { reference: `KUHR-${settlement.id.slice(0, 8).toUpperCase()}`, received: new Date().toISOString() };
}

/**
 * Records the settlement report from Helfo: which cards were approved and which
 * were rejected, with the reason.
 */
export async function registerSettlementRun(
	settlementId: string,
	rapport: { cardId: string; approved: boolean; arsak?: string; utbetaltOre?: number }[],
	actor: AuditActor
): Promise<{ approved: number; rejected: number }> {
	let approved = 0;
	let rejected = 0;
	const tenantId = requireTenant().id;
	await transaction(async () => {
		for (const r of rapport) {
			if (r.approved) {
				await exec("UPDATE billing_card SET status = 'godkjent', rejection = NULL, updated_at = now() WHERE id = $1 AND settlement_id = $2 AND tenant_id = $3", [r.cardId, settlementId, tenantId]);
				approved++;
			} else {
				await exec("UPDATE billing_card SET status = 'avvist', rejection = $3, updated_at = now() WHERE id = $1 AND settlement_id = $2 AND tenant_id = $4", [r.cardId, settlementId, r.arsak ?? 'Avvist av Helfo', tenantId]);
				rejected++;
			}
		}
		await exec("UPDATE settlement SET status = 'avregnet' WHERE id = $1 AND tenant_id = $2", [settlementId, tenantId]);
	});
	await log(
		{ type: 'oppgjor', subtype: 'oppgjor:avregnet', action: 'U', outcome: rejected > 0 ? '4' : '0', entityRef: `urn:oppgjor:${settlementId}`, details: { approved, rejected } },
		actor
	);
	return { approved, rejected };
}

/**
 * Settlement file.
 *
 * KUHR accepts billing cards in a fixed XML format. The structure below follows
 * the main elements (account, billing card, tariff lines), but field names and
 * code system references must be checked against Helfo's current message
 * specification before going to production.
 */
export function buildSettlementFile(
	id: string,
	from: string,
	to: string,
	card: BillingCard[],
	lines: Map<string, BillingLine[]>
): string {
	const root = el('Oppgjorskrav', [
		el('Kravhode', [
			el('KravId', id),
			el('Konto', config.integrations.helfo.agreementId || requireTenant().organisation_number),
			el('Organisasjonsnummer', requireTenant().organisation_number),
			el('Virksomhet', requireTenant().name),
			el('PeriodeFra', from),
			el('PeriodeTil', to),
			el('Generert', new Date().toISOString()),
			el('AntallRegningskort', card.length),
			el('SumRefusjon', (card.reduce((s, k) => s + k.reimbursement_ore, 0) / 100).toFixed(2)),
			el('SumEgenandel', (card.reduce((s, k) => s + k.copayment_ore, 0) / 100).toFixed(2))
		]),
		el(
			'Regningskort',
			card.map((k) =>
				el('Kort', [
					el('KortId', k.id),
					el('Dato', k.date),
					el('Kontakttype', k.kontakttype),
					el('BehandlerHPR', k.hpr_number),
					k.diagnosis_code
						? el('Diagnose', [el('Kode', k.diagnosis_code), el('Kodeverk', k.diagnosis_system)])
						: null,
					el('Frikort', k.exemption_card ? 'J' : 'N'),
					k.exemption_reason ? el('FritakGrunn', k.exemption_reason) : null,
					el('Refusjon', (k.reimbursement_ore / 100).toFixed(2)),
					el('Egenandel', (k.copayment_ore / 100).toFixed(2)),
					el(
						'Takstlinjer',
						(lines.get(k.id) ?? []).map((l) =>
							el('Takstlinje', [
								el('Takstkode', l.tariff_code),
								el('Antall', l.count),
								el('Refusjon', (l.reimbursement_ore / 100).toFixed(2)),
								el('Egenandel', (l.copayment_ore / 100).toFixed(2)),
								l.note ? el('Merknad', l.note) : null
							])
						)
					)
				])
			)
		)
	]);
	return document(root);
}

export async function listSettlement(limit = 50): Promise<Settlement[]> {
	return query<Settlement>(
		`SELECT id, period_from, period_to, card_count, sum_reimbursement_ore, sum_copayment_ore, status, receipt, created_at, sent_at, sent_by
		 FROM settlement WHERE tenant_id = $2 ORDER BY created_at DESC LIMIT $1`,
		[limit, requireTenant().id]
	);
}

export async function getSettlement(id: string): Promise<(Settlement & { file: string }) | null> {
	return one<Settlement & { file: string }>('SELECT * FROM settlement WHERE id = $1 AND tenant_id = $2', [id, requireTenant().id]);
}
