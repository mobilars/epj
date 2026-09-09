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

export interface Takst {
	kode: string;
	tekst: string;
	gruppe: Takstgruppe;
	/** Refusjon fra Helfo, i øre. */
	refusjonOre: number;
	/** Egenandel pasienten betaler, i øre. Teller mot frikortgrensen. */
	egenandelOre: number;
	/** Takster som ikke kan kombineres med denne. */
	utelukker?: string[];
	/** Takster som må være med for at denne kan brukes. */
	krever?: string[];
	/** Kan repeteres, f.eks. per påbegynt tidsenhet. */
	repeterbar?: boolean;
	maksAntall?: number;
	/** Krever spesialist i allmennmedisin. */
	kreverSpesialist?: boolean;
	merknad?: string;
	verifisert: boolean;
}

/** Datoen registeret nedenfor er ment å gjelde fra. Oppdateres ved tariffendring. */
export const TAKSTREGISTER_GYLDIG_FRA = '2025-07-01';
export const TAKSTREGISTER_KILDE = 'Normaltariff for privat allmennpraksis (arbeidsgrunnlag - må verifiseres)';

export const TAKSTER: Takst[] = [
	// Konsultasjoner
	{ kode: '2ad', tekst: 'Konsultasjon hos allmennpraktiserende lege', gruppe: 'konsultasjon', refusjonOre: 19_600, egenandelOre: 24_500, utelukker: ['1ad', '1ak', '2ae', '11ad'], verifisert: false },
	{ kode: '2ae', tekst: 'Konsultasjon hos spesialist i allmennmedisin', gruppe: 'konsultasjon', refusjonOre: 27_700, egenandelOre: 24_500, utelukker: ['1ad', '1ak', '2ad', '11ad'], kreverSpesialist: true, verifisert: false },
	{ kode: '2ak', tekst: 'E-konsultasjon hos allmennpraktiserende lege', gruppe: 'konsultasjon', refusjonOre: 19_600, egenandelOre: 24_500, utelukker: ['2ad', '2ae', '1ad', '1ak'], merknad: 'Skriftlig eller video, journalføres som e-konsultasjon', verifisert: false },
	{ kode: '2akd', tekst: 'E-konsultasjon hos spesialist i allmennmedisin', gruppe: 'konsultasjon', refusjonOre: 27_700, egenandelOre: 24_500, utelukker: ['2ad', '2ae', '2ak'], kreverSpesialist: true, verifisert: false },

	// Enkel kontakt
	{ kode: '1ad', tekst: 'Enkel pasientkontakt ved personlig frammøte eller bud', gruppe: 'enkel-kontakt', refusjonOre: 2_400, egenandelOre: 6_100, utelukker: ['2ad', '2ae', '2ak'], verifisert: false },
	{ kode: '1ak', tekst: 'Enkel pasientkontakt per telefon eller skriftlig', gruppe: 'enkel-kontakt', refusjonOre: 2_400, egenandelOre: 6_100, utelukker: ['2ad', '2ae', '2ak'], verifisert: false },
	{ kode: '1bd', tekst: 'Enkel pasientkontakt, forlenget', gruppe: 'enkel-kontakt', refusjonOre: 4_800, egenandelOre: 6_100, verifisert: false },

	// Sykebesøk
	{ kode: '11ad', tekst: 'Sykebesøk ved allmennpraktiserende lege', gruppe: 'sykebesok', refusjonOre: 25_800, egenandelOre: 28_400, utelukker: ['2ad', '2ae', '2ak'], verifisert: false },
	{ kode: '11ak', tekst: 'Sykebesøk ved spesialist i allmennmedisin', gruppe: 'sykebesok', refusjonOre: 33_900, egenandelOre: 28_400, kreverSpesialist: true, verifisert: false },

	// Tidstillegg
	{ kode: '2cd', tekst: 'Tillegg for konsultasjon utover 20 minutter, per påbegynt 15 min', gruppe: 'tidstillegg', refusjonOre: 14_800, egenandelOre: 0, krever: ['2ad', '2ae', '2ak', '2akd', '11ad', '11ak'], repeterbar: true, maksAntall: 6, verifisert: false },
	{ kode: '2dd', tekst: 'Samtaleterapi, per påbegynt 15 min utover første 20 min', gruppe: 'samtaleterapi', refusjonOre: 16_800, egenandelOre: 0, krever: ['2ad', '2ae'], repeterbar: true, maksAntall: 6, verifisert: false },

	// Prosedyrer
	{ kode: '100', tekst: 'Enkel kirurgisk prosedyre, sårskift, fjerning av suturer', gruppe: 'prosedyre', refusjonOre: 8_900, egenandelOre: 0, verifisert: false },
	{ kode: '101', tekst: 'Kirurgisk inngrep i lokalanestesi', gruppe: 'prosedyre', refusjonOre: 24_500, egenandelOre: 0, verifisert: false },
	{ kode: '105', tekst: 'Spirometri', gruppe: 'prosedyre', refusjonOre: 8_400, egenandelOre: 0, verifisert: false },
	{ kode: '106', tekst: 'EKG med tolkning', gruppe: 'prosedyre', refusjonOre: 9_600, egenandelOre: 0, verifisert: false },
	{ kode: '109', tekst: '24-timers blodtrykksmåling', gruppe: 'prosedyre', refusjonOre: 21_000, egenandelOre: 0, verifisert: false },
	{ kode: '111', tekst: 'Gynekologisk undersøkelse med celleprøve', gruppe: 'prosedyre', refusjonOre: 11_200, egenandelOre: 0, verifisert: false },
	{ kode: '116', tekst: 'Innsetting eller fjerning av spiral eller p-stav', gruppe: 'prosedyre', refusjonOre: 18_700, egenandelOre: 0, verifisert: false },

	// Laboratorie
	{ kode: '701a', tekst: 'Enkel laboratorieprøve (CRP, glukose, Hb, urinstiks)', gruppe: 'laboratorie', refusjonOre: 6_100, egenandelOre: 0, repeterbar: true, maksAntall: 8, verifisert: false },
	{ kode: '701b', tekst: 'Blodprøvetaking (venepunksjon)', gruppe: 'laboratorie', refusjonOre: 5_400, egenandelOre: 0, verifisert: false },
	{ kode: '702', tekst: 'Hurtigtest for streptokokker, mononukleose eller influensa', gruppe: 'laboratorie', refusjonOre: 6_800, egenandelOre: 0, repeterbar: true, maksAntall: 3, verifisert: false },
	{ kode: '707', tekst: 'INR-måling', gruppe: 'laboratorie', refusjonOre: 7_200, egenandelOre: 0, verifisert: false },

	// Reise og attest
	{ kode: '21k', tekst: 'Reisetillegg ved sykebesøk', gruppe: 'reise', refusjonOre: 9_400, egenandelOre: 0, krever: ['11ad', '11ak'], verifisert: false },
	{ kode: 'L1', tekst: 'Legeerklæring til NAV', gruppe: 'attest', refusjonOre: 0, egenandelOre: 0, merknad: 'Faktureres NAV, ikke Helfo', verifisert: false },

	// Tillegg
	{ kode: '2hd', tekst: 'Tillegg for kveld, natt, helg og høytid', gruppe: 'tillegg', refusjonOre: 11_900, egenandelOre: 0, verifisert: false }
];

export const TAKST_KART = new Map(TAKSTER.map((t) => [t.kode, t]));

export function hentTakst(kode: string): Takst | undefined {
	return TAKST_KART.get(kode);
}

export function takstEtterGruppe(gruppe: Takstgruppe): Takst[] {
	return TAKSTER.filter((t) => t.gruppe === gruppe);
}

// ---------------------------------------------------------------------------
// Fritak for egenandel
// ---------------------------------------------------------------------------

export type Fritaksgrunn =
	| 'barn-under-16'
	| 'barn-under-18-psykisk'
	| 'yrkesskade'
	| 'svangerskap'
	| 'smittsom-sykdom'
	| 'militartjeneste'
	| 'frikort'
	| 'minstepensjonist-mv';

export const FRITAKSGRUNNER: Record<Fritaksgrunn, string> = {
	'barn-under-16': 'Barn under 16 år',
	'barn-under-18-psykisk': 'Barn under 18 år ved psykisk helsehjelp',
	yrkesskade: 'Godkjent yrkesskade (folketrygdloven § 5-25)',
	svangerskap: 'Svangerskapskontroll',
	'smittsom-sykdom': 'Allmennfarlig smittsom sykdom (smittevernloven)',
	militartjeneste: 'Militær- eller siviltjeneste',
	frikort: 'Gyldig frikort (egenandelstak 1)',
	'minstepensjonist-mv': 'Fritak etter særskilt hjemmel'
};

/** Alderen der egenandel begynner å påløpe. */
export const EGENANDEL_ALDERSGRENSE = 16;

export interface Regningslinje {
	takstkode: string;
	antall: number;
}

export interface Beregning {
	linjer: {
		takstkode: string;
		tekst: string;
		antall: number;
		refusjonOre: number;
		egenandelOre: number;
	}[];
	sumRefusjonOre: number;
	sumEgenandelOre: number;
	/** Egenandel som faktisk kreves inn, etter fritak. */
	kreverEgenandelOre: number;
	fritak: Fritaksgrunn | null;
	feil: string[];
	advarsler: string[];
}

export interface BeregningKontekst {
	erSpesialistAllmennmedisin?: boolean;
	pasientAlder?: number;
	harFrikort?: boolean;
	fritak?: Fritaksgrunn | null;
}

/**
 * Beregner refusjon og egenandel for et sett takster, og kontrollerer
 * kombinasjonsreglene. Regelbrudd stoppes her, ikke først i Helfos avregning -
 * det er forskjellen på å oppdage feilen i dag og å oppdage den om seks uker.
 */
export function beregn(linjer: Regningslinje[], kontekst: BeregningKontekst = {}): Beregning {
	const feil: string[] = [];
	const advarsler: string[] = [];
	const koder = linjer.map((l) => l.takstkode);
	const resultatlinjer: Beregning['linjer'] = [];

	for (const linje of linjer) {
		const takst = TAKST_KART.get(linje.takstkode);
		if (!takst) {
			feil.push(`Ukjent takstkode: ${linje.takstkode}`);
			continue;
		}
		const antall = Math.max(1, Math.floor(linje.antall));
		if (!takst.repeterbar && antall > 1) {
			feil.push(`Takst ${takst.kode} kan ikke repeteres`);
		}
		if (takst.maksAntall && antall > takst.maksAntall) {
			feil.push(`Takst ${takst.kode} kan maksimalt brukes ${takst.maksAntall} ganger`);
		}
		if (takst.kreverSpesialist && !kontekst.erSpesialistAllmennmedisin) {
			feil.push(`Takst ${takst.kode} krever spesialist i allmennmedisin`);
		}
		for (const u of takst.utelukker ?? []) {
			if (koder.includes(u)) feil.push(`Takst ${takst.kode} kan ikke kombineres med ${u}`);
		}
		if (takst.krever && !takst.krever.some((k) => koder.includes(k))) {
			feil.push(`Takst ${takst.kode} krever en av: ${takst.krever.join(', ')}`);
		}
		if (!takst.verifisert) {
			advarsler.push(`Beløpet for takst ${takst.kode} er ikke verifisert mot gjeldende normaltariff`);
		}
		resultatlinjer.push({
			takstkode: takst.kode,
			tekst: takst.tekst,
			antall,
			refusjonOre: takst.refusjonOre * antall,
			egenandelOre: takst.egenandelOre * antall
		});
	}

	const sumRefusjonOre = resultatlinjer.reduce((s, l) => s + l.refusjonOre, 0);
	const sumEgenandelOre = resultatlinjer.reduce((s, l) => s + l.egenandelOre, 0);

	let fritak: Fritaksgrunn | null = kontekst.fritak ?? null;
	if (!fritak && kontekst.pasientAlder !== undefined && kontekst.pasientAlder < EGENANDEL_ALDERSGRENSE) {
		fritak = 'barn-under-16';
	}
	if (!fritak && kontekst.harFrikort) fritak = 'frikort';

	return {
		linjer: resultatlinjer,
		sumRefusjonOre,
		sumEgenandelOre,
		// Ved frikort dekker Helfo egenandelen; ved øvrige fritak bortfaller den.
		kreverEgenandelOre: fritak ? 0 : sumEgenandelOre,
		fritak,
		feil,
		advarsler: [...new Set(advarsler)]
	};
}

export function oreTilKroner(ore: number): string {
	return (ore / 100).toLocaleString('nb-NO', { style: 'currency', currency: 'NOK' });
}
