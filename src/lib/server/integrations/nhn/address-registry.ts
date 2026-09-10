import { config } from '../../config';
import type { Part } from './msg-head';

/**
 * Adresseregisteret i Norsk helsenett.
 *
 * Registeret kobler HER-id til virksomhet, kommunikasjonsparter og hvilke
 * meldingstyper mottakeren faktisk kan ta imot. Å slå opp før sending er det
 * som hindrer at en henvisning havner hos en mottaker som ikke støtter
 * meldingstypen - en av de vanligste feilkildene i meldingsutvekslingen.
 */

export interface CommunicationParty {
	herId: string;
	name: string;
	orgnr?: string;
	type: 'fastlege' | 'sykehus' | 'kommune' | 'laboratorium' | 'rontgen' | 'avtalespesialist' | 'annet';
	overordnet?: string;
	/** Meldingstyper mottakeren kan ta imot. */
	supportsMessages: string[];
	address?: { line?: string; postalCode?: string; poststed?: string };
	active: boolean;
}

/**
 * Testregister brukt i `mock`-modus. I `live`-modus slås oppslag mot
 * Adresseregisterets API på Helsenettet.
 */
const TESTREGISTER: CommunicationParty[] = [
	{
		herId: '8142519', name: 'Oslo universitetssykehus HF - Medisinsk poliklinikk', orgnr: '993467049',
		type: 'sykehus', supportsMessages: ['HENVIS', 'DIALOG_HELSEFAGLIG', 'DIALOG_FORESPORSEL', 'EPIKRISE'],
		address: { line: 'Kirkeveien 166', postalCode: '0450', poststed: 'Oslo' }, active: true
	},
	{
		herId: '8095763', name: 'Fürst Medisinsk Laboratorium', orgnr: '958655689',
		type: 'laboratorium', supportsMessages: ['MEDLAB', 'SVAR_LAB', 'DIALOG_HELSEFAGLIG'],
		address: { line: 'Søren Bulls vei 25', postalCode: '1051', poststed: 'Oslo' }, active: true
	},
	{
		herId: '8034567', name: 'Oslo kommune - Hjemmetjenesten Frogner', orgnr: '958935420',
		type: 'kommune', supportsMessages: ['DIALOG_HELSEFAGLIG', 'DIALOG_FORESPORSEL', 'DIALOG_SVAR'],
		address: { line: 'Sommerrogata 1', postalCode: '0255', poststed: 'Oslo' }, active: true
	},
	{
		herId: '8112233', name: 'Diakonhjemmet Sykehus - Revmatologisk avdeling', orgnr: '981142207',
		type: 'sykehus', supportsMessages: ['HENVIS', 'DIALOG_HELSEFAGLIG', 'EPIKRISE'],
		address: { line: 'Diakonveien 12', postalCode: '0370', poststed: 'Oslo' }, active: true
	},
	{
		herId: '8123001', name: 'Unilabs Røntgen Majorstuen', orgnr: '979924611',
		type: 'rontgen', supportsMessages: ['HENVIS', 'SVAR_LAB'],
		address: { line: 'Sørkedalsveien 10A', postalCode: '0369', poststed: 'Oslo' }, active: true
	},
	{
		herId: '8199001', name: 'Avtalespesialist Dr. Bakke, hudsykdommer', orgnr: '912345678',
		type: 'avtalespesialist', supportsMessages: ['HENVIS', 'DIALOG_HELSEFAGLIG'],
		address: { line: 'Bogstadveien 27', postalCode: '0355', poststed: 'Oslo' }, active: true
	}
];

export async function searchRecipients(search: string, message_type?: string): Promise<CommunicationParty[]> {
	const all = config.integrations.modus === 'mock' ? TESTREGISTER : await searchLive(search);
	const key = search.toLowerCase().trim();
	return all
		.filter((p) => p.active)
		.filter((p) => !key || p.name.toLowerCase().includes(key) || p.herId.includes(key))
		.filter((p) => !message_type || p.supportsMessages.includes(message_type));
}

export async function getRecipient(herId: string): Promise<CommunicationParty | null> {
	if (config.integrations.modus === 'mock') {
		return TESTREGISTER.find((p) => p.herId === herId) ?? null;
	}
	const match = await searchLive(herId);
	return match.find((p) => p.herId === herId) ?? null;
}

async function searchLive(search: string): Promise<CommunicationParty[]> {
	const url = config.integrations.nhn.addressRegistryUrl;
	if (!url) throw new Error('Adresseregisteret er ikke konfigurert (EPJ_NHN_ADRESSEREGISTER_URL)');
	const response = await fetch(`${url}/kommunikasjonsparter?sok=${encodeURIComponent(search)}`, {
		headers: { accept: 'application/json' },
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok) throw new Error(`Adresseregisteret svarte ${response.status}`);
	return (await response.json()) as CommunicationParty[];
}

/** Sjekker at mottakeren kan ta imot meldingstypen før vi sender. */
export async function canReceive(herId: string, message_type: string): Promise<{ ok: boolean; reason?: string }> {
	const part = await getRecipient(herId);
	if (!part) return { ok: false, reason: `HER-id ${herId} finnes ikke i Adresseregisteret` };
	if (!part.active) return { ok: false, reason: `${part.name} er ikke aktiv i Adresseregisteret` };
	if (!part.supportsMessages.includes(message_type)) {
		return { ok: false, reason: `${part.name} tar ikke imot meldingstypen ${message_type}` };
	}
	return { ok: true };
}

export function toPart(k: CommunicationParty): Part {
	return {
		name: k.name,
		identifier: [
			{ id: k.herId, type: 'HER' },
			...(k.orgnr ? [{ id: k.orgnr, type: 'ENH' as const }] : [])
		],
		address: k.address
	};
}
