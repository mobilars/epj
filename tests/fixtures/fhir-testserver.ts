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

export type Ressurslager = Map<string, Map<string, Record<string, unknown>>>;

export interface TestFhirServer {
	url: string;
	server: Server | null;
	/** True når testene kjører mot en ekte HAPI-server i stedet for dobbelen. */
	erEkte: boolean;
	/** Innholdet i den upartisjonerte roten. Se `lagerFor` for partisjonene. */
	lager: Ressurslager;
	/** Innholdet i én partisjon. Tomt kart hvis partisjonen ikke er tatt i bruk. */
	lagerFor(partisjon: string): Ressurslager;
	/** Partisjonene serveren kjenner, slik $partition-management-list-partitions svarer. */
	partisjoner(): { id: number; navn: string }[];
	kall: { metode: string; sti: string; partisjon: string }[];
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
			lagerFor: () => new Map(),
			partisjoner: () => [],
			kall: [],
			nullstill() {
				/* En ekte server tømmes ikke mellom tester; testene lager egne pasienter. */
			},
			lukk: async () => undefined
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

function erPartisjonssegment(segment: string): boolean {
	return PARTISJONSNAVN.test(segment) && segment !== 'metadata';
}

export async function startTestFhirServer(): Promise<TestFhirServer> {
	// '' er roten: den brukes når serveren kjøres uten partisjonering.
	const partisjonslagre = new Map<string, Ressurslager>([['', new Map()]]);
	const partisjonsregister = new Map<string, { id: number; navn: string; beskrivelse?: string }>([
		['DEFAULT', { id: 0, navn: 'DEFAULT', beskrivelse: 'Standardpartisjon' }]
	]);
	const historikk = new Map<string, Record<string, unknown>[]>();
	const kall: { metode: string; sti: string; partisjon: string }[] = [];

	const lager = partisjonslagre.get('') as Ressurslager;

	const lagerFor = (partisjon: string): Ressurslager => {
		if (!partisjonslagre.has(partisjon)) partisjonslagre.set(partisjon, new Map());
		return partisjonslagre.get(partisjon) as Ressurslager;
	};

	const hent = (partisjon: string, type: string) => {
		const l = lagerFor(partisjon);
		if (!l.has(type)) l.set(type, new Map());
		return l.get(type) as Map<string, Record<string, unknown>>;
	};

	function lagre(partisjon: string, type: string, id: string, ressurs: Record<string, unknown>): Record<string, unknown> {
		const forrige = hent(partisjon, type).get(id);
		const versjon = forrige ? Number((forrige.meta as { versionId?: string })?.versionId ?? 1) + 1 : 1;
		const lagret = {
			...ressurs,
			resourceType: type,
			id,
			meta: { ...(ressurs.meta as object), versionId: String(versjon), lastUpdated: new Date().toISOString() }
		};
		hent(partisjon, type).set(id, lagret);
		const nokkel = `${partisjon}:${type}/${id}`;
		historikk.set(nokkel, [...(historikk.get(nokkel) ?? []), lagret]);
		return lagret;
	}

	function sok(partisjon: string, type: string, params: URLSearchParams): Record<string, unknown> {
		let treff = [...hent(partisjon, type).values()];
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
			const helSti = url.pathname.replace(/^\/fhir\/?/, '');
			const kropp = Buffer.concat(biter).toString('utf8');

			// Skill partisjonssegmentet fra resten, slik HAPI gjør med URL_BASED.
			const alleDeler = helSti.split('/').filter(Boolean);
			const partisjon = alleDeler.length && erPartisjonssegment(alleDeler[0]) ? alleDeler[0] : '';
			const sti = partisjon ? alleDeler.slice(1).join('/') : helSti;
			kall.push({ metode: req.method ?? 'GET', sti, partisjon });

			const svar = (status: number, data: unknown, headers: Record<string, string> = {}) => {
				res.writeHead(status, { 'content-type': 'application/fhir+json', ...headers });
				res.end(JSON.stringify(data));
			};
			const feil = (status: number, tekst: string) =>
				svar(status, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'processing', diagnostics: tekst }] });

			const deler = sti.split('/').filter(Boolean);

			// --- Partisjonsadministrasjon (kalles på standardpartisjonen) -----
			if (deler.length === 1 && deler[0].startsWith('$partition-management-')) {
				const operasjon = deler[0].slice('$partition-management-'.length);
				const inn = kropp ? (JSON.parse(kropp) as { parameter?: { name: string; valueInteger?: number; valueString?: string }[] }) : {};
				const del = (navn: string) => inn.parameter?.find((p) => p.name === navn);

				if (operasjon === 'list-partitions') {
					return svar(200, {
						resourceType: 'Parameters',
						parameter: [...partisjonsregister.values()].map((p) => ({
							name: 'partition',
							part: [
								{ name: 'id', valueInteger: p.id },
								{ name: 'name', valueString: p.navn },
								{ name: 'description', valueString: p.beskrivelse ?? '' }
							]
						}))
					});
				}
				if (operasjon === 'create-partition') {
					const id = del('id')?.valueInteger ?? 0;
					const navn = del('name')?.valueString ?? '';
					if (!navn) return feil(400, 'Partisjonen må ha et navn');
					if (partisjonsregister.has(navn)) return feil(400, `Partisjonen ${navn} finnes allerede`);
					if ([...partisjonsregister.values()].some((p) => p.id === id)) {
						return feil(400, `Partisjons-id ${id} er allerede i bruk`);
					}
					partisjonsregister.set(navn, { id, navn, beskrivelse: del('description')?.valueString });
					lagerFor(navn);
					return svar(200, {
						resourceType: 'Parameters',
						parameter: [
							{ name: 'id', valueInteger: id },
							{ name: 'name', valueString: navn }
						]
					});
				}
				if (operasjon === 'delete-partition') {
					const id = del('id')?.valueInteger ?? -1;
					const funnet = [...partisjonsregister.values()].find((p) => p.id === id);
					if (!funnet) return feil(404, `Ukjent partisjon ${id}`);
					partisjonsregister.delete(funnet.navn);
					partisjonslagre.delete(funnet.navn);
					return svar(200, { resourceType: 'Parameters', parameter: [] });
				}
				return feil(400, `Ukjent partisjonsoperasjon: ${operasjon}`);
			}

			if (deler[0] === 'metadata') {
				return svar(200, {
					resourceType: 'CapabilityStatement',
					status: 'active',
					date: new Date().toISOString(),
					fhirVersion: '5.0.0',
					format: ['application/fhir+json'],
					rest: [{ mode: 'server', resource: [...lagerFor(partisjon).keys()].map((t) => ({ type: t })) }]
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
						const lagret = lagre(partisjon, type as string, randomUUID(), e.resource);
						return { response: { status: '201 Created', location: `${type}/${lagret.id}` }, resource: lagret };
					}
					if (metode === 'PUT' && e.resource) {
						const id = målUrl.split('/')[1] ?? (e.resource.id as string);
						const lagret = lagre(partisjon, type as string, id, e.resource);
						return { response: { status: '200 OK' }, resource: lagret };
					}
					if (metode === 'DELETE') {
						const [t, id] = målUrl.split('/');
						hent(partisjon, t).delete(id);
						return { response: { status: '204 No Content' } };
					}
					return { response: { status: '200 OK' } };
				});
				return svar(200, { resourceType: 'Bundle', type: `${bundle.type}-response`, entry: svarOppforinger });
			}

			const type = deler[0];

			if (deler.length === 2 && deler[1] === '_search' && req.method === 'POST') {
				return svar(200, sok(partisjon, type, new URLSearchParams(kropp)));
			}
			if (deler.length === 1 && req.method === 'GET') {
				return svar(200, sok(partisjon, type, url.searchParams));
			}
			if (deler.length === 1 && req.method === 'POST') {
				const ressurs = JSON.parse(kropp) as Record<string, unknown>;
				const lagret = lagre(partisjon, type, (ressurs.id as string) ?? randomUUID(), ressurs);
				const prefiks = partisjon ? `/fhir/${partisjon}` : '/fhir';
				return svar(201, lagret, { location: `${prefiks}/${type}/${lagret.id}`, etag: `W/"${(lagret.meta as { versionId: string }).versionId}"` });
			}
			if (deler.length === 2 && deler[1] === '$validate' && req.method === 'POST') {
				return svar(200, { resourceType: 'OperationOutcome', issue: [] });
			}

			const id = deler[1];

			if (deler.length === 3 && deler[2] === '$everything') {
				const pasient = hent(partisjon, 'Patient').get(id);
				if (!pasient) return feil(404, 'Ukjent pasient');
				const alle: Record<string, unknown>[] = [pasient];
				for (const [t, m] of lagerFor(partisjon)) {
					if (t === 'Patient') continue;
					for (const r of m.values()) {
						if (refVerdier(r, ['subject', 'patient', 'beneficiary', 'for']).includes(`Patient/${id}`)) alle.push(r);
					}
				}
				return svar(200, { resourceType: 'Bundle', type: 'searchset', total: alle.length, entry: alle.map((r) => ({ resource: r })) });
			}
			if (deler.length === 3 && deler[2] === '_history') {
				const versjoner = historikk.get(`${partisjon}:${type}/${id}`) ?? [];
				return svar(200, { resourceType: 'Bundle', type: 'history', total: versjoner.length, entry: versjoner.map((r) => ({ resource: r })) });
			}
			if (deler.length === 4 && deler[2] === '_history') {
				const versjon = (historikk.get(`${partisjon}:${type}/${id}`) ?? []).find((r) => (r.meta as { versionId: string }).versionId === deler[3]);
				return versjon ? svar(200, versjon) : feil(404, 'Ukjent versjon');
			}

			if (deler.length === 2) {
				switch (req.method) {
					case 'GET': {
						const r = hent(partisjon, type).get(id);
						return r
							? svar(200, r, { etag: `W/"${(r.meta as { versionId: string }).versionId}"`, 'last-modified': String((r.meta as { lastUpdated: string }).lastUpdated) })
							: feil(404, `${type}/${id} finnes ikke`);
					}
					case 'PUT': {
						const ressurs = JSON.parse(kropp) as Record<string, unknown>;
						const fantes = hent(partisjon, type).has(id);
						const lagret = lagre(partisjon, type, id, ressurs);
						return svar(fantes ? 200 : 201, lagret, { etag: `W/"${(lagret.meta as { versionId: string }).versionId}"` });
					}
					case 'DELETE': {
						const fantes = hent(partisjon, type).delete(id);
						return svar(fantes ? 200 : 404, { resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'informational', diagnostics: 'Slettet' }] });
					}
					case 'PATCH': {
						const gjeldende = hent(partisjon, type).get(id);
						if (!gjeldende) return feil(404, 'Ukjent ressurs');
						const patcher = JSON.parse(kropp) as { op: string; path: string; value: unknown }[];
						const kopi = { ...gjeldende };
						for (const p of patcher) {
							if (p.op === 'replace' || p.op === 'add') kopi[p.path.replace(/^\//, '')] = p.value;
						}
						return svar(200, lagre(partisjon, type, id, kopi));
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
		lagerFor,
		partisjoner: () => [...partisjonsregister.values()].map((p) => ({ id: p.id, navn: p.navn })),
		kall,
		nullstill() {
			for (const l of partisjonslagre.values()) l.clear();
			partisjonsregister.clear();
			partisjonsregister.set('DEFAULT', { id: 0, navn: 'DEFAULT', beskrivelse: 'Standardpartisjon' });
			historikk.clear();
			kall.length = 0;
		},
		lukk: () => new Promise<void>((løs) => server.close(() => løs()))
	};
}
