import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Test double for HAPI FHIR.
 *
 * This is NOT a FHIR server for production - it exists only so the tests can
 * run without Docker. It speaks the part of the FHIR REST protocol that
 * `fhir/client.ts` actually uses (read, vread, search via POST /_search,
 * create, update, delete, transaction, $everything, $validate, metadata), so
 * the guard in `fhir/gateway.ts` can be tested over real HTTP.
 *
 * The real HAPI server is run in docker-compose and in the CI job
 * `integrasjon-hapi`, which runs the same test suite against hapiproject/hapi.
 */

export type ResourceStore = Map<string, Map<string, Record<string, unknown>>>;

export interface TestFhirServer {
	url: string;
	server: Server | null;
	/** True when the tests run against a real HAPI server instead of the double. */
	isEkte: boolean;
	/** The contents of the unpartitioned root. See `lagerFor` for the partitions. */
	store: ResourceStore;
	/** The contents of one partition. An empty map if the partition is unused. */
	storeFor(partition: string): ResourceStore;
	/** The partitions the server knows, as $partition-management-list-partitions answers. */
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
 * Provides a FHIR server to the tests.
 *
 * With EPJ_USE_REAL_HAPI=1 the tests are pointed at a real HAPI server rather
 * than the double. The same test suite then runs against the real
 * implementation, as the CI job `integrasjon-hapi` does.
 */
export async function fhirForTest(): Promise<TestFhirServer> {
	if (process.env.EPJ_USE_REAL_HAPI === '1') {
		const url = process.env.EPJ_HAPI_BASE_URL;
		if (!url) throw new Error('EPJ_USE_REAL_HAPI krever EPJ_HAPI_BASE_URL');
		return {
			url,
			server: null,
			isEkte: true,
			store: new Map(),
			storeFor: () => new Map(),
			partitions: () => [],
			call: [],
			nullstill() {
				/* A real server is not emptied between tests; the tests make their own patients. */
			},
			close: async () => undefined
		};
	}
	return startTestFhirServer();
}

/**
 * Partitioning.
 *
 * HAPI with `URL_BASED` tenant identification puts the partition name in front
 * of the resource type: /fhir/<partition>/Patient/123. The double does the
 * same, and keeps one store per partition. That isolation is exactly what
 * multitenancy rests on, so it must be tested - not assumed.
 *
 * Resource types in FHIR always begin with a capital letter, and partition
 * names are lower case (or `DEFAULT`). The segments cannot be confused.
 */
const PARTISJONSNAVN = /^(DEFAULT|[a-z][a-z0-9-]{1,30})$/;

function isPartisjonssegment(segment: string): boolean {
	return PARTISJONSNAVN.test(segment) && segment !== 'metadata';
}

export async function startTestFhirServer(): Promise<TestFhirServer> {
	// '' is the root: it is used when the server runs without partitioning.
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

			// Separate the partition segment from the rest, as HAPI does with URL_BASED.
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

			// --- Partition administration (called on the default partition) ---
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
