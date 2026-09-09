import { en, query } from '../db';
import { PASIENTKOMPARTMENT } from '../fhir/searchparams';
import { hentVerdier, parseReferanse } from '../fhir/fhirpath';
import type { FhirResource } from '../fhir/types';
import { erPasient, egenPasientId, type AuthContext } from './context';
import { kanSeAllePasienter } from './roles';
import { sjekkScope, type Operasjon } from './scopes';

/**
 * Tilgangsbeslutningen.
 *
 * Fire lag må alle gi grønt lys før en forespørsel slipper gjennom:
 *
 *  1. Scope       - hva appen har bedt om og fått (SMART on FHIR)
 *  2. Rolle       - hva stillingskategorien kan gjøre (EPJ-standarden)
 *  3. Tjenstlig behov - om det finnes en dokumentert behandlingsrelasjon til
 *                   nettopp denne pasienten (helsepersonelloven § 21 a)
 *  4. Sperring    - om pasienten har sperret journalen mot denne brukeren
 *
 * Nødrett ("break the glass") kan overstyre lag 3 og 4, men aldri lag 1 og 2,
 * og alltid med begrunnelse, tidsbegrensning og eget innslag i sikkerhetsloggen.
 */

export type Grunnlag =
	| 'behandlingsrelasjon'
	| 'egen-journal'
	| 'nodrett'
	| 'administrativ-rolle'
	| 'ikke-pasientdata';

export interface Beslutning {
	tillatt: boolean;
	grunn?: string;
	grunnlag?: Grunnlag;
	/** `TREAT` normalt, `ETREAT` ved nødrett - går i AuditEvent.purposeOfUse. */
	purposeOfUse: string;
	/** Søkebegrensninger fra scope som må tvinges inn i spørringen. */
	begrensninger: URLSearchParams[];
	/** HTTP-status som bør returneres når `tillatt` er false. */
	status: 401 | 403;
}

const NEKT = (grunn: string, status: 401 | 403 = 403): Beslutning => ({
	tillatt: false, grunn, purposeOfUse: 'TREAT', begrensninger: [], status
});

/** Ressurstyper som ikke inneholder pasientopplysninger og derfor ikke krever tjenstlig behov. */
const IKKE_PASIENTNAERE = new Set([
	'Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Medication',
	'Questionnaire', 'Schedule', 'Slot', 'Group', 'Subscription', 'CapabilityStatement',
	'StructureDefinition', 'ValueSet', 'CodeSystem'
]);

/** Finner pasienten en ressurs gjelder, ut fra kompartmentdefinisjonen. */
export function pasientIdFraRessurs(ressurs: FhirResource): string | null {
	if (ressurs.resourceType === 'Patient') return (ressurs.id as string) ?? null;
	for (const param of PASIENTKOMPARTMENT[ressurs.resourceType] ?? []) {
		for (const sti of [param, param === 'patient' ? 'patient' : 'subject']) {
			for (const v of hentVerdier(ressurs, sti)) {
				const ref = parseReferanse(v);
				if (ref && (ref.type === 'Patient' || ref.type === null)) return ref.id;
			}
		}
	}
	return null;
}

export interface TilgangSporsmal {
	ctx: AuthContext;
	resourceType: string;
	operasjon: Operasjon;
	/** Settes når forespørselen gjelder én kjent pasient. */
	patientId?: string | null;
	/** Ressursen som leses eller skrives, når den er kjent. */
	ressurs?: FhirResource | null;
	/** Ressurs-id for kall som ennå ikke har hentet innholdet. */
	ressursId?: string | null;
}

export async function vurder(spm: TilgangSporsmal): Promise<Beslutning> {
	const { ctx, resourceType, operasjon } = spm;

	// --- Lag 1: scope -------------------------------------------------------
	const pasientId = spm.patientId ?? (spm.ressurs ? pasientIdFraRessurs(spm.ressurs) : null);
	// For en innbygger som er logget inn i egen journal er pasientkonteksten
	// personen selv, også når det ikke finnes en SMART-launch.
	const kontekstPasient = ctx.launch.patientId ?? egenPasientId(ctx);
	const scopeSvar = sjekkScope(ctx.scopes, {
		ressurs: resourceType,
		operasjon,
		kontekstPasientId: pasientId,
		tokenPasientId: kontekstPasient
	});
	if (!scopeSvar.tillatt) return NEKT(scopeSvar.grunn ?? 'Mangler scope');

	// --- Lag 2: rolle -------------------------------------------------------
	const skriver = operasjon === 'c' || operasjon === 'u' || operasjon === 'd';
	if (skriver && !ctx.rettigheter.has('journal:skriv') && !ctx.rettigheter.has('admin:system')) {
		return NEKT('Rollen din har ikke skriverettigheter i journal');
	}
	if (!skriver && !ctx.rettigheter.has('journal:les') && !ctx.rettigheter.has('admin:logg') && !ctx.rettigheter.has('logg:innsyn')) {
		return NEKT('Rollen din har ikke leserettigheter i journal');
	}

	if (IKKE_PASIENTNAERE.has(resourceType)) {
		return { tillatt: true, grunnlag: 'ikke-pasientdata', purposeOfUse: 'HOPERAT', begrensninger: scopeSvar.begrensninger, status: 403 };
	}

	// Innbygger som ser sin egen journal.
	if (erPasient(ctx)) {
		const egen = egenPasientId(ctx);
		if (!egen) return NEKT('Innbyggerbrukeren mangler kobling til pasientjournal');
		if (pasientId && pasientId !== egen) return NEKT('Du har bare tilgang til din egen journal');
		if (skriver) return NEKT('Innbyggere kan ikke endre journalinnhold');
		return { tillatt: true, grunnlag: 'egen-journal', purposeOfUse: 'PATRQT', begrensninger: scopeSvar.begrensninger, status: 403 };
	}

	// Uten kjent pasient (f.eks. søk) avgjøres tilgangen per treff; kalleren
	// bruker `tillattePasienter()` til å avgrense spørringen.
	if (!pasientId) {
		return { tillatt: true, grunnlag: 'behandlingsrelasjon', purposeOfUse: 'TREAT', begrensninger: scopeSvar.begrensninger, status: 403 };
	}

	// --- Lag 3: tjenstlig behov --------------------------------------------
	const nodrett = await aktivNodrett(ctx.userId, pasientId);
	const harRelasjon = kanSeAllePasienter(ctx.roller) || (await harBehandlingsrelasjon(ctx.userId, pasientId));

	if (!harRelasjon && !nodrett) {
		return NEKT('Ingen dokumentert behandlingsrelasjon til denne pasienten. Bruk nødrettstilgang hvis situasjonen krever det.');
	}

	// --- Lag 4: sperring ----------------------------------------------------
	const sperret = await erSperret(ctx, pasientId, spm.ressurs ?? null, spm.ressursId ?? null);
	if (sperret && !nodrett) {
		return NEKT('Pasienten har sperret disse opplysningene for deg');
	}

	if (nodrett) {
		return { tillatt: true, grunnlag: 'nodrett', purposeOfUse: 'ETREAT', begrensninger: scopeSvar.begrensninger, status: 403 };
	}
	return {
		tillatt: true,
		grunnlag: kanSeAllePasienter(ctx.roller) ? 'administrativ-rolle' : 'behandlingsrelasjon',
		purposeOfUse: 'TREAT',
		begrensninger: scopeSvar.begrensninger,
		status: 403
	};
}

export async function harBehandlingsrelasjon(userId: string | null, patientId: string): Promise<boolean> {
	if (!userId) return false;
	const rad = await en<{ n: string }>(
		`SELECT 1 AS n FROM care_relationship
		 WHERE user_id = $1 AND patient_id = $2 AND gyldig_fra <= now() AND (gyldig_til IS NULL OR gyldig_til > now())
		 LIMIT 1`,
		[userId, patientId]
	);
	return rad !== null;
}

export async function aktivNodrett(userId: string | null, patientId: string): Promise<boolean> {
	if (!userId) return false;
	const rad = await en<{ n: string }>(
		'SELECT 1 AS n FROM break_glass WHERE user_id = $1 AND patient_id = $2 AND utloper > now() LIMIT 1',
		[userId, patientId]
	);
	return rad !== null;
}

export async function erSperret(
	ctx: AuthContext,
	patientId: string,
	ressurs: FhirResource | null,
	ressursId: string | null
): Promise<boolean> {
	const sperringer = await query<{ omfang: string; mal_user_id: string | null; mal_rolle: string | null; mal_ressurs: string | null }>(
		`SELECT omfang, mal_user_id, mal_rolle, mal_ressurs FROM journal_sperring
		 WHERE patient_id = $1 AND opphevet = false AND (gyldig_til IS NULL OR gyldig_til > now())`,
		[patientId]
	);
	if (sperringer.length === 0) return false;
	const ressursNokkel = ressurs ? `${ressurs.resourceType}/${ressurs.id}` : ressursId;
	for (const s of sperringer) {
		switch (s.omfang) {
			case 'alle':
				return true;
			case 'bruker':
				if (s.mal_user_id && s.mal_user_id === ctx.userId) return true;
				break;
			case 'rolle':
				if (s.mal_rolle && ctx.roller.includes(s.mal_rolle as never)) return true;
				break;
			case 'dokument':
				if (s.mal_ressurs && ressursNokkel && s.mal_ressurs === ressursNokkel) return true;
				break;
		}
	}
	return false;
}

/**
 * Pasientene brukeren har tjenstlig behov for akkurat nå. Brukes til å tvinge
 * inn et `patient=`-filter i søk, slik at et bredt søk aldri kan lekke pasienter
 * brukeren ikke har relasjon til.
 */
export async function tillattePasienter(ctx: AuthContext, maks = 2000): Promise<string[] | 'alle'> {
	if (kanSeAllePasienter(ctx.roller)) return 'alle';
	if (erPasient(ctx)) {
		const egen = egenPasientId(ctx);
		return egen ? [egen] : [];
	}
	if (ctx.launch.patientId && ctx.scopes.kliniske.every((s) => s.kontekst === 'patient')) {
		return [ctx.launch.patientId];
	}
	const rader = await query<{ patient_id: string }>(
		`SELECT DISTINCT patient_id FROM care_relationship
		 WHERE user_id = $1 AND gyldig_fra <= now() AND (gyldig_til IS NULL OR gyldig_til > now())
		 UNION
		 SELECT DISTINCT patient_id FROM break_glass WHERE user_id = $1 AND utloper > now()
		 LIMIT $2`,
		[ctx.userId, maks]
	);
	return rader.map((r) => r.patient_id);
}

/** Pasienter som har sperret journalen for denne brukeren, og som må filtreres bort. */
export async function sperredePasienter(ctx: AuthContext): Promise<Set<string>> {
	const rader = await query<{ patient_id: string; omfang: string; mal_user_id: string | null; mal_rolle: string | null }>(
		`SELECT patient_id, omfang, mal_user_id, mal_rolle FROM journal_sperring
		 WHERE opphevet = false AND (gyldig_til IS NULL OR gyldig_til > now()) AND omfang IN ('alle','bruker','rolle')`
	);
	const sperret = new Set<string>();
	for (const s of rader) {
		if (s.omfang === 'alle') sperret.add(s.patient_id);
		else if (s.omfang === 'bruker' && s.mal_user_id === ctx.userId) sperret.add(s.patient_id);
		else if (s.omfang === 'rolle' && s.mal_rolle && ctx.roller.includes(s.mal_rolle as never)) sperret.add(s.patient_id);
	}
	if (sperret.size === 0 || !ctx.userId) return sperret;
	// Nødrett opphever sperringen for de pasientene den gjelder.
	const nodrett = await query<{ patient_id: string }>(
		'SELECT patient_id FROM break_glass WHERE user_id = $1 AND utloper > now()',
		[ctx.userId]
	);
	for (const n of nodrett) sperret.delete(n.patient_id);
	return sperret;
}
