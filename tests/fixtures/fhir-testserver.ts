import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Testdobbel for HAPI FHIR.
 *
 * Dette er IKKE en FHIR-server for produksjon - den finnes bare for at testene
 * skal kunne kjøre uten Docker. Den snakker den delen av FHIR REST-protokollen
 * som `fhir/client.ts` faktisk bruker (les, vread, søk via POST /_search,
 * opprett, oppdater, slett, transaksjon, $everything, $validate, metadata),
 * slik at vokteren i `fhir/gateway.ts` kan testes over ekte HTTP.
 *
 * Den ekte HAPI-serveren kjøres i docker-compose og i CI-jobben
 * `integrasjon-hapi`, som kjører den samme testsuiten mot hapiproject/hapi.
 */

export type ResourceStore = Map<string, Map<string, Record<string, unknown>>>;

export interface TestFhirServer {
	url: string;
	server: Server | null;
	/** True når testene kjører mot en ekte HAPI-server i stedet for dobbelen. */
	isEkte: boolean;
	/** Innholdet i den upartisjonerte roten. Se `lagerFor` for partisjonene. */
	store: ResourceStore;
	/** Innholdet i én partisjon. Tomt kart hvis partisjonen ikke er tatt i bruk. */
	storeFor(partition: string): ResourceStore;
	/** Partisjonene serveren kjenner, slik $partition-management-list-partitions svarer. */
	partitions(): { id: number; name: string }[];
	call: { method: string; path: string; partition: string }[];
	close(): Promise<void>;
	nullstill(): void;
}

const SOKEFELT: Record<string, (r: Record<string, unknown>) => string[]> = {
	_id: (r) => [String(r.id ?? '')],
	patient: (r) => refValues(r, ['subject', 'patient', 'beneficiary', 'for']),
	subject: (r) => refValues(r, ['subject', 'patient']),
	identifier: (r) =>
		((r.identifier as { system?: string; value?: string }[] | undefined) ?? []).flatMap((i) =>
			[i.value ?? '', `${i.system ?? ''}|${i.value ?? ''}`].filter(Boolean)
		),
	status: (r) => [String(r.status ?? '')],
	name: (r) =>
		((r.name as { given?: string[]; family?: string }[] | undefined) ?? []).flatMap((n) => [
			...(n.given ?? []),
			n.family ?? ''
		]),
	category: (r) => codeValues(r.category),
	code: (r) => codeValues(r.code),
	encounter: (r) => refValues(r, ['encounter'])
};

function refValues(r: Record<string, unknown>, field: string[]): string[] {
	const out: string[] = [];
	for (const f of field) {
		const v = r[f];
		const references = Array.isArray(v) ? v : [v];
		for (const ref of references) {
			const s = (ref as { reference?: string })?.reference;
			if (s) out.push(s, s.split('/').pop() ?? s);
		}
	}
	return out;
}

function codeValues(v: unknown): string[] {
	const list = Array.isArray(v) ? v : [v];
	return list.flatMap((cc) => {
		const codings = (cc as { coding?: { system?: string; code?: string }[] })?.coding ?? [];
		return codings.flatMap((c) => [c.code ?? '', `${c.system ?? ''}|${c.code ?? ''}`].filter(Boolean));
	});
}

/**
 * Gir en FHIR-server til testene.
 *
 * Med EPJ_BRUK_EKTE_HAPI=1 pekes testene mot en ekte HAPI-server i stedet for
 * dobbelen. Da kjøres den samme testsuiten mot den virkelige implementasjonen,
 * slik CI-jobben `integrasjon-hapi` gjør.
 */
export async function fhirForTest(): Promise<TestFhirServer> {
	if (process.env.EPJ_BRUK_EKTE_HAPI === '1') {
		const url = process.env.EPJ_HAPI_BASE_URL;
		if (!url) throw new Error('EPJ_BRUK_EKTE_HAPI krever EPJ_HAPI_BASE_URL');
		return {
			url,
			server: null,
			isEkte: true,
			store: new Map(),
			storeFor: () => new Map(),
			partitions: () => [],
			call: [],
			nullstill() {
				/* En ekte server tømmes ikke mellom tester; testene lager egne pasienter. */
			},
			close: async () => undefined
		};
	}
	return startTestFhirServer();
}

/**
 * Partisjonering.
 *
 * HAPI med `URL_BASED` tenantidentifikasjon legger partisjonsnavnet foran
 * ressurstypen: /fhir/<partisjon>/Patient/123. Dobbelen gjør det samme, og
 * holder ett lager per partisjon. Det er nettopp den isolasjonen
 * multitenancy hviler på, så den må testes - ikke antas.
 *
 * Ressurstyper i FHIR begynner alltid med stor bokstav, og partisjonsnavn er
 * små bokstaver (eller `DEFAULT`). Segmentene kan derfor ikke forveksles.
 */
const PARTISJONSNAVN = /^(DEFAULT|[a-z][a-z0-9-]{1,30})$/;

function isPartisjonssegment(segment: string): boolean {
	return PARTISJONSNAVN.test(segment) && segment !== 'metadata';
}

export async function startTestFhirServer(): Promise<TestFhirServer> {
	// '' er roten: den brukes når serveren kjøres uten partisjonering.
	const partitionStores = new Map<string, ResourceStore>([['', new Map()]]);
	const partitionRegistry = new Map<string, { id: number; name: string; description?: string }>([
		['DEFAULT', { id: 0, name: 'DEFAULT', description: 'Standardpartisjon' }]
	]);
	const history = new Map<string, Record<string, unknown>[]>();
	const call: { method: string; path: string; partition: string }[] = [];

	const store = partitionStores.get('') as ResourceStore;

	const storeFor = (partition: string): ResourceStore => {
		if (!partitionStores.has(partition)) partitionStores.set(partition, new Map());
		return partitionStores.get(partition) as ResourceStore;
	};

	const get = (partition: string, type: string) => {
		const l = storeFor(partition);
		if (!l.has(type)) l.set(type, new Map());
		return l.get(type) as Map<string, Record<string, unknown>>;
	};

	function saveResource(partition: string, type: string, id: string, resource: Record<string, unknown>): Record<string, unknown> {
		const previous = get(partition, type).get(id);
		const version = previous ? Number((previous.meta as { versionId?: string })?.versionId ?? 1) + 1 : 1;
		const stored = {
			...resource,
			resourceType: type,
			id,
			meta: { ...(resource.meta as object), versionId: String(version), loadUpdated: new Date().toISOString() }
		};
		get(partition, type).set(id, stored);
		const key = `${partition}:${type}/${id}`;
		history.set(key, [...(history.get(key) ?? []), stored]);
		return stored;
	}

	function search(partition: string, type: string, params: URLSearchParams): Record<string, unknown> {
		let match = [...get(partition, type).values()];
		for (const [key, value] of params) {
			if (key.startsWith('_') && key !== '_id') continue;
			const extract = SOKEFELT[key.split(':')[0]];
			if (!extract) continue;
			const onskede = value.split(',');
			match = match.filter((r) => extract(r).some((v) => onskede.includes(v)));
		}
		const count = Number(params.get('_count') ?? 50);
		return {
			resourceType: 'Bundle',
			type: 'searchset',
			total: match.length,
			entry: match.slice(0, count).map((r) => ({
				fullUrl: `http://test/fhir/${r.resourceType}/${r.id}`,
				resource: r,
				search: { mode: 'match' }
			}))
		};
	}

	const server = createServer((req, res) => {
		const biter: Buffer[] = [];
		req.on('data', (b) => biter.push(b));
		req.on('end', () => {
			const url = new URL(req.url ?? '/', 'http://test');
			const helPath = url.pathname.replace(/^\/fhir\/?/, '');
			const body = Buffer.concat(biter).toString('utf8');

			// Skill partisjonssegmentet fra resten, slik HAPI gjør med URL_BASED.
			const allParts = helPath.split('/').filter(Boolean);
			const partition = allParts.length && isPartisjonssegment(allParts[0]) ? allParts[0] : '';
			const path = partition ? allParts.slice(1).join('/') : helPath;
			call.push({ method: req.method ?? 'GET', path, partition });

			const response = (status: number, data: unknown, headers: Record<string, string> = {}) => {
				res.writeHead(status, { 'content-type': 'application/fhir+json', ...headers });
				res.end(JSON.stringify(data));
			};
			const error = (status: number, text: string) =>
				response(status, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'processing', diagnostics: text }] });

			const parts = path.split('/').filter(Boolean);

			// --- Partisjonsadministrasjon (kalles på standardpartisjonen) -----
			if (parts.length === 1 && parts[0].startsWith('$partition-management-')) {
				const operation = parts[0].slice('$partition-management-'.length);
				const inValue = body ? (JSON.parse(body) as { parameter?: { name: string; valueInteger?: number; valueString?: string }[] }) : {};
				const part = (name: string) => inValue.parameter?.find((p) => p.name === name);

				if (operation === 'list-partitions') {
					return response(200, {
						resourceType: 'Parameters',
						parameter: [...partitionRegistry.values()].map((p) => ({
							name: 'partition',
							part: [
								{ name: 'id', valueInteger: p.id },
								{ name: 'name', valueString: p.name },
								{ name: 'description', valueString: p.description ?? '' }
							]
						}))
					});
				}
				if (operation === 'create-partition') {
					const id = part('id')?.valueInteger ?? 0;
					const name = part('name')?.valueString ?? '';
					if (!name) return error(400, 'Partisjonen må ha et navn');
					if (partitionRegistry.has(name)) return error(400, `Partisjonen ${name} finnes allerede`);
					if ([...partitionRegistry.values()].some((p) => p.id === id)) {
						return error(400, `Partisjons-id ${id} er allerede i bruk`);
					}
					partitionRegistry.set(name, { id, name, description: part('description')?.valueString });
					storeFor(name);
					return response(200, {
						resourceType: 'Parameters',
						parameter: [
							{ name: 'id', valueInteger: id },
							{ name: 'name', valueString: name }
						]
					});
				}
				if (operation === 'delete-partition') {
					const id = part('id')?.valueInteger ?? -1;
					const funnet = [...partitionRegistry.values()].find((p) => p.id === id);
					if (!funnet) return error(404, `Ukjent partisjon ${id}`);
					partitionRegistry.delete(funnet.name);
					partitionStores.delete(funnet.name);
					return response(200, { resourceType: 'Parameters', parameter: [] });
				}
				return error(400, `Ukjent partisjonsoperasjon: ${operation}`);
			}

			if (parts[0] === 'metadata') {
				return response(200, {
					resourceType: 'CapabilityStatement',
					status: 'active',
					date: new Date().toISOString(),
					fhirVersion: '5.0.0',
					format: ['application/fhir+json'],
					rest: [{ mode: 'server', resource: [...storeFor(partition).keys()].map((t) => ({ type: t })) }]
				});
			}

			// Transaksjon / batch
			if (parts.length === 0 && req.method === 'POST') {
				const bundle = JSON.parse(body) as { type: string; entry?: { resource?: Record<string, unknown>; request?: { method: string; url: string } }[] };
				const responseOppforinger = (bundle.entry ?? []).map((e) => {
					const method = e.request?.method ?? 'POST';
					const targetUrl = e.request?.url ?? '';
					const type = e.resource?.resourceType ?? targetUrl.split('/')[0];
					if (method === 'POST' && e.resource) {
						const stored = saveResource(partition, type as string, randomUUID(), e.resource);
						return { response: { status: '201 Created', location: `${type}/${stored.id}` }, resource: stored };
					}
					if (method === 'PUT' && e.resource) {
						const id = targetUrl.split('/')[1] ?? (e.resource.id as string);
						const stored = saveResource(partition, type as string, id, e.resource);
						return { response: { status: '200 OK' }, resource: stored };
					}
					if (method === 'DELETE') {
						const [t, id] = targetUrl.split('/');
						get(partition, t).delete(id);
						return { response: { status: '204 No Content' } };
					}
					return { response: { status: '200 OK' } };
				});
				return response(200, { resourceType: 'Bundle', type: `${bundle.type}-response`, entry: responseOppforinger });
			}

			const type = parts[0];

			if (parts.length === 2 && parts[1] === '_search' && req.method === 'POST') {
				return response(200, search(partition, type, new URLSearchParams(body)));
			}
			if (parts.length === 1 && req.method === 'GET') {
				return response(200, search(partition, type, url.searchParams));
			}
			if (parts.length === 1 && req.method === 'POST') {
				const resource = JSON.parse(body) as Record<string, unknown>;
				const stored = saveResource(partition, type, (resource.id as string) ?? randomUUID(), resource);
				const prefiks = partition ? `/fhir/${partition}` : '/fhir';
				return response(201, stored, { location: `${prefiks}/${type}/${stored.id}`, etag: `W/"${(stored.meta as { versionId: string }).versionId}"` });
			}
			if (parts.length === 2 && parts[1] === '$validate' && req.method === 'POST') {
				return response(200, { resourceType: 'OperationOutcome', issue: [] });
			}

			const id = parts[1];

			if (parts.length === 3 && parts[2] === '$everything') {
				const patient = get(partition, 'Patient').get(id);
				if (!patient) return error(404, 'Ukjent pasient');
				const all: Record<string, unknown>[] = [patient];
				for (const [t, m] of storeFor(partition)) {
					if (t === 'Patient') continue;
					for (const r of m.values()) {
						if (refValues(r, ['subject', 'patient', 'beneficiary', 'for']).includes(`Patient/${id}`)) all.push(r);
					}
				}
				return response(200, { resourceType: 'Bundle', type: 'searchset', total: all.length, entry: all.map((r) => ({ resource: r })) });
			}
			if (parts.length === 3 && parts[2] === '_history') {
				const versjoner = history.get(`${partition}:${type}/${id}`) ?? [];
				return response(200, { resourceType: 'Bundle', type: 'history', total: versjoner.length, entry: versjoner.map((r) => ({ resource: r })) });
			}
			if (parts.length === 4 && parts[2] === '_history') {
				const version = (history.get(`${partition}:${type}/${id}`) ?? []).find((r) => (r.meta as { versionId: string }).versionId === parts[3]);
				return version ? response(200, version) : error(404, 'Ukjent versjon');
			}

			if (parts.length === 2) {
				switch (req.method) {
					case 'GET': {
						const r = get(partition, type).get(id);
						return r
							? response(200, r, { etag: `W/"${(r.meta as { versionId: string }).versionId}"`, 'last-modified': String((r.meta as { loadUpdated: string }).loadUpdated) })
							: error(404, `${type}/${id} finnes ikke`);
					}
					case 'PUT': {
						const resource = JSON.parse(body) as Record<string, unknown>;
						const fantes = get(partition, type).has(id);
						const stored = saveResource(partition, type, id, resource);
						return response(fantes ? 200 : 201, stored, { etag: `W/"${(stored.meta as { versionId: string }).versionId}"` });
					}
					case 'DELETE': {
						const fantes = get(partition, type).delete(id);
						return response(fantes ? 200 : 404, { resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'informational', diagnostics: 'Slettet' }] });
					}
					case 'PATCH': {
						const current = get(partition, type).get(id);
						if (!current) return error(404, 'Ukjent ressurs');
						const patcher = JSON.parse(body) as { op: string; path: string; value: unknown }[];
						const kopi = { ...current };
						for (const p of patcher) {
							if (p.op === 'replace' || p.op === 'add') kopi[p.path.replace(/^\//, '')] = p.value;
						}
						return response(200, saveResource(partition, type, id, kopi));
					}
				}
			}
			return error(404, `Ukjent sti: ${path}`);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const port = typeof address === 'object' && address ? address.port : 0;

	return {
		url: `http://127.0.0.1:${port}/fhir`,
		server,
		isEkte: false,
		store,
		storeFor,
		partitions: () => [...partitionRegistry.values()].map((p) => ({ id: p.id, name: p.name })),
		call,
		nullstill() {
			for (const l of partitionStores.values()) l.clear();
			partitionRegistry.clear();
			partitionRegistry.set('DEFAULT', { id: 0, name: 'DEFAULT', description: 'Standardpartisjon' });
			history.clear();
			call.length = 0;
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve()))
	};
}
