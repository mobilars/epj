import { en, exec, medLaas, query, transaction } from '../../db';
import { krevTenant, medTenant } from '../../tenant/kontekst';
import { hentTenant } from '../../tenant/tenant';
import { config } from '../../config';
import { nyId } from '../../util/ids';
import { logg, type AuditAktor } from '../../audit';
import { fhirKlient } from '../../fhir/client';
import type { FhirResource } from '../../fhir/types';
import { SYSTEM } from '../../fhir/kodeverk';
import { byggApprec, lesApprec, lesHodemelding, APPREC_FEIL, type ApprecStatus } from './apprec';
import { hentMottaker, kanMotta } from './adresseregister';

/**
 * Meldingskø mot NHN meldingstjener.
 *
 * Utgående meldinger legges i kø, sendes, og venter deretter på
 * applikasjonskvittering. En melding regnes ikke som levert før AppRec med
 * status 1 eller 2 er mottatt - det er dette skillet som gjør at en henvisning
 * ikke kan bli borte uten at noen oppdager det.
 *
 * Innkommende meldinger lagres, besvares med AppRec, og speiles som FHIR-
 * ressurser i journalen (Communication for dialogmeldinger, DocumentReference
 * for epikriser, ServiceRequest for henvisninger).
 */

export type Meldingsstatus =
	| 'kladd' | 'kø' | 'sendt' | 'kvittert' | 'avvist' | 'feilet' | 'mottatt' | 'behandlet';

export interface Melding {
	id: string;
	retning: 'inn' | 'ut';
	meldingstype: string;
	msg_id: string;
	ref_msg_id: string | null;
	patient_id: string | null;
	avsender_her: string | null;
	mottaker_her: string | null;
	mottaker_navn: string | null;
	status: Meldingsstatus;
	status_detalj: string | null;
	apprec_status: string | null;
	forsok: number;
	neste_forsok: string | null;
	fhir_ref: string | null;
	opprettet: string;
	oppdatert: string;
	opprettet_av: string | null;
}

const FELT = `id, retning, meldingstype, msg_id, ref_msg_id, patient_id, avsender_her, mottaker_her,
	mottaker_navn, status, status_detalj, apprec_status, forsok, neste_forsok, fhir_ref, opprettet, oppdatert, opprettet_av`;

export interface KoInn {
	meldingstype: string;
	msgId: string;
	patientId: string | null;
	mottakerHer: string;
	payloadXml: string;
	opprettetAv: string;
	refMsgId?: string;
}

/** Legger en ferdig bygget melding i utgående kø. */
export async function koeUt(inn: KoInn, aktor: AuditAktor): Promise<{ ok: boolean; id?: string; feil?: string }> {
	const sjekk = await kanMotta(inn.mottakerHer, inn.meldingstype);
	if (!sjekk.ok) {
		await logg(
			{ type: 'integrasjon', subtype: 'melding:avvist-for-sending', handling: 'E', utfall: '4', utfallBeskrivelse: sjekk.grunn, patientId: inn.patientId },
			aktor
		);
		return { ok: false, feil: sjekk.grunn };
	}
	const mottaker = await hentMottaker(inn.mottakerHer);
	const tenant = krevTenant();
	const id = nyId();
	await exec(
		`INSERT INTO melding (id, tenant_id, retning, meldingstype, msg_id, ref_msg_id, patient_id, avsender_her, mottaker_her,
			mottaker_navn, status, payload_xml, opprettet_av, neste_forsok)
		 VALUES ($1,$11,'ut',$2,$3,$4,$5,$6,$7,$8,'kø',$9,$10, now())`,
		[
			id, inn.meldingstype, inn.msgId, inn.refMsgId ?? null, inn.patientId,
			tenant.her_id ?? config.organisasjon.herId, inn.mottakerHer, mottaker?.navn ?? null,
			inn.payloadXml, inn.opprettetAv, tenant.id
		]
	);
	await logg(
		{
			type: 'integrasjon', subtype: `melding:kø:${inn.meldingstype}`, handling: 'C', utfall: '0',
			patientId: inn.patientId, entityRef: `urn:melding:${inn.msgId}`,
			detaljer: { mottaker: mottaker?.navn ?? inn.mottakerHer }, purposeOfUse: 'TREAT'
		},
		aktor
	);
	return { ok: true, id };
}

const MAKS_FORSOK = 6;

/** Stabil tallverdi av virksomhets-id, brukt til å skille de rådgivende låsene. */
function hashTilTall(id: string): number {
	let h = 0;
	for (const tegn of id) h = (h * 31 + tegn.charCodeAt(0)) % 100_000;
	return h;
}

/** Eksponentiell backoff: 1, 2, 4, 8, 16, 32 minutter. */
function nesteForsok(forsok: number): string {
	return `${Math.min(2 ** forsok, 60)} minutes`;
}

/**
 * Sender alt som ligger klart i køen. Beskyttet av rådgivende lås slik at
 * flere appinstanser ikke sender samme melding to ganger.
 */
export async function sendKo(): Promise<{ sendt: number; feilet: number }> {
	const tenantId = krevTenant().id;
	// Låsen er per virksomhet, slik at treg utsending hos én ikke stanser de andre.
	const resultat = await medLaas(918_271 + hashTilTall(tenantId), async () => {
		const klare = await query<{ id: string; msg_id: string; meldingstype: string; mottaker_her: string; payload_xml: string; forsok: number; patient_id: string | null }>(
			`SELECT id, msg_id, meldingstype, mottaker_her, payload_xml, forsok, patient_id FROM melding
			 WHERE tenant_id = $1 AND retning = 'ut' AND status IN ('kø','feilet')
			   AND (neste_forsok IS NULL OR neste_forsok <= now())
			 ORDER BY opprettet LIMIT 50`,
			[tenantId]
		);
		let sendt = 0;
		let feilet = 0;
		for (const m of klare) {
			try {
				await transport(m.mottaker_her, m.payload_xml, m.meldingstype);
				await exec("UPDATE melding SET status = 'sendt', oppdatert = now(), status_detalj = NULL WHERE id = $1 AND tenant_id = $2", [m.id, tenantId]);
				sendt++;
			} catch (err) {
				const melding = (err as Error).message;
				const forsok = m.forsok + 1;
				const oppgitt = forsok >= MAKS_FORSOK;
				await exec(
					`UPDATE melding SET status = $2, forsok = $3, status_detalj = $4,
					 neste_forsok = CASE WHEN $5 THEN NULL ELSE now() + $6::interval END, oppdatert = now()
					 WHERE id = $1 AND tenant_id = $7`,
					[m.id, oppgitt ? 'avvist' : 'feilet', forsok, melding, oppgitt, nesteForsok(forsok), tenantId]
				);
				feilet++;
			}
		}
		return { sendt, feilet };
	});
	return resultat ?? { sendt: 0, feilet: 0 };
}

/**
 * Transportlaget mot meldingstjeneren.
 *
 * I `live`-modus legges meldingen på NHN meldingstjener (EDI 2.0) over
 * gjensidig autentisert TLS. I `mock`-modus leveres den lokalt, slik at
 * sende- og kvitteringsflyten kan kjøres uten Helsenett-tilkobling.
 */
async function transport(mottakerHer: string, xml: string, meldingstype: string): Promise<void> {
	if (config.integrasjoner.modus === 'mock') {
		await mockLevering(mottakerHer, xml, meldingstype);
		return;
	}
	const url = config.integrasjoner.nhn.meldingstjenerUrl;
	if (!url) throw new Error('Meldingstjeneren er ikke konfigurert (EPJ_NHN_MELDINGSTJENER_URL)');
	const svar = await fetch(`${url}/messages`, {
		method: 'POST',
		headers: {
			'content-type': 'application/xml',
			'x-receiver-her-id': mottakerHer,
			'x-sender-her-id': config.integrasjoner.nhn.herId
		},
		body: xml,
		signal: AbortSignal.timeout(30_000)
	});
	if (!svar.ok) throw new Error(`Meldingstjeneren svarte ${svar.status}: ${(await svar.text()).slice(0, 200)}`);
}

/** Simulerer at mottaker leser meldingen og kvitterer. */
async function mockLevering(mottakerHer: string, xml: string, meldingstype: string): Promise<void> {
	const lest = lesHodemelding(xml);
	if (!lest) throw new Error('Meldingen kunne ikke leses som hodemelding');
	const mottaker = await hentMottaker(mottakerHer);
	// Kvitteringen kommer «tilbake» etter kort tid; her registreres den direkte.
	setTimeout(() => {
		void registrerApprec(lest.msgId, '1', [], mottaker?.navn ?? mottakerHer).catch(() => undefined);
	}, 50);
}

/** Registrerer mottatt applikasjonskvittering på den utgående meldingen. */
export async function registrerApprec(
	refMsgId: string,
	status: ApprecStatus,
	feil: { kode: string; tekst: string }[],
	avsenderNavn: string
): Promise<boolean> {
	const n = await exec(
		`UPDATE melding SET apprec_status = $2, status = $3, status_detalj = $4, oppdatert = now()
		 WHERE retning = 'ut' AND msg_id = $1 AND tenant_id = $5`,
		[
			refMsgId,
			status,
			status === '3' ? 'avvist' : 'kvittert',
			feil.length ? `${avsenderNavn}: ${feil.map((f) => `${f.kode} ${f.tekst}`).join('; ')}` : null,
			krevTenant().id
		]
	);
	return n > 0;
}

// ---------------------------------------------------------------------------
// Innkommende meldinger
// ---------------------------------------------------------------------------

export interface MottakResultat {
	ok: boolean;
	meldingId?: string;
	apprec?: string;
	apprecStatus: ApprecStatus;
	feil: { kode: string; tekst: string }[];
}

/**
 * Tar imot en melding, lagrer den, kobler den til pasient og bygger AppRec.
 * Meldingen speiles som FHIR-ressurs slik at den blir en del av journalen og
 * tilgjengelig for SMART-apper gjennom /fhir.
 */
export async function mottaMelding(xml: string, aktor: AuditAktor): Promise<MottakResultat> {
	const apprecFeil: { kode: string; tekst: string }[] = [];

	// Applikasjonskvittering på noe vi har sendt.
	const kvittering = lesApprec(xml);
	if (kvittering) {
		await registrerApprec(kvittering.refMsgId, kvittering.status, kvittering.feil, 'mottaker');
		await logg(
			{
				type: 'integrasjon', subtype: 'melding:apprec', handling: 'U', utfall: kvittering.status === '3' ? '4' : '0',
				entityRef: `urn:melding:${kvittering.refMsgId}`,
				utfallBeskrivelse: kvittering.feil.map((f) => f.tekst).join('; ') || undefined
			},
			aktor
		);
		return { ok: true, apprecStatus: kvittering.status, feil: kvittering.feil };
	}

	const lest = lesHodemelding(xml);
	if (!lest) {
		return { ok: false, apprecStatus: '3', feil: [APPREC_FEIL.XML_FEIL] };
	}

	const duplikat = await en<{ id: string }>(
		"SELECT id FROM melding WHERE retning = 'inn' AND msg_id = $1 AND tenant_id = $2",
		[lest.msgId, krevTenant().id]
	);
	if (duplikat) {
		return {
			ok: true,
			meldingId: duplikat.id,
			apprecStatus: '2',
			feil: [APPREC_FEIL.DUPLIKAT],
			apprec: byggApprec({
				refMsgId: lest.msgId, refGenDate: lest.genDate, refType: lest.type, status: '2',
				feil: [APPREC_FEIL.DUPLIKAT], originalAvsender: lest.avsender
			})
		};
	}

	let patientId: string | null = null;
	if (lest.pasientFnr) {
		patientId = await finnPasientPaFnr(lest.pasientFnr);
		if (!patientId) apprecFeil.push(APPREC_FEIL.UKJENT_PASIENT);
	} else {
		apprecFeil.push(APPREC_FEIL.MANGLER_FNR);
	}

	const status: ApprecStatus = apprecFeil.length === 0 ? '1' : '2';
	const id = nyId();

	await transaction(async () => {
		await exec(
			`INSERT INTO melding (id, tenant_id, retning, meldingstype, msg_id, patient_id, avsender_her, mottaker_her,
				mottaker_navn, status, payload_xml, apprec_status)
			 VALUES ($1,$10,'inn',$2,$3,$4,$5,$6,$7,'mottatt',$8,$9)`,
			[id, lest.type.kode, lest.msgId, patientId, lest.avsender.her,
			 krevTenant().her_id ?? config.organisasjon.herId, lest.avsender.navn, xml, status, krevTenant().id]
		);
	});

	if (patientId) {
		const fhirRef = await speilTilFhir(lest, patientId, xml);
		if (fhirRef) await exec('UPDATE melding SET fhir_ref = $2 WHERE id = $1 AND tenant_id = $3', [id, fhirRef, krevTenant().id]);
	}

	await logg(
		{
			type: 'integrasjon', subtype: `melding:mottatt:${lest.type.kode}`, handling: 'C', utfall: status === '1' ? '0' : '4',
			patientId, entityRef: `urn:melding:${lest.msgId}`,
			utfallBeskrivelse: apprecFeil.map((f) => f.tekst).join('; ') || undefined,
			detaljer: { avsender: lest.avsender.navn }
		},
		aktor
	);

	return {
		ok: true,
		meldingId: id,
		apprecStatus: status,
		feil: apprecFeil,
		apprec: byggApprec({
			refMsgId: lest.msgId, refGenDate: lest.genDate, refType: lest.type,
			status, feil: apprecFeil.length ? apprecFeil : undefined, originalAvsender: lest.avsender
		})
	};
}

async function finnPasientPaFnr(fnr: string): Promise<string | null> {
	try {
		const bundle = await fhirKlient.sok('Patient', new URLSearchParams({ identifier: `${SYSTEM.FNR}|${fnr}`, _count: '2' }));
		const treff = bundle.entry?.[0]?.resource;
		return (treff?.id as string) ?? null;
	} catch {
		return null;
	}
}

/** Lager FHIR-representasjonen av en innkommende melding. */
async function speilTilFhir(
	lest: NonNullable<ReturnType<typeof lesHodemelding>>,
	patientId: string,
	xml: string
): Promise<string | null> {
	const felles = {
		subject: { reference: `Patient/${patientId}` },
		identifier: [{ system: 'urn:oid:2.16.578.1.12.4.1.1.8279', value: lest.msgId }]
	};

	let ressurs: FhirResource;
	switch (lest.type.kode) {
		case 'EPIKRISE':
		case 'SVAR_LAB':
			ressurs = {
				resourceType: 'DocumentReference',
				status: 'current',
				type: { coding: [{ system: SYSTEM.MELDINGSTYPE, code: lest.type.kode, display: lest.type.navn }] },
				category: [{ text: lest.type.kode === 'EPIKRISE' ? 'Epikrise' : 'Prøvesvar' }],
				date: lest.genDate,
				author: [{ display: lest.avsender.navn }],
				content: [{ attachment: { contentType: 'text/xml', data: Buffer.from(xml).toString('base64'), title: lest.type.navn } }],
				...felles
			};
			break;
		case 'HENVIS':
			ressurs = {
				resourceType: 'ServiceRequest',
				status: 'active',
				intent: 'order',
				code: { concept: { coding: [{ system: SYSTEM.MELDINGSTYPE, code: 'HENVIS', display: 'Henvisning' }] } },
				authoredOn: lest.genDate,
				requester: { display: lest.avsender.navn },
				...felles
			};
			break;
		default:
			ressurs = {
				resourceType: 'Communication',
				status: 'completed',
				category: [{ coding: [{ system: SYSTEM.MELDINGSTYPE, code: lest.type.kode, display: lest.type.navn }] }],
				sent: lest.genDate,
				received: new Date().toISOString(),
				sender: { display: lest.avsender.navn },
				payload: [{ contentAttachment: { contentType: 'text/xml', data: Buffer.from(xml).toString('base64') } }],
				...felles
			};
	}

	try {
		const svar = await fhirKlient.opprett(ressurs);
		return `${ressurs.resourceType}/${svar.ressurs.id}`;
	} catch (err) {
		console.error('[nhn] klarte ikke å speile melding til FHIR', err);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Oppslag
// ---------------------------------------------------------------------------

export async function listMeldinger(filter: {
	retning?: 'inn' | 'ut';
	status?: Meldingsstatus;
	patientId?: string;
	grense?: number;
}): Promise<Melding[]> {
	const vilkar: string[] = ['tenant_id = $1'];
	const params: unknown[] = [krevTenant().id];
	if (filter.retning) { params.push(filter.retning); vilkar.push(`retning = $${params.length}`); }
	if (filter.status) { params.push(filter.status); vilkar.push(`status = $${params.length}`); }
	if (filter.patientId) { params.push(filter.patientId); vilkar.push(`patient_id = $${params.length}`); }
	params.push(Math.min(filter.grense ?? 100, 500));
	return query<Melding>(
		`SELECT ${FELT} FROM melding WHERE ${vilkar.join(' AND ')} ORDER BY opprettet DESC LIMIT $${params.length}`,
		params
	);
}

export async function hentMelding(id: string): Promise<(Melding & { payload_xml: string | null }) | null> {
	return en<Melding & { payload_xml: string | null }>(
		`SELECT ${FELT}, payload_xml FROM melding WHERE id = $1 AND tenant_id = $2`,
		[id, krevTenant().id]
	);
}

export async function markerBehandlet(id: string, aktor: AuditAktor): Promise<void> {
	const melding = await hentMelding(id);
	await exec("UPDATE melding SET status = 'behandlet', oppdatert = now() WHERE id = $1 AND tenant_id = $2", [id, krevTenant().id]);
	await logg(
		{ type: 'integrasjon', subtype: 'melding:behandlet', handling: 'U', utfall: '0', patientId: melding?.patient_id ?? null, entityRef: `urn:melding:${melding?.msg_id}` },
		aktor
	);
}

/** Meldinger som er sendt, men som mangler applikasjonskvittering. */
export async function ventendeKvitteringer(eldreEnnMinutter = 60): Promise<Melding[]> {
	return query<Melding>(
		`SELECT ${FELT} FROM melding
		 WHERE tenant_id = $2 AND retning = 'ut' AND status = 'sendt' AND apprec_status IS NULL
		   AND oppdatert < now() - ($1 || ' minutes')::interval
		 ORDER BY oppdatert LIMIT 200`,
		[String(eldreEnnMinutter), krevTenant().id]
	);
}
