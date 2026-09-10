import { en, exec, query, transaction } from '../../db';
import { krevTenant } from '../../tenant/kontekst';
import { nyId } from '../../util/ids';
import { logg, type AuditAktor } from '../../audit';
import { fhirKlient } from '../../fhir/client';
import { SYSTEM } from '../../fhir/kodeverk';
import type { FhirResource } from '../../fhir/types';
import { beregn, oreTilKroner, TAKST_KART, type Fritaksgrunn } from './takster';

/**
 * Regningskort: kravet fastlegen sender til Helfo for én pasientkontakt.
 *
 * Kortet bygges under konsultasjonen, valideres mot takstreglene, og speiles
 * som FHIR Claim slik at oppgjørsdata er tilgjengelige på samme API som resten
 * av journalen. Flere kort samles i en oppgjørsinnsending (KUHR).
 */

export type Kontakttype = 'kontor' | 'sykebesok' | 'e-konsultasjon' | 'telefon' | 'enkel';
export type Kortstatus = 'kladd' | 'klar' | 'sendt' | 'godkjent' | 'avvist' | 'delvis';

export interface Regningskort {
	id: string;
	patient_id: string;
	encounter_id: string | null;
	behandler_id: string;
	hpr_nummer: string | null;
	dato: string;
	kontakttype: Kontakttype;
	diagnose_kode: string | null;
	diagnose_system: string | null;
	refusjon_ore: number;
	egenandel_ore: number;
	frikort: boolean;
	fritak_grunn: string | null;
	status: Kortstatus;
	oppgjor_id: string | null;
	avvisning: string | null;
	claim_id: string | null;
	opprettet: string;
	oppdatert: string;
}

export interface Regningslinje {
	id: string;
	regningskort_id: string;
	takstkode: string;
	antall: number;
	refusjon_ore: number;
	egenandel_ore: number;
	merknad: string | null;
}

export interface NyttKortInn {
	patientId: string;
	encounterId?: string | null;
	behandlerId: string;
	hprNummer?: string | null;
	dato: string;
	kontakttype: Kontakttype;
	diagnoseKode?: string | null;
	diagnoseSystem?: string | null;
	takster: { takstkode: string; antall: number; merknad?: string }[];
	erSpesialistAllmennmedisin?: boolean;
	pasientAlder?: number;
	harFrikort?: boolean;
	fritak?: Fritaksgrunn | null;
}

export interface KortResultat {
	ok: boolean;
	id?: string;
	feil?: string[];
	advarsler?: string[];
	sumRefusjonOre?: number;
	kreverEgenandelOre?: number;
}

export async function opprettRegningskort(inn: NyttKortInn, aktor: AuditAktor): Promise<KortResultat> {
	const beregning = beregn(inn.takster, {
		erSpesialistAllmennmedisin: inn.erSpesialistAllmennmedisin,
		pasientAlder: inn.pasientAlder,
		harFrikort: inn.harFrikort,
		fritak: inn.fritak
	});
	if (beregning.feil.length > 0) {
		return { ok: false, feil: beregning.feil, advarsler: beregning.advarsler };
	}

	const id = nyId();
	await transaction(async () => {
		await exec(
			`INSERT INTO regningskort (id, tenant_id, patient_id, encounter_id, behandler_id, hpr_nummer, dato, kontakttype,
				diagnose_kode, diagnose_system, refusjon_ore, egenandel_ore, frikort, fritak_grunn, status)
			 VALUES ($1,$14,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'klar')`,
			[
				id, inn.patientId, inn.encounterId ?? null, inn.behandlerId, inn.hprNummer ?? null, inn.dato,
				inn.kontakttype, inn.diagnoseKode ?? null, inn.diagnoseSystem ?? SYSTEM.ICPC2,
				beregning.sumRefusjonOre, beregning.kreverEgenandelOre,
				beregning.fritak === 'frikort', beregning.fritak, krevTenant().id
			]
		);
		for (const linje of beregning.linjer) {
			await exec(
				`INSERT INTO regningslinje (id, regningskort_id, takstkode, antall, refusjon_ore, egenandel_ore, merknad)
				 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				[nyId(), id, linje.takstkode, linje.antall, linje.refusjonOre, linje.egenandelOre,
				 inn.takster.find((t) => t.takstkode === linje.takstkode)?.merknad ?? null]
			);
		}
	});

	const claimId = await speilSomClaim(id, inn, beregning);
	if (claimId) await exec('UPDATE regningskort SET claim_id = $2 WHERE id = $1 AND tenant_id = $3', [id, claimId, krevTenant().id]);

	await logg(
		{
			type: 'oppgjor', subtype: 'regningskort:opprettet', handling: 'C', utfall: '0',
			patientId: inn.patientId, entityRef: claimId ?? `urn:regningskort:${id}`, purposeOfUse: 'HPAYMT',
			detaljer: {
				takster: inn.takster.map((t) => `${t.takstkode}x${t.antall}`).join(','),
				refusjon: oreTilKroner(beregning.sumRefusjonOre),
				egenandel: oreTilKroner(beregning.kreverEgenandelOre)
			}
		},
		aktor
	);

	return {
		ok: true, id,
		advarsler: beregning.advarsler,
		sumRefusjonOre: beregning.sumRefusjonOre,
		kreverEgenandelOre: beregning.kreverEgenandelOre
	};
}

async function speilSomClaim(
	id: string,
	inn: NyttKortInn,
	beregning: ReturnType<typeof beregn>
): Promise<string | null> {
	const claim: FhirResource = {
		resourceType: 'Claim',
		identifier: [{ system: 'urn:epj:regningskort', value: id }],
		status: 'active',
		type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
		use: 'claim',
		patient: { reference: `Patient/${inn.patientId}` },
		created: new Date().toISOString(),
		provider: { reference: `Practitioner/${inn.behandlerId}` },
		priority: { coding: [{ code: 'normal' }] },
		insurer: { display: 'Helfo' },
		...(inn.encounterId ? { encounter: [{ reference: `Encounter/${inn.encounterId}` }] } : {}),
		...(inn.diagnoseKode
			? {
					diagnosis: [
						{
							sequence: 1,
							diagnosisCodeableConcept: {
								coding: [{ system: inn.diagnoseSystem ?? SYSTEM.ICPC2, code: inn.diagnoseKode }]
							}
						}
					]
				}
			: {}),
		item: beregning.linjer.map((l, i) => ({
			sequence: i + 1,
			productOrService: {
				coding: [{ system: SYSTEM.TAKST, code: l.takstkode, display: l.tekst }]
			},
			quantity: { value: l.antall },
			net: { value: (l.refusjonOre + l.egenandelOre) / 100, currency: 'NOK' }
		})),
		total: { value: (beregning.sumRefusjonOre + beregning.kreverEgenandelOre) / 100, currency: 'NOK' }
	};
	try {
		const svar = await fhirKlient.opprett(claim);
		return `Claim/${svar.ressurs.id}`;
	} catch (err) {
		console.error('[helfo] klarte ikke å speile regningskort som Claim', err);
		return null;
	}
}

export async function hentKort(id: string): Promise<{ kort: Regningskort; linjer: Regningslinje[] } | null> {
	const kort = await en<Regningskort>('SELECT * FROM regningskort WHERE id = $1 AND tenant_id = $2', [id, krevTenant().id]);
	if (!kort) return null;
	// Linjene arver virksomhet gjennom kortet, som allerede er avgrenset.
	const linjer = await query<Regningslinje>('SELECT * FROM regningslinje WHERE regningskort_id = $1 ORDER BY takstkode', [id]);
	return { kort, linjer };
}

export async function listKort(filter: { status?: Kortstatus; patientId?: string; fra?: string; til?: string; grense?: number }): Promise<Regningskort[]> {
	const vilkar = ['tenant_id = $1'];
	const params: unknown[] = [krevTenant().id];
	if (filter.status) { params.push(filter.status); vilkar.push(`status = $${params.length}`); }
	if (filter.patientId) { params.push(filter.patientId); vilkar.push(`patient_id = $${params.length}`); }
	if (filter.fra) { params.push(filter.fra); vilkar.push(`dato >= $${params.length}`); }
	if (filter.til) { params.push(filter.til); vilkar.push(`dato <= $${params.length}`); }
	params.push(Math.min(filter.grense ?? 200, 1000));
	return query<Regningskort>(
		`SELECT * FROM regningskort WHERE ${vilkar.join(' AND ')} ORDER BY dato DESC, opprettet DESC LIMIT $${params.length}`,
		params
	);
}

export async function slettKladd(id: string, aktor: AuditAktor): Promise<boolean> {
	const kort = await en<Regningskort>(
		"SELECT * FROM regningskort WHERE id = $1 AND tenant_id = $2 AND status IN ('kladd','klar')",
		[id, krevTenant().id]
	);
	if (!kort) return false;
	await exec('DELETE FROM regningskort WHERE id = $1 AND tenant_id = $2', [id, krevTenant().id]);
	await logg(
		{ type: 'oppgjor', subtype: 'regningskort:slettet', handling: 'D', utfall: '0', patientId: kort.patient_id, entityRef: `urn:regningskort:${id}` },
		aktor
	);
	return true;
}

/** Kontrollerer at takstkodene på et kort fortsatt finnes i takstregisteret. */
export function ukjenteTakster(linjer: Regningslinje[]): string[] {
	return linjer.map((l) => l.takstkode).filter((k) => !TAKST_KART.has(k));
}
