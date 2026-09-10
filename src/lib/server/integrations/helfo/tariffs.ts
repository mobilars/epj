/**
 * Takstregister basert på Normaltariff for privat allmennpraksis.
 *
 * VIKTIG: Beløpene nedenfor er et arbeidsgrunnlag, ikke en autoritativ kilde.
 * Normaltariffen forhandles årlig og trer i kraft 1. juli, med enkelte endringer
 * fra 1. januar. Før produksjonssetting må `belop` og `egenandel` oppdateres fra
 * gjeldende normaltariff (Den norske legeforening / Helfo), og `gyldigFra` settes.
 * `verifisert: false` markerer at koden ennå ikke er kontrollert mot tariffen.
 *
 * Alle beløp er i øre for å unngå avrundingsfeil.
 */

export type Takstgruppe =
	| 'konsultasjon'
	| 'enkel-kontakt'
	| 'sykebesok'
	| 'tidstillegg'
	| 'prosedyre'
	| 'laboratorie'
	| 'samtaleterapi'
	| 'reise'
	| 'attest'
	| 'tillegg';

export interface Tariff {
	code: string;
	text: string;
	group: Takstgruppe;
	/** Refusjon fra Helfo, i øre. */
	reimbursementOre: number;
	/** Egenandel pasienten betaler, i øre. Teller mot frikortgrensen. */
	copaymentOre: number;
	/** Takster som ikke kan kombineres med denne. */
	utelukker?: string[];
	/** Takster som må være med for at denne kan brukes. */
	requires?: string[];
	/** Kan repeteres, f.eks. per påbegynt tidsenhet. */
	repeterbar?: boolean;
	maxCount?: number;
	/** Krever spesialist i allmennmedisin. */
	requiresSpesialist?: boolean;
	note?: string;
	verified: boolean;
}

/** Datoen registeret nedenfor er ment å gjelde fra. Oppdateres ved tariffendring. */
export const TAKSTREGISTER_VALID_FROM = '2025-07-01';
export const TAKSTREGISTER_SOURCE = 'Normaltariff for privat allmennpraksis (arbeidsgrunnlag - må verifiseres)';

export const TARIFFS: Tariff[] = [
	// Konsultasjoner
	{ code: '2ad', text: 'Konsultasjon hos allmennpraktiserende lege', group: 'konsultasjon', reimbursementOre: 19_600, copaymentOre: 24_500, utelukker: ['1ad', '1ak', '2ae', '11ad'], verified: false },
	{ code: '2ae', text: 'Konsultasjon hos spesialist i allmennmedisin', group: 'konsultasjon', reimbursementOre: 27_700, copaymentOre: 24_500, utelukker: ['1ad', '1ak', '2ad', '11ad'], requiresSpesialist: true, verified: false },
	{ code: '2ak', text: 'E-konsultasjon hos allmennpraktiserende lege', group: 'konsultasjon', reimbursementOre: 19_600, copaymentOre: 24_500, utelukker: ['2ad', '2ae', '1ad', '1ak'], note: 'Skriftlig eller video, journalføres som e-konsultasjon', verified: false },
	{ code: '2akd', text: 'E-konsultasjon hos spesialist i allmennmedisin', group: 'konsultasjon', reimbursementOre: 27_700, copaymentOre: 24_500, utelukker: ['2ad', '2ae', '2ak'], requiresSpesialist: true, verified: false },

	// Enkel kontakt
	{ code: '1ad', text: 'Enkel pasientkontakt ved personlig frammøte eller bud', group: 'enkel-kontakt', reimbursementOre: 2_400, copaymentOre: 6_100, utelukker: ['2ad', '2ae', '2ak'], verified: false },
	{ code: '1ak', text: 'Enkel pasientkontakt per telefon eller skriftlig', group: 'enkel-kontakt', reimbursementOre: 2_400, copaymentOre: 6_100, utelukker: ['2ad', '2ae', '2ak'], verified: false },
	{ code: '1bd', text: 'Enkel pasientkontakt, forlenget', group: 'enkel-kontakt', reimbursementOre: 4_800, copaymentOre: 6_100, verified: false },

	// Sykebesøk
	{ code: '11ad', text: 'Sykebesøk ved allmennpraktiserende lege', group: 'sykebesok', reimbursementOre: 25_800, copaymentOre: 28_400, utelukker: ['2ad', '2ae', '2ak'], verified: false },
	{ code: '11ak', text: 'Sykebesøk ved spesialist i allmennmedisin', group: 'sykebesok', reimbursementOre: 33_900, copaymentOre: 28_400, requiresSpesialist: true, verified: false },

	// Tidstillegg
	{ code: '2cd', text: 'Tillegg for konsultasjon utover 20 minutter, per påbegynt 15 min', group: 'tidstillegg', reimbursementOre: 14_800, copaymentOre: 0, requires: ['2ad', '2ae', '2ak', '2akd', '11ad', '11ak'], repeterbar: true, maxCount: 6, verified: false },
	{ code: '2dd', text: 'Samtaleterapi, per påbegynt 15 min utover første 20 min', group: 'samtaleterapi', reimbursementOre: 16_800, copaymentOre: 0, requires: ['2ad', '2ae'], repeterbar: true, maxCount: 6, verified: false },

	// Prosedyrer
	{ code: '100', text: 'Enkel kirurgisk prosedyre, sårskift, fjerning av suturer', group: 'prosedyre', reimbursementOre: 8_900, copaymentOre: 0, verified: false },
	{ code: '101', text: 'Kirurgisk inngrep i lokalanestesi', group: 'prosedyre', reimbursementOre: 24_500, copaymentOre: 0, verified: false },
	{ code: '105', text: 'Spirometri', group: 'prosedyre', reimbursementOre: 8_400, copaymentOre: 0, verified: false },
	{ code: '106', text: 'EKG med tolkning', group: 'prosedyre', reimbursementOre: 9_600, copaymentOre: 0, verified: false },
	{ code: '109', text: '24-timers blodtrykksmåling', group: 'prosedyre', reimbursementOre: 21_000, copaymentOre: 0, verified: false },
	{ code: '111', text: 'Gynekologisk undersøkelse med celleprøve', group: 'prosedyre', reimbursementOre: 11_200, copaymentOre: 0, verified: false },
	{ code: '116', text: 'Innsetting eller fjerning av spiral eller p-stav', group: 'prosedyre', reimbursementOre: 18_700, copaymentOre: 0, verified: false },

	// Laboratorie
	{ code: '701a', text: 'Enkel laboratorieprøve (CRP, glukose, Hb, urinstiks)', group: 'laboratorie', reimbursementOre: 6_100, copaymentOre: 0, repeterbar: true, maxCount: 8, verified: false },
	{ code: '701b', text: 'Blodprøvetaking (venepunksjon)', group: 'laboratorie', reimbursementOre: 5_400, copaymentOre: 0, verified: false },
	{ code: '702', text: 'Hurtigtest for streptokokker, mononukleose eller influensa', group: 'laboratorie', reimbursementOre: 6_800, copaymentOre: 0, repeterbar: true, maxCount: 3, verified: false },
	{ code: '707', text: 'INR-måling', group: 'laboratorie', reimbursementOre: 7_200, copaymentOre: 0, verified: false },

	// Reise og attest
	{ code: '21k', text: 'Reisetillegg ved sykebesøk', group: 'reise', reimbursementOre: 9_400, copaymentOre: 0, requires: ['11ad', '11ak'], verified: false },
	{ code: 'L1', text: 'Legeerklæring til NAV', group: 'attest', reimbursementOre: 0, copaymentOre: 0, note: 'Faktureres NAV, ikke Helfo', verified: false },

	// Tillegg
	{ code: '2hd', text: 'Tillegg for kveld, natt, helg og høytid', group: 'tillegg', reimbursementOre: 11_900, copaymentOre: 0, verified: false }
];

export const TARIFF_KART = new Map(TARIFFS.map((t) => [t.code, t]));

export function getTariff(code: string): Tariff | undefined {
	return TARIFF_KART.get(code);
}

export function tariffAfterGroup(group: Takstgruppe): Tariff[] {
	return TARIFFS.filter((t) => t.group === group);
}

// ---------------------------------------------------------------------------
// Fritak for egenandel
// ---------------------------------------------------------------------------

export type ExemptionReason =
	| 'barn-under-16'
	| 'barn-under-18-psykisk'
	| 'yrkesskade'
	| 'svangerskap'
	| 'smittsom-sykdom'
	| 'militartjeneste'
	| 'frikort'
	| 'minstepensjonist-mv';

export const FRITAKSGRUNNER: Record<ExemptionReason, string> = {
	'barn-under-16': 'Barn under 16 år',
	'barn-under-18-psykisk': 'Barn under 18 år ved psykisk helsehjelp',
	yrkesskade: 'Godkjent yrkesskade (folketrygdloven Â§ 5-25)',
	svangerskap: 'Svangerskapskontroll',
	'smittsom-sykdom': 'Allmennfarlig smittsom sykdom (smittevernloven)',
	militartjeneste: 'Militær- eller siviltjeneste',
	frikort: 'Gyldig frikort (egenandelstak 1)',
	'minstepensjonist-mv': 'Fritak etter særskilt hjemmel'
};

/** Alderen der egenandel begynner å påløpe. */
export const COPAYMENT_ALDERSGRENSE = 16;

export interface BillingLine {
	tariff_code: string;
	count: number;
}

export interface Calculation {
	lines: {
		tariff_code: string;
		text: string;
		count: number;
		reimbursementOre: number;
		copaymentOre: number;
	}[];
	sumReimbursementOre: number;
	sumCopaymentOre: number;
	/** Egenandel som faktisk kreves inn, etter fritak. */
	requiresCopaymentOre: number;
	exemption: ExemptionReason | null;
	error: string[];
	warnings: string[];
}

export interface CalculationContext {
	isSpesialistAllmennmedisin?: boolean;
	patientAge?: number;
	hasExemptionCard?: boolean;
	exemption?: ExemptionReason | null;
}

/**
 * Beregner refusjon og egenandel for et sett takster, og kontrollerer
 * kombinasjonsreglene. Regelbrudd stoppes her, ikke først i Helfos avregning -
 * det er forskjellen på å oppdage feilen i dag og å oppdage den om seks uker.
 */
export function compute(lines: BillingLine[], context: CalculationContext = {}): Calculation {
	const error: string[] = [];
	const warnings: string[] = [];
	const codes = lines.map((l) => l.tariff_code);
	const resultLines: Calculation['lines'] = [];

	for (const line of lines) {
		const tariff = TARIFF_KART.get(line.tariff_code);
		if (!tariff) {
			error.push(`Ukjent takstkode: ${line.tariff_code}`);
			continue;
		}
		const count = Math.max(1, Math.floor(line.count));
		if (!tariff.repeterbar && count > 1) {
			error.push(`Takst ${tariff.code} kan ikke repeteres`);
		}
		if (tariff.maxCount && count > tariff.maxCount) {
			error.push(`Takst ${tariff.code} kan maksimalt brukes ${tariff.maxCount} ganger`);
		}
		if (tariff.requiresSpesialist && !context.isSpesialistAllmennmedisin) {
			error.push(`Takst ${tariff.code} krever spesialist i allmennmedisin`);
		}
		for (const u of tariff.utelukker ?? []) {
			if (codes.includes(u)) error.push(`Takst ${tariff.code} kan ikke kombineres med ${u}`);
		}
		if (tariff.requires && !tariff.requires.some((k) => codes.includes(k))) {
			error.push(`Takst ${tariff.code} krever en av: ${tariff.requires.join(', ')}`);
		}
		if (!tariff.verified) {
			warnings.push(`Beløpet for takst ${tariff.code} er ikke verifisert mot gjeldende normaltariff`);
		}
		resultLines.push({
			tariff_code: tariff.code,
			text: tariff.text,
			count,
			reimbursementOre: tariff.reimbursementOre * count,
			copaymentOre: tariff.copaymentOre * count
		});
	}

	const sumReimbursementOre = resultLines.reduce((s, l) => s + l.reimbursementOre, 0);
	const sumCopaymentOre = resultLines.reduce((s, l) => s + l.copaymentOre, 0);

	let exemption: ExemptionReason | null = context.exemption ?? null;
	if (!exemption && context.patientAge !== undefined && context.patientAge < COPAYMENT_ALDERSGRENSE) {
		exemption = 'barn-under-16';
	}
	if (!exemption && context.hasExemptionCard) exemption = 'frikort';

	return {
		lines: resultLines,
		sumReimbursementOre,
		sumCopaymentOre,
		// Ved frikort dekker Helfo egenandelen; ved øvrige fritak bortfaller den.
		requiresCopaymentOre: exemption ? 0 : sumCopaymentOre,
		exemption,
		error,
		warnings: [...new Set(warnings)]
	};
}

export function oreToKroner(ore: number): string {
	return (ore / 100).toLocaleString('nb-NO', { style: 'currency', currency: 'NOK' });
}
