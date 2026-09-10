import { one, query } from '../db';
import { requireTenant } from '../tenant/context';
import { PATIENTCOMPARTMENT } from '../fhir/searchparams';
import { getValues, parseReference } from '../fhir/fhirpath';
import type { FhirResource } from '../fhir/types';
import { isPatient, ownPatientId, type AuthContext } from './context';
import { canSeeAllPatients } from './roles';
import { checkScope, type Operation } from './scopes';

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

export type Basis =
	| 'behandlingsrelasjon'
	| 'egen-journal'
	| 'nodrett'
	| 'administrativ-rolle'
	| 'ikke-pasientdata';

export interface Decision {
	allowed: boolean;
	reason?: string;
	basis?: Basis;
	/** `TREAT` normalt, `ETREAT` ved nødrett - går i AuditEvent.purposeOfUse. */
	purposeOfUse: string;
	/** Søkebegrensninger fra scope som må tvinges inn i spørringen. */
	limitations: URLSearchParams[];
	/** HTTP-status som bør returneres når `tillatt` er false. */
	status: 401 | 403;
}

const DENY = (reason: string, status: 401 | 403 = 403): Decision => ({
	allowed: false, reason, purposeOfUse: 'TREAT', limitations: [], status
});

/**
 * Ressurstyper som ikke inneholder pasientopplysninger og derfor ikke krever
 * tjenstlig behov.
 *
 * Listen skal være kort og lett å forsvare. En type hører bare hjemme her hvis
 * den ikke kan peke på en pasient i det hele tatt - `Group` sto her, men en
 * gruppe kan ha `member.entity` mot Patient, og et kohortuttrekk er nettopp en
 * liste over hvem som hører til.
 */
const NOT_PASIENTNAERE = new Set([
	'Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Medication',
	'Questionnaire', 'Schedule', 'Slot', 'Subscription', 'CapabilityStatement',
	'StructureDefinition', 'ValueSet', 'CodeSystem'
]);

/**
 * Om tilgangskontrollen kan avgjøre hvilken pasient en ressurstype gjelder.
 *
 * Både tjenstlig behov (lag 3) og sperring (lag 4) forutsetter at vi vet hvilken
 * pasient opplysningen hører til. For en type uten pasientreferanse i
 * kompartmentdefinisjonen kan ingen av delene håndheves - og da skal typen ikke
 * være tilgjengelig, uansett hva scopet sier.
 *
 * Dette er en strukturell sperre, ikke en liste å vedlikeholde: en ny
 * ressurstype i SEARCH_PARAMS uten `patient`/`subject`-parameter blir avvist
 * inntil noen har tatt stilling til hvordan pasienten skal utledes.
 */
export function canDeterminePatient(resourceType: string): boolean {
	if (resourceType === 'Patient') return true;
	return (PATIENTCOMPARTMENT[resourceType]?.length ?? 0) > 0;
}

/** Om en ressurstype i det hele tatt inneholder pasientopplysninger. */
export function isPatientRelated(resourceType: string): boolean {
	return !NOT_PASIENTNAERE.has(resourceType);
}

/** Finner pasienten en ressurs gjelder, ut fra kompartmentdefinisjonen. */
export function patientIdFromResource(resource: FhirResource): string | null {
	if (resource.resourceType === 'Patient') return (resource.id as string) ?? null;
	for (const param of PATIENTCOMPARTMENT[resource.resourceType] ?? []) {
		for (const path of [param, param === 'patient' ? 'patient' : 'subject']) {
			for (const v of getValues(resource, path)) {
				const ref = parseReference(v);
				if (ref && (ref.type === 'Patient' || ref.type === null)) return ref.id;
			}
		}
	}
	return null;
}

export interface AccessQuestion {
	ctx: AuthContext;
	resourceType: string;
	operation: Operation;
	/** Settes når forespørselen gjelder én kjent pasient. */
	patientId?: string | null;
	/** Ressursen som leses eller skrives, når den er kjent. */
	resource?: FhirResource | null;
	/** Ressurs-id for kall som ennå ikke har hentet innholdet. */
	resourceId?: string | null;
}

export async function evaluate(question: AccessQuestion): Promise<Decision> {
	const { ctx, resourceType, operation } = question;

	// --- Lag 1: scope -------------------------------------------------------
	const patientId = question.patientId ?? (question.resource ? patientIdFromResource(question.resource) : null);
	// For en innbygger som er logget inn i egen journal er pasientkonteksten
	// personen selv, også når det ikke finnes en SMART-launch.
	const contextPatient = ctx.launch.patientId ?? ownPatientId(ctx);
	const scopeResponse = checkScope(ctx.scopes, {
		resource: resourceType,
		operation,
		contextPatientId: patientId,
		tokenPatientId: contextPatient
	});
	if (!scopeResponse.allowed) return DENY(scopeResponse.reason ?? 'Mangler scope');

	// --- Lag 2: rolle -------------------------------------------------------
	const writes = operation === 'c' || operation === 'u' || operation === 'd';
	if (writes && !ctx.permissions.has('journal:skriv') && !ctx.permissions.has('admin:system')) {
		return DENY('Rollen din har ikke skriverettigheter i journal');
	}
	if (!writes && !ctx.permissions.has('journal:les') && !ctx.permissions.has('admin:logg') && !ctx.permissions.has('logg:innsyn')) {
		return DENY('Rollen din har ikke leserettigheter i journal');
	}

	if (NOT_PASIENTNAERE.has(resourceType)) {
		return { allowed: true, basis: 'ikke-pasientdata', purposeOfUse: 'HOPERAT', limitations: scopeResponse.limitations, status: 403 };
	}

	// Typen er pasientnær, men vi har ingen måte å finne ut hvilken pasient den
	// gjelder. Da kan verken tjenstlig behov eller sperring vurderes, og eneste
	// forsvarlige svar er nei.
	if (!canDeterminePatient(resourceType)) {
		return DENY(`Tilgangen til ${resourceType} kan ikke vurderes: ressurstypen har ingen pasientreferanse`);
	}

	// Innbygger som ser sin egen journal.
	if (isPatient(ctx)) {
		const own = ownPatientId(ctx);
		if (!own) return DENY('Innbyggerbrukeren mangler kobling til pasientjournal');
		if (patientId && patientId !== own) return DENY('Du har bare tilgang til din egen journal');
		if (writes) return DENY('Innbyggere kan ikke endre journalinnhold');
		return { allowed: true, basis: 'egen-journal', purposeOfUse: 'PATRQT', limitations: scopeResponse.limitations, status: 403 };
	}

	if (!patientId) {
		// Søk har ingen pasient på forhånd. Tilgangen avgjøres per treff, ved at
		// `sokRessurser` avgrenser spørringen med `tillattePasienter()`.
		if (operation === 's') {
			return { allowed: true, basis: 'behandlingsrelasjon', purposeOfUse: 'TREAT', limitations: scopeResponse.limitations, status: 403 };
		}
		// Et enkeltoppslag på en pasientnær ressurs uten pasientreferanse kan
		// ikke vurderes mot verken behandlingsrelasjon eller sperring. Tidligere
		// slapp slike kall gjennom; det gjorde tjenstlig behov omgåelig for enhver
		// ressurs der referansen manglet eller ikke ble gjenkjent.
		return DENY(`Fant ingen pasientreferanse i ${resourceType}, og tilgangen kan derfor ikke vurderes`);
	}

	// --- Lag 3: tjenstlig behov --------------------------------------------
	const emergencyAccess = await activeEmergencyAccess(ctx.userId, patientId);
	const hasRelationship = canSeeAllPatients(ctx.roles) || (await hasCareRelationship(ctx.userId, patientId));

	if (!hasRelationship && !emergencyAccess) {
		return DENY('Ingen dokumentert behandlingsrelasjon til denne pasienten. Bruk nødrettstilgang hvis situasjonen krever det.');
	}

	// --- Lag 4: sperring ----------------------------------------------------
	const blocked = await isBlocked(ctx, patientId, question.resource ?? null, question.resourceId ?? null);
	if (blocked && !emergencyAccess) {
		return DENY('Pasienten har sperret disse opplysningene for deg');
	}

	if (emergencyAccess) {
		return { allowed: true, basis: 'nodrett', purposeOfUse: 'ETREAT', limitations: scopeResponse.limitations, status: 403 };
	}
	return {
		allowed: true,
		basis: canSeeAllPatients(ctx.roles) ? 'administrativ-rolle' : 'behandlingsrelasjon',
		purposeOfUse: 'TREAT',
		limitations: scopeResponse.limitations,
		status: 403
	};
}

export async function hasCareRelationship(userId: string | null, patientId: string): Promise<boolean> {
	if (!userId) return false;
	const row = await one<{ n: string }>(
		`SELECT 1 AS n FROM care_relationship
		 WHERE tenant_id = $1 AND user_id = $2 AND patient_id = $3
		   AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())
		 LIMIT 1`,
		[requireTenant().id, userId, patientId]
	);
	return row !== null;
}

export async function activeEmergencyAccess(userId: string | null, patientId: string): Promise<boolean> {
	if (!userId) return false;
	const row = await one<{ n: string }>(
		'SELECT 1 AS n FROM break_glass WHERE tenant_id = $1 AND user_id = $2 AND patient_id = $3 AND expires_at > now() LIMIT 1',
		[requireTenant().id, userId, patientId]
	);
	return row !== null;
}

export async function isBlocked(
	ctx: AuthContext,
	patientId: string,
	resource: FhirResource | null,
	resourceId: string | null
): Promise<boolean> {
	const restrictions = await query<{ scope_extent: string; target_user_id: string | null; target_role: string | null; target_resource: string | null }>(
		`SELECT scope_extent, target_user_id, target_role, target_resource FROM record_restriction
		 WHERE tenant_id = $1 AND patient_id = $2 AND lifted = false
		   AND (valid_until IS NULL OR valid_until > now())`,
		[requireTenant().id, patientId]
	);
	if (restrictions.length === 0) return false;
	const resourceKey = resource ? `${resource.resourceType}/${resource.id}` : resourceId;
	for (const s of restrictions) {
		switch (s.scope_extent) {
			case 'alle':
				return true;
			case 'bruker':
				if (s.target_user_id && s.target_user_id === ctx.userId) return true;
				break;
			case 'rolle':
				if (s.target_role && ctx.roles.includes(s.target_role as never)) return true;
				break;
			case 'dokument':
				if (s.target_resource && resourceKey && s.target_resource === resourceKey) return true;
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
export async function allowedPatients(ctx: AuthContext, max = 2000): Promise<string[] | 'alle'> {
	if (canSeeAllPatients(ctx.roles)) return 'alle';
	if (isPatient(ctx)) {
		const own = ownPatientId(ctx);
		return own ? [own] : [];
	}
	if (ctx.launch.patientId && ctx.scopes.clinical.every((s) => s.context === 'patient')) {
		return [ctx.launch.patientId];
	}
	const rows = await query<{ patient_id: string }>(
		`SELECT DISTINCT patient_id FROM care_relationship
		 WHERE tenant_id = $1 AND user_id = $2 AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())
		 UNION
		 SELECT DISTINCT patient_id FROM break_glass
		 WHERE tenant_id = $1 AND user_id = $2 AND expires_at > now()
		 LIMIT $3`,
		[requireTenant().id, ctx.userId, max]
	);
	return rows.map((r) => r.patient_id);
}

/** Pasienter som har sperret journalen for denne brukeren, og som må filtreres bort. */
export async function blockedPatients(ctx: AuthContext): Promise<Set<string>> {
	const rows = await query<{ patient_id: string; scope_extent: string; target_user_id: string | null; target_role: string | null }>(
		`SELECT patient_id, scope_extent, target_user_id, target_role FROM record_restriction
		 WHERE tenant_id = $1 AND lifted = false AND (valid_until IS NULL OR valid_until > now())
		   AND scope_extent IN ('alle','bruker','role')`,
		[requireTenant().id]
	);
	const blocked = new Set<string>();
	for (const s of rows) {
		if (s.scope_extent === 'alle') blocked.add(s.patient_id);
		else if (s.scope_extent === 'bruker' && s.target_user_id === ctx.userId) blocked.add(s.patient_id);
		else if (s.scope_extent === 'rolle' && s.target_role && ctx.roles.includes(s.target_role as never)) blocked.add(s.patient_id);
	}
	if (blocked.size === 0 || !ctx.userId) return blocked;
	// Nødrett opphever sperringen for de pasientene den gjelder.
	const emergencyAccess = await query<{ patient_id: string }>(
		'SELECT patient_id FROM break_glass WHERE tenant_id = $1 AND user_id = $2 AND expires_at > now()',
		[requireTenant().id, ctx.userId]
	);
	for (const n of emergencyAccess) blocked.delete(n.patient_id);
	return blocked;
}
