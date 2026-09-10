/**
 * Norske identifikatorsystemer og kodeverk.
 *
 * OID-ene under er hentet fra Volven/HL7 Norway sine basisprofiler. De som er
 * merket `verifisert: false` MÅ kontrolleres mot volven.no før produksjonssetting
 * - de er lagt inn som plassholdere for å gjøre datamodellen komplett.
 */

export const SYSTEM = {
	// Personidentifikatorer
	FNR: 'urn:oid:2.16.578.1.12.4.1.4.1',
	DNR: 'urn:oid:2.16.578.1.12.4.1.4.2',
	HNR: 'urn:oid:2.16.578.1.12.4.1.4.3',
	// Helsepersonell og virksomhet
	HPR: 'urn:oid:2.16.578.1.12.4.1.4.4',
	ORGNR: 'urn:oid:2.16.578.1.12.4.1.4.101',
	RESH: 'urn:oid:2.16.578.1.12.4.1.4.102',
	HER: 'urn:oid:2.16.578.1.12.4.1.2',
	// Kliniske kodeverk
	ICPC2: 'urn:oid:2.16.578.1.12.4.1.1.7170',
	ICD10: 'urn:oid:2.16.578.1.12.4.1.1.7110',
	NCMP: 'urn:oid:2.16.578.1.12.4.1.1.7280',
	SNOMED: 'http://snomed.info/sct',
	LOINC: 'http://loinc.org',
	// Legemidler
	ATC: 'urn:oid:2.16.578.1.12.4.1.1.7180',
	LEGEMIDDELVERK_VARENR: 'urn:oid:2.16.578.1.12.4.1.1.7424',
	// Takster (Normaltariff for privat allmennpraksis)
	TARIFF: 'urn:oid:2.16.578.1.12.4.1.1.8214',
	// Meldingstyper
	MESSAGETYPE: 'urn:oid:2.16.578.1.12.4.1.1.8279',
	// Helsepersonells kategori (kodeverk 9060)
	HELSEPERSONELLKATEGORI: 'urn:oid:2.16.578.1.12.4.1.1.9060'
} as const;

/** Systemer vi ikke har kunnet verifisere mot Volven i denne leveransen. */
export const NOT_VERIFISERTE_SYSTEMER = new Set<string>([SYSTEM.TARIFF, SYSTEM.MESSAGETYPE, SYSTEM.NCMP]);

const MOD11_VEKT_1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
const MOD11_VEKT_2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/**
 * Validerer fødselsnummer/D-nummer/H-nummer etter Skatteetatens mod11-regler.
 * Godtar D-nummer (dag + 40) og H-nummer (måned + 40).
 */
export function validNorwegianNationalId(nr: string): boolean {
	if (!/^\d{11}$/.test(nr)) return false;
	const s = nr.split('').map(Number);
	const k1 = 11 - (MOD11_VEKT_1.reduce((sum, v, i) => sum + v * s[i], 0) % 11);
	const kontroll1 = k1 === 11 ? 0 : k1;
	if (kontroll1 === 10 || kontroll1 !== s[9]) return false;
	const k2 = 11 - (MOD11_VEKT_2.reduce((sum, v, i) => sum + v * s[i], 0) % 11);
	const kontroll2 = k2 === 11 ? 0 : k2;
	if (kontroll2 === 10 || kontroll2 !== s[10]) return false;
	return validDateDel(nr) !== null;
}

/** Returnerer fødselsdato som ISO-dato, eller null hvis datodelen er ugyldig. */
export function validDateDel(nr: string): string | null {
	if (!/^\d{11}$/.test(nr)) return null;
	let dag = Number(nr.slice(0, 2));
	let maned = Number(nr.slice(2, 4));
	const yearTo = Number(nr.slice(4, 6));
	if (dag > 40) dag -= 40; // D-nummer
	if (maned > 40) maned -= 40; // H-nummer
	if (maned < 1 || maned > 12 || dag < 1 || dag > 31) return null;
	const individ = Number(nr.slice(6, 9));
	const aarhundre = deriveAarhundre(yearTo, individ);
	if (aarhundre === null) return null;
	const year = aarhundre + yearTo;
	const d = new Date(Date.UTC(year, maned - 1, dag));
	if (d.getUTCMonth() !== maned - 1 || d.getUTCDate() !== dag) return null;
	return d.toISOString().slice(0, 10);
}

function deriveAarhundre(yearTo: number, individ: number): number | null {
	if (individ < 500) return 1900;
	if (individ < 750 && yearTo >= 54) return 1800;
	if (individ < 1000 && yearTo < 40) return 2000;
	if (individ >= 900 && yearTo >= 40) return 1900;
	return 1900;
}

export function isDNumber(nr: string): boolean {
	return /^\d{11}$/.test(nr) && Number(nr.slice(0, 2)) > 40;
}

/** Organisasjonsnummer: 9 siffer med mod11-kontrollsiffer. */
export function validOrganisationNumber(nr: string): boolean {
	if (!/^\d{9}$/.test(nr)) return false;
	const vekt = [3, 2, 7, 6, 5, 4, 3, 2];
	const s = nr.split('').map(Number);
	const rest = vekt.reduce((sum, v, i) => sum + v * s[i], 0) % 11;
	const kontroll = rest === 0 ? 0 : 11 - rest;
	return kontroll !== 10 && kontroll === s[8];
}

/** HPR-nummer er 1-9 siffer uten kontrollsiffer. */
export function validHprNumber(nr: string): boolean {
	return /^\d{1,9}$/.test(nr);
}

/** Kjønn utledet fra individsiffer (partall = kvinne). Kun for testdata. */
export function genderFromNationalId(nr: string): 'male' | 'female' | 'unknown' {
	if (!/^\d{11}$/.test(nr)) return 'unknown';
	return Number(nr[8]) % 2 === 0 ? 'female' : 'male';
}

export function maskerNationalId(nr: string): string {
	if (!/^\d{11}$/.test(nr)) return '***';
	return `${nr.slice(0, 6)}*****`;
}
