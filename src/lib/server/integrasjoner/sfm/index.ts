import { en, exec, query } from '../../db';
import { config } from '../../config';
import { nyId } from '../../util/ids';
import { hentMaskinToken } from '../helseid-maskin';
import { SYSTEM } from '../../fhir/kodeverk';
import type { FhirResource } from '../../fhir/types';
import { fhirKlient } from '../../fhir/client';
import { logg, type AuditAktor } from '../../audit';
import { mockSfm } from './mock';

/**
 * Sentral forskrivningsmodul (SFM).
 *
 * SFM driftes av Norsk helsenett og er veien inn til e-resept og Pasientens
 * legemiddelliste (PLL). EPJ-leverandører kan enten bruke SFM sitt eget
 * brukergrensesnitt eller integrere mot SFM Basis-API-et. Denne journalen
 * bruker API-varianten: forskrivning skjer i journalens eget bilde, og SFM
 * håndterer kommunikasjonen mot Reseptformidleren.
 *
 * Alle kall autentiseres med HelseID-maskintoken. I `mock`-modus svarer en
 * lokal simulator, slik at hele forskrivningsflyten kan kjøres og testes uten
 * oppkobling mot NHN sitt testmiljø.
 */

export type SfmOperasjon =
	| 'hentLegemiddelliste'
	| 'forskriv'
	| 'fornye'
	| 'seponer'
	| 'tilbakekall'
	| 'hentUtleveringer';

export interface SfmSvar<T = unknown> {
	ok: boolean;
	data?: T;
	feil?: string;
	reseptId?: string;
}

export interface Legemiddelliste {
	patientId: string;
	oppdatert: string;
	/** Kilde: `sfm` (Pasientens legemiddelliste) eller `lokal` (kun i journal). */
	kilde: 'sfm' | 'lokal';
	legemidler: LegemiddelOppforing[];
	/** Avvik mellom PLL og lokal legemiddelliste som må avstemmes av lege. */
	avvik: string[];
}

export interface LegemiddelOppforing {
	reseptId?: string;
	navn: string;
	atc?: string;
	form?: string;
	styrke?: string;
	dosering: string;
	indikasjon?: string;
	startet?: string;
	seponert?: string;
	forskriver?: string;
	refusjon?: { hjemmel: string; kode: string } | null;
	status: 'aktiv' | 'seponert' | 'utgatt' | 'utkast';
	multidose?: boolean;
	/** Sist utleverte pakning fra apotek, hvis rapportert. */
	sisteUtlevering?: string;
}

export interface ForskrivningInn {
	patientId: string;
	forskriverHpr: string;
	forskriverNavn: string;
	legemiddel: {
		navn: string;
		atc?: string;
		varenummer?: string;
		form?: string;
		styrke?: string;
	};
	dosering: string;
	mengde: string;
	indikasjon?: string;
	/** ICPC-2- eller ICD-10-kode som begrunner eventuell refusjon. */
	refusjonKode?: string;
	refusjonHjemmel?: string;
	reiterasjon?: number;
	gyldighetMnd?: number;
	kommentarTilApotek?: string;
	/** A- og B-preparater krever ekstra bekreftelse fra forskriver. */
	erVanedannende?: boolean;
}

async function kall<T>(operasjon: SfmOperasjon, kropp: unknown, patientId: string, aktor: AuditAktor): Promise<SfmSvar<T>> {
	const id = nyId();
	await exec(
		`INSERT INTO sfm_synk (id, patient_id, operasjon, status, foresporsel, utfort_av) VALUES ($1,$2,$3,'kø',$4,$5)`,
		[id, patientId, operasjon, JSON.stringify(kropp), aktor.userId]
	);

	try {
		const svar =
			config.integrasjoner.modus === 'mock'
				? await mockSfm<T>(operasjon, kropp, patientId)
				: await kallLive<T>(operasjon, kropp);

		await exec(
			`UPDATE sfm_synk SET status = $2, svar = $3, feilmelding = $4, reseptid = $5, oppdatert = now() WHERE id = $1`,
			[id, svar.ok ? 'ok' : 'feilet', JSON.stringify(svar.data ?? null), svar.feil ?? null, svar.reseptId ?? null]
		);
		await logg(
			{
				type: 'integrasjon', subtype: `sfm:${operasjon}`, handling: operasjon === 'hentLegemiddelliste' ? 'R' : 'U',
				utfall: svar.ok ? '0' : '8', utfallBeskrivelse: svar.feil,
				patientId, entityRef: svar.reseptId ? `urn:resept:${svar.reseptId}` : null, purposeOfUse: 'TREAT'
			},
			aktor
		);
		return svar;
	} catch (err) {
		const melding = (err as Error).message;
		await exec("UPDATE sfm_synk SET status = 'feilet', feilmelding = $2, oppdatert = now() WHERE id = $1", [id, melding]);
		await logg(
			{ type: 'integrasjon', subtype: `sfm:${operasjon}`, handling: 'E', utfall: '8', utfallBeskrivelse: melding, patientId },
			aktor
		);
		return { ok: false, feil: melding };
	}
}

async function kallLive<T>(operasjon: SfmOperasjon, kropp: unknown): Promise<SfmSvar<T>> {
	const { baseUrl, scope } = config.integrasjoner.sfm;
	if (!baseUrl) throw new Error('SFM-endepunkt er ikke konfigurert (EPJ_SFM_BASE_URL)');
	const token = await hentMaskinToken(scope);
	const svar = await fetch(`${baseUrl}/${operasjon}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
			accept: 'application/json'
		},
		body: JSON.stringify(kropp),
		signal: AbortSignal.timeout(30_000)
	});
	if (!svar.ok) {
		return { ok: false, feil: `SFM svarte ${svar.status}: ${(await svar.text()).slice(0, 300)}` };
	}
	const data = (await svar.json()) as T & { reseptId?: string };
	return { ok: true, data, reseptId: data.reseptId };
}

export async function hentLegemiddelliste(patientId: string, aktor: AuditAktor): Promise<SfmSvar<Legemiddelliste>> {
	return kall<Legemiddelliste>('hentLegemiddelliste', { patientId }, patientId, aktor);
}

/**
 * Forskriver et legemiddel. Ved suksess speiles resepten som FHIR
 * MedicationRequest i journalen, slik at den er søkbar via /fhir og synlig for
 * SMART-apper. SFM er kilden - journalen holder en kopi.
 */
export async function forskriv(inn: ForskrivningInn, aktor: AuditAktor): Promise<SfmSvar<{ reseptId: string }>> {
	const svar = await kall<{ reseptId: string }>('forskriv', inn, inn.patientId, aktor);
	if (!svar.ok || !svar.reseptId) return svar;

	const medicationRequest: FhirResource = {
		resourceType: 'MedicationRequest',
		status: 'active',
		intent: 'order',
		identifier: [{ system: 'urn:oid:2.16.578.1.12.4.1.4.10', value: svar.reseptId }],
		medication: {
			concept: {
				coding: [
					...(inn.legemiddel.atc ? [{ system: SYSTEM.ATC, code: inn.legemiddel.atc, display: inn.legemiddel.navn }] : []),
					...(inn.legemiddel.varenummer ? [{ system: SYSTEM.LEGEMIDDELVERK_VARENR, code: inn.legemiddel.varenummer }] : [])
				],
				text: [inn.legemiddel.navn, inn.legemiddel.styrke, inn.legemiddel.form].filter(Boolean).join(' ')
			}
		},
		subject: { reference: `Patient/${inn.patientId}` },
		authoredOn: new Date().toISOString(),
		requester: { display: inn.forskriverNavn, identifier: { system: SYSTEM.HPR, value: inn.forskriverHpr } },
		dosageInstruction: [{ text: inn.dosering }],
		dispenseRequest: {
			quantity: { value: Number.parseFloat(inn.mengde) || 1, unit: 'pakning' },
			numberOfRepeatsAllowed: inn.reiterasjon ?? 0,
			validityPeriod: {
				start: new Date().toISOString().slice(0, 10),
				end: new Date(Date.now() + (inn.gyldighetMnd ?? 12) * 30 * 86400_000).toISOString().slice(0, 10)
			}
		},
		...(inn.indikasjon ? { reason: [{ concept: { text: inn.indikasjon } }] } : {}),
		...(inn.refusjonKode
			? {
					extension: [
						{
							url: 'urn:epj:refusjon',
							extension: [
								{ url: 'hjemmel', valueString: inn.refusjonHjemmel ?? '' },
								{ url: 'kode', valueString: inn.refusjonKode }
							]
						}
					]
				}
			: {}),
		note: inn.kommentarTilApotek ? [{ text: inn.kommentarTilApotek }] : undefined,
		meta: { source: 'urn:epj:sfm', tag: [{ system: 'urn:epj:kilde', code: 'sfm' }] }
	};

	await fhirKlient.opprett(medicationRequest).catch((err) => {
		console.error('[sfm] klarte ikke å speile resept i journalen', err);
	});
	return svar;
}

export async function seponer(
	patientId: string,
	reseptId: string,
	arsak: string,
	aktor: AuditAktor
): Promise<SfmSvar<{ reseptId: string }>> {
	return kall<{ reseptId: string }>('seponer', { patientId, reseptId, arsak }, patientId, aktor);
}

export async function fornye(
	patientId: string,
	reseptId: string,
	aktor: AuditAktor
): Promise<SfmSvar<{ reseptId: string }>> {
	return kall<{ reseptId: string }>('fornye', { patientId, reseptId }, patientId, aktor);
}

export async function hentUtleveringer(patientId: string, aktor: AuditAktor): Promise<SfmSvar<{ utleveringer: unknown[] }>> {
	return kall<{ utleveringer: unknown[] }>('hentUtleveringer', { patientId }, patientId, aktor);
}

export interface SynkLogg {
	id: string;
	operasjon: string;
	status: string;
	feilmelding: string | null;
	reseptid: string | null;
	opprettet: string;
}

export async function synkHistorikk(patientId: string, grense = 50): Promise<SynkLogg[]> {
	return query<SynkLogg>(
		'SELECT id, operasjon, status, feilmelding, reseptid, opprettet FROM sfm_synk WHERE patient_id = $1 ORDER BY opprettet DESC LIMIT $2',
		[patientId, grense]
	);
}

export async function sisteSynk(patientId: string): Promise<SynkLogg | null> {
	return en<SynkLogg>(
		"SELECT id, operasjon, status, feilmelding, reseptid, opprettet FROM sfm_synk WHERE patient_id = $1 AND operasjon = 'hentLegemiddelliste' AND status = 'ok' ORDER BY opprettet DESC LIMIT 1",
		[patientId]
	);
}
