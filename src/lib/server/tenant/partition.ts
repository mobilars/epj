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

const ADMIN_PARTITION = 'DEFAULT';

export interface Partition {
	id: number;
	name: string;
	description?: string;
}

function adminUrl(operation: string): string {
	const base = config.fhirServer.baseUrl;
	return config.fhirServer.multitenant
		? `${base}/${ADMIN_PARTITION}/$${operation}`
		: `${base}/$${operation}`;
}

function authorisation(): Record<string, string> {
	const { username, password } = config.fhirServer;
	if (!username) return {};
	return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
}

async function callOperation(
	operation: string,
	parametre?: { name: string; valueInteger?: number; valueString?: string }[]
): Promise<{ ok: true; response: FhirResource } | { ok: false; error: string }> {
	const body: FhirResource | undefined = parametre
		? { resourceType: 'Parameters', parameter: parametre }
		: undefined;
	try {
		const response = await fetch(adminUrl(operation), {
			method: body ? 'POST' : 'GET',
			headers: {
				accept: 'application/fhir+json',
				...(body ? { 'content-type': 'application/fhir+json' } : {}),
				...authorisation()
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(config.fhirServer.timeoutMs)
		});
		const text = await response.text();
		if (!response.ok) {
			return { ok: false, error: `FHIR-serveren svarte ${response.status}: ${text.slice(0, 300)}` };
		}
		return { ok: true, response: text ? (JSON.parse(text) as FhirResource) : { resourceType: 'Parameters' } };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

export async function createPartition(
	id: number,
	name: string,
	description: string
): Promise<{ ok: true; partition: Partition } | { ok: false; error: string }> {
	const response = await callOperation('partition-management-create-partition', [
		{ name: 'id', valueInteger: id },
		{ name: 'name', valueString: name },
		{ name: 'description', valueString: description }
	]);
	if (!response.ok) return response;
	return { ok: true, partition: { id, name, description } };
}

export async function listPartitions(): Promise<
	{ ok: true; partitions: Partition[] } | { ok: false; error: string }
> {
	const response = await callOperation('partition-management-list-partitions');
	if (!response.ok) return response;

	// HAPI svarer med Parameters der hver `partition` har `id`, `name` og
	// `description` som deler.
	const parts = (response.response.parameter as { name: string; part?: { name: string; valueInteger?: number; valueString?: string }[] }[] | undefined) ?? [];
	const partitions: Partition[] = parts
		.filter((d) => d.part)
		.map((d) => {
			const find = (name: string) => d.part?.find((p) => p.name === name);
			return {
				id: find('id')?.valueInteger ?? 0,
				name: find('name')?.valueString ?? '',
				description: find('description')?.valueString
			};
		})
		.filter((p) => p.name);
	return { ok: true, partitions };
}

export async function deletePartition(id: number): Promise<{ ok: boolean; error?: string }> {
	const response = await callOperation('partition-management-delete-partition', [
		{ name: 'id', valueInteger: id }
	]);
	return response.ok ? { ok: true } : { ok: false, error: response.error };
}

/** Kontrollerer at HAPI er konfigurert for partisjonering. */
export async function partitioningWorks(): Promise<{ ok: boolean; error?: string }> {
	const response = await listPartitions();
	if (!response.ok) {
		return {
			ok: false,
			error: `${response.error}. Kontroller at HAPI kjører med partisjonering og URL_BASED tenantidentifikasjon.`
		};
	}
	return { ok: true };
}
