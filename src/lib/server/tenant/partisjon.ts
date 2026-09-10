import { config } from '../config';
import type { FhirResource } from '../fhir/types';

/**
 * Partisjoner i HAPI FHIR.
 *
 * HAPI skiller virksomhetenes kliniske data med partisjonering. Med
 * `URL_BASED` tenantidentifikasjon inngår partisjonsnavnet i FHIR-URL-en:
 *
 *     /fhir/<partisjonsnavn>/Patient/123
 *
 * Partisjonene administreres gjennom operasjoner på standardpartisjonen. Denne
 * modulen er den eneste som snakker med den; alt annet går gjennom en
 * virksomhets egen partisjon.
 *
 * Referanser på tvers av partisjoner er slått av i serverkonfigurasjonen. En
 * ressurs i én virksomhet kan da ikke peke inn i en annen, selv ikke ved en feil
 * i vår kode.
 */

const ADMIN_PARTISJON = 'DEFAULT';

export interface Partisjon {
	id: number;
	navn: string;
	beskrivelse?: string;
}

function adminUrl(operasjon: string): string {
	const base = config.fhirServer.baseUrl;
	return config.fhirServer.multitenant
		? `${base}/${ADMIN_PARTISJON}/$${operasjon}`
		: `${base}/$${operasjon}`;
}

function autorisasjon(): Record<string, string> {
	const { brukernavn, passord } = config.fhirServer;
	if (!brukernavn) return {};
	return { authorization: `Basic ${Buffer.from(`${brukernavn}:${passord}`).toString('base64')}` };
}

async function kallOperasjon(
	operasjon: string,
	parametre?: { name: string; valueInteger?: number; valueString?: string }[]
): Promise<{ ok: true; svar: FhirResource } | { ok: false; feil: string }> {
	const kropp: FhirResource | undefined = parametre
		? { resourceType: 'Parameters', parameter: parametre }
		: undefined;
	try {
		const svar = await fetch(adminUrl(operasjon), {
			method: kropp ? 'POST' : 'GET',
			headers: {
				accept: 'application/fhir+json',
				...(kropp ? { 'content-type': 'application/fhir+json' } : {}),
				...autorisasjon()
			},
			body: kropp ? JSON.stringify(kropp) : undefined,
			signal: AbortSignal.timeout(config.fhirServer.timeoutMs)
		});
		const tekst = await svar.text();
		if (!svar.ok) {
			return { ok: false, feil: `FHIR-serveren svarte ${svar.status}: ${tekst.slice(0, 300)}` };
		}
		return { ok: true, svar: tekst ? (JSON.parse(tekst) as FhirResource) : { resourceType: 'Parameters' } };
	} catch (err) {
		return { ok: false, feil: (err as Error).message };
	}
}

export async function opprettPartisjon(
	id: number,
	navn: string,
	beskrivelse: string
): Promise<{ ok: true; partisjon: Partisjon } | { ok: false; feil: string }> {
	const svar = await kallOperasjon('partition-management-create-partition', [
		{ name: 'id', valueInteger: id },
		{ name: 'name', valueString: navn },
		{ name: 'description', valueString: beskrivelse }
	]);
	if (!svar.ok) return svar;
	return { ok: true, partisjon: { id, navn, beskrivelse } };
}

export async function listPartisjoner(): Promise<
	{ ok: true; partisjoner: Partisjon[] } | { ok: false; feil: string }
> {
	const svar = await kallOperasjon('partition-management-list-partitions');
	if (!svar.ok) return svar;

	// HAPI svarer med Parameters der hver `partition` har `id`, `name` og
	// `description` som deler.
	const deler = (svar.svar.parameter as { name: string; part?: { name: string; valueInteger?: number; valueString?: string }[] }[] | undefined) ?? [];
	const partisjoner: Partisjon[] = deler
		.filter((d) => d.part)
		.map((d) => {
			const finn = (navn: string) => d.part?.find((p) => p.name === navn);
			return {
				id: finn('id')?.valueInteger ?? 0,
				navn: finn('name')?.valueString ?? '',
				beskrivelse: finn('description')?.valueString
			};
		})
		.filter((p) => p.navn);
	return { ok: true, partisjoner };
}

export async function slettPartisjon(id: number): Promise<{ ok: boolean; feil?: string }> {
	const svar = await kallOperasjon('partition-management-delete-partition', [
		{ name: 'id', valueInteger: id }
	]);
	return svar.ok ? { ok: true } : { ok: false, feil: svar.feil };
}

/** Kontrollerer at HAPI er konfigurert for partisjonering. */
export async function partisjoneringVirker(): Promise<{ ok: boolean; feil?: string }> {
	const svar = await listPartisjoner();
	if (!svar.ok) {
		return {
			ok: false,
			feil: `${svar.feil}. Kontroller at HAPI kjører med partisjonering og URL_BASED tenantidentifikasjon.`
		};
	}
	return { ok: true };
}
