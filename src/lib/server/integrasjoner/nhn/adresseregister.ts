import { config } from '../../config';
import type { Part } from './hodemelding';

/**
 * Adresseregisteret i Norsk helsenett.
 *
 * Registeret kobler HER-id til virksomhet, kommunikasjonsparter og hvilke
 * meldingstyper mottakeren faktisk kan ta imot. Å slå opp før sending er det
 * som hindrer at en henvisning havner hos en mottaker som ikke støtter
 * meldingstypen - en av de vanligste feilkildene i meldingsutvekslingen.
 */

export interface Kommunikasjonspart {
	herId: string;
	navn: string;
	orgnr?: string;
	type: 'fastlege' | 'sykehus' | 'kommune' | 'laboratorium' | 'rontgen' | 'avtalespesialist' | 'annet';
	overordnet?: string;
	/** Meldingstyper mottakeren kan ta imot. */
	stotterMeldinger: string[];
	adresse?: { linje?: string; postnummer?: string; poststed?: string };
	aktiv: boolean;
}

/**
 * Testregister brukt i `mock`-modus. I `live`-modus slås oppslag mot
 * Adresseregisterets API på Helsenettet.
 */
const TESTREGISTER: Kommunikasjonspart[] = [
	{
		herId: '8142519', navn: 'Oslo universitetssykehus HF - Medisinsk poliklinikk', orgnr: '993467049',
		type: 'sykehus', stotterMeldinger: ['HENVIS', 'DIALOG_HELSEFAGLIG', 'DIALOG_FORESPORSEL', 'EPIKRISE'],
		adresse: { linje: 'Kirkeveien 166', postnummer: '0450', poststed: 'Oslo' }, aktiv: true
	},
	{
		herId: '8095763', navn: 'Fürst Medisinsk Laboratorium', orgnr: '958655689',
		type: 'laboratorium', stotterMeldinger: ['MEDLAB', 'SVAR_LAB', 'DIALOG_HELSEFAGLIG'],
		adresse: { linje: 'Søren Bulls vei 25', postnummer: '1051', poststed: 'Oslo' }, aktiv: true
	},
	{
		herId: '8034567', navn: 'Oslo kommune - Hjemmetjenesten Frogner', orgnr: '958935420',
		type: 'kommune', stotterMeldinger: ['DIALOG_HELSEFAGLIG', 'DIALOG_FORESPORSEL', 'DIALOG_SVAR'],
		adresse: { linje: 'Sommerrogata 1', postnummer: '0255', poststed: 'Oslo' }, aktiv: true
	},
	{
		herId: '8112233', navn: 'Diakonhjemmet Sykehus - Revmatologisk avdeling', orgnr: '981142207',
		type: 'sykehus', stotterMeldinger: ['HENVIS', 'DIALOG_HELSEFAGLIG', 'EPIKRISE'],
		adresse: { linje: 'Diakonveien 12', postnummer: '0370', poststed: 'Oslo' }, aktiv: true
	},
	{
		herId: '8123001', navn: 'Unilabs Røntgen Majorstuen', orgnr: '979924611',
		type: 'rontgen', stotterMeldinger: ['HENVIS', 'SVAR_LAB'],
		adresse: { linje: 'Sørkedalsveien 10A', postnummer: '0369', poststed: 'Oslo' }, aktiv: true
	},
	{
		herId: '8199001', navn: 'Avtalespesialist Dr. Bakke, hudsykdommer', orgnr: '912345678',
		type: 'avtalespesialist', stotterMeldinger: ['HENVIS', 'DIALOG_HELSEFAGLIG'],
		adresse: { linje: 'Bogstadveien 27', postnummer: '0355', poststed: 'Oslo' }, aktiv: true
	}
];

export async function sokMottakere(sok: string, meldingstype?: string): Promise<Kommunikasjonspart[]> {
	const alle = config.integrasjoner.modus === 'mock' ? TESTREGISTER : await sokLive(sok);
	const nøkkel = sok.toLowerCase().trim();
	return alle
		.filter((p) => p.aktiv)
		.filter((p) => !nøkkel || p.navn.toLowerCase().includes(nøkkel) || p.herId.includes(nøkkel))
		.filter((p) => !meldingstype || p.stotterMeldinger.includes(meldingstype));
}

export async function hentMottaker(herId: string): Promise<Kommunikasjonspart | null> {
	if (config.integrasjoner.modus === 'mock') {
		return TESTREGISTER.find((p) => p.herId === herId) ?? null;
	}
	const treff = await sokLive(herId);
	return treff.find((p) => p.herId === herId) ?? null;
}

async function sokLive(sok: string): Promise<Kommunikasjonspart[]> {
	const url = config.integrasjoner.nhn.adresseregisterUrl;
	if (!url) throw new Error('Adresseregisteret er ikke konfigurert (EPJ_NHN_ADRESSEREGISTER_URL)');
	const svar = await fetch(`${url}/kommunikasjonsparter?sok=${encodeURIComponent(sok)}`, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(15_000)
	});
	if (!svar.ok) throw new Error(`Adresseregisteret svarte ${svar.status}`);
	return (await svar.json()) as Kommunikasjonspart[];
}

/** Sjekker at mottakeren kan ta imot meldingstypen før vi sender. */
export async function kanMotta(herId: string, meldingstype: string): Promise<{ ok: boolean; grunn?: string }> {
	const part = await hentMottaker(herId);
	if (!part) return { ok: false, grunn: `HER-id ${herId} finnes ikke i Adresseregisteret` };
	if (!part.aktiv) return { ok: false, grunn: `${part.navn} er ikke aktiv i Adresseregisteret` };
	if (!part.stotterMeldinger.includes(meldingstype)) {
		return { ok: false, grunn: `${part.navn} tar ikke imot meldingstypen ${meldingstype}` };
	}
	return { ok: true };
}

export function tilPart(k: Kommunikasjonspart): Part {
	return {
		navn: k.navn,
		ident: [
			{ id: k.herId, type: 'HER' },
			...(k.orgnr ? [{ id: k.orgnr, type: 'ENH' as const }] : [])
		],
		adresse: k.adresse
	};
}
