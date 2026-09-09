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

export interface TestFhirServer {
	url: string;
	server: Server | null;
	/** True når testene kjører mot en ekte HAPI-server i stedet for dobbelen. */
	erEkte: boolean;
	lager: Map<string, Map<string, Record<string, unknown>>>;
	kall: { metode: string; sti: string }[];
	lukk(): Promise<void>;
	nullstill(): void;
}

const SOKEFELT: Record<string, (r: Record<string, unknown>) => string[]> = {
	_id: (r) => [String(r.id ?? '')],
	patient: (r) => refVerdier(r, ['subject', 'patient', 'beneficiary', 'for']),
	subject: (r) => refVerdier(r, ['subject', 'patient']),
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
	category: (r) => kodeVerdier(r.category),
	code: (r) => kodeVerdier(r.code),
	encounter: (r) => refVerdier(r, ['encounter'])
};

function refVerdier(r: Record<string, unknown>, felt: string[]): string[] {
	const ut: string[] = [];
	for (const f of felt) {
		const v = r[f];
		const referanser = Array.isArray(v) ? v : [v];
		for (const ref of referanser) {
			const s = (ref as { reference?: string })?.reference;
			if (s) ut.push(s, s.split('/').pop() ?? s);
		}
	}
	return ut;
}

function kodeVerdier(v: unknown): string[] {
	const liste = Array.isArray(v) ? v : [v];
	return liste.flatMap((cc) => {
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
			erEkte: true,
			lager: new Map(),
			kall: [],
			nullstill() {
				/* En ekte server tømmes ikke mellom tester; testene lager egne pasienter. */
			},
			lukk: async () => undefined
		};
	}
	return startTestFhirServer();
}

export async function startTestFhirServer(): Promise<TestFhirServer> {
	const lager = new Map<string, Map<string, Record<string, unknown>>>();
	const historikk = new Map<string, Record<string, unknown>[]>();
	const kall: { metode: string; sti: string }[] = [];

	const hent = (type: string) => {
		if (!lager.has(type)) lager.set(type, new Map());
		return lager.get(type) as Map<string, Record<string, unknown>>;
	};

	function lagre(type: string, id: string, ressurs: Record<string, unknown>): Record<string, unknown> {
		const forrige = hent(type).get(id);
		const versjon = forrige ? Number((forrige.meta as { versionId?: string })?.versionId ?? 1) + 1 : 1;
		const lagret = {
			...ressurs,
			resourceType: type,
			id,
			meta: { ...(ressurs.meta as object), versionId: String(versjon), lastUpdated: new Date().toISOString() }
		};
		hent(type).set(id, lagret);
		const nokkel = `${type}/${id}`;
		historikk.set(nokkel, [...(historikk.get(nokkel) ?? []), lagret]);
		return lagret;
	}

	function sok(type: string, params: URLSearchParams): Record<string, unknown> {
		let treff = [...hent(type).values()];
		for (const [nokkel, verdi] of params) {
			if (nokkel.startsWith('_') && nokkel !== '_id') continue;
			const uttrekk = SOKEFELT[nokkel.split(':')[0]];
			if (!uttrekk) continue;
			const onskede = verdi.split(',');
			treff = treff.filter((r) => uttrekk(r).some((v) => onskede.includes(v)));
		}
		const count = Number(params.get('_count') ?? 50);
		return {
			resourceType: 'Bundle',
			type: 'searchset',
			total: treff.length,
			entry: treff.slice(0, count).map((r) => ({
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
			const sti = url.pathname.replace(/^\/fhir\/?/, '');
			const kropp = Buffer.concat(biter).toString('utf8');
			kall.push({ metode: req.method ?? 'GET', sti });

			const svar = (status: number, data: unknown, headers: Record<string, string> = {}) => {
				res.writeHead(status, { 'content-type': 'application/fhir+json', ...headers });
				res.end(JSON.stringify(data));
			};
			const feil = (status: number, tekst: string) =>
				svar(status, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'processing', diagnostics: tekst }] });

			const deler = sti.split('/').filter(Boolean);

			if (deler[0] === 'metadata') {
				return svar(200, {
					resourceType: 'CapabilityStatement',
					status: 'active',
					date: new Date().toISOString(),
					fhirVersion: '5.0.0',
					format: ['application/fhir+json'],
					rest: [{ mode: 'server', resource: [...lager.keys()].map((t) => ({ type: t })) }]
				});
			}

			// Transaksjon / batch
			if (deler.length === 0 && req.method === 'POST') {
				const bundle = JSON.parse(kropp) as { type: string; entry?: { resource?: Record<string, unknown>; request?: { method: string; url: string } }[] };
				const svarOppforinger = (bundle.entry ?? []).map((e) => {
					const metode = e.request?.method ?? 'POST';
					const målUrl = e.request?.url ?? '';
					const type = e.resource?.resourceType ?? målUrl.split('/')[0];
					if (metode === 'POST' && e.resource) {
						const lagret = lagre(type as string, randomUUID(), e.resource);
						return { response: { status: '201 Created', location: `${type}/${lagret.id}` }, resource: lagret };
					}
					if (metode === 'PUT' && e.resource) {
						const id = målUrl.split('/')[1] ?? (e.resource.id as string);
						const lagret = lagre(type as string, id, e.resource);
						return { response: { status: '200 OK' }, resource: lagret };
					}
					if (metode === 'DELETE') {
						const [t, id] = målUrl.split('/');
						hent(t).delete(id);
						return { response: { status: '204 No Content' } };
					}
					return { response: { status: '200 OK' } };
				});
				return svar(200, { resourceType: 'Bundle', type: `${bundle.type}-response`, entry: svarOppforinger });
			}

			const type = deler[0];

			if (deler.length === 2 && deler[1] === '_search' && req.method === 'POST') {
				return svar(200, sok(type, new URLSearchParams(kropp)));
			}
			if (deler.length === 1 && req.method === 'GET') {
				return svar(200, sok(type, url.searchParams));
			}
			if (deler.length === 1 && req.method === 'POST') {
				const ressurs = JSON.parse(kropp) as Record<string, unknown>;
				const lagret = lagre(type, (ressurs.id as string) ?? randomUUID(), ressurs);
				return svar(201, lagret, { location: `/fhir/${type}/${lagret.id}`, etag: `W/"${(lagret.meta as { versionId: string }).versionId}"` });
			}
			if (deler.length === 2 && deler[1] === '$validate' && req.method === 'POST') {
				return svar(200, { resourceType: 'OperationOutcome', issue: [] });
			}

			const id = deler[1];

			if (deler.length === 3 && deler[2] === '$everything') {
				const pasient = hent('Patient').get(id);
				if (!pasient) return feil(404, 'Ukjent pasient');
				const alle: Record<string, unknown>[] = [pasient];
				for (const [t, m] of lager) {
					if (t === 'Patient') continue;
					for (const r of m.values()) {
						if (refVerdier(r, ['subject', 'patient', 'beneficiary', 'for']).includes(`Patient/${id}`)) alle.push(r);
					}
				}
				return svar(200, { resourceType: 'Bundle', type: 'searchset', total: alle.length, entry: alle.map((r) => ({ resource: r })) });
			}
			if (deler.length === 3 && deler[2] === '_history') {
				const versjoner = historikk.get(`${type}/${id}`) ?? [];
				return svar(200, { resourceType: 'Bundle', type: 'history', total: versjoner.length, entry: versjoner.map((r) => ({ resource: r })) });
			}
			if (deler.length === 4 && deler[2] === '_history') {
				const versjon = (historikk.get(`${type}/${id}`) ?? []).find((r) => (r.meta as { versionId: string }).versionId === deler[3]);
				return versjon ? svar(200, versjon) : feil(404, 'Ukjent versjon');
			}

			if (deler.length === 2) {
				switch (req.method) {
					case 'GET': {
						const r = hent(type).get(id);
						return r
							? svar(200, r, { etag: `W/"${(r.meta as { versionId: string }).versionId}"`, 'last-modified': String((r.meta as { lastUpdated: string }).lastUpdated) })
							: feil(404, `${type}/${id} finnes ikke`);
					}
					case 'PUT': {
						const ressurs = JSON.parse(kropp) as Record<string, unknown>;
						const fantes = hent(type).has(id);
						const lagret = lagre(type, id, ressurs);
						return svar(fantes ? 200 : 201, lagret, { etag: `W/"${(lagret.meta as { versionId: string }).versionId}"` });
					}
					case 'DELETE': {
						const fantes = hent(type).delete(id);
						return svar(fantes ? 200 : 404, { resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'informational', diagnostics: 'Slettet' }] });
					}
					case 'PATCH': {
						const gjeldende = hent(type).get(id);
						if (!gjeldende) return feil(404, 'Ukjent ressurs');
						const patcher = JSON.parse(kropp) as { op: string; path: string; value: unknown }[];
						const kopi = { ...gjeldende };
						for (const p of patcher) {
							if (p.op === 'replace' || p.op === 'add') kopi[p.path.replace(/^\//, '')] = p.value;
						}
						return svar(200, lagre(type, id, kopi));
					}
				}
			}
			return feil(404, `Ukjent sti: ${sti}`);
		});
	});

	await new Promise<void>((løs) => server.listen(0, '127.0.0.1', løs));
	const adresse = server.address();
	const port = typeof adresse === 'object' && adresse ? adresse.port : 0;

	return {
		url: `http://127.0.0.1:${port}/fhir`,
		server,
		erEkte: false,
		lager,
		kall,
		nullstill() {
			lager.clear();
			historikk.clear();
			kall.length = 0;
		},
		lukk: () => new Promise<void>((løs) => server.close(() => løs()))
	};
}
