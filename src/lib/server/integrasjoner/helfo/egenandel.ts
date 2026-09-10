import { en, exec } from '../../db';
import { krevTenant } from '../../tenant/kontekst';
import { config } from '../../config';
import { nyId } from '../../util/ids';
import { logg, type AuditAktor } from '../../audit';

/**
 * Oppslag mot Helfos egenandels- og frikorttjeneste.
 *
 * Egenandelstak 1 gjelder blant annet lege, psykolog, poliklinikk, røntgen,
 * reiser og legemidler på blå resept. Når taket er nådd, utsteder Helfo frikort
 * automatisk, og videre egenandeler kreves ikke inn av behandleren.
 *
 * Selve oppslaget er en behandling av personopplysninger og logges særskilt.
 */

/** Egenandelstak 1. Fastsettes årlig i statsbudsjettet - må oppdateres. */
export const EGENANDELSTAK_ORE = 327_800;
export const EGENANDELSTAK_AR = 2026;

export interface Egenandelstatus {
	patientId: string;
	harFrikort: boolean;
	frikortGyldigTil: string | null;
	opptjentOre: number;
	gjenstaendeOre: number;
	kilde: 'helfo' | 'cache' | 'manuell';
	hentet: string;
}

const CACHE_MINUTTER = 60;

export async function hentEgenandelstatus(
	patientId: string,
	fnr: string,
	aktor: AuditAktor,
	tvingOppfrisking = false
): Promise<Egenandelstatus> {
	if (!tvingOppfrisking) {
		const cachet = await en<{ har_frikort: boolean; frikort_til: string | null; opptjent_ore: number; utfort: string }>(
			`SELECT har_frikort, frikort_til, opptjent_ore, utfort FROM egenandel_oppslag
			 WHERE tenant_id = $3 AND patient_id = $1 AND utfort > now() - ($2 || ' minutes')::interval
			 ORDER BY utfort DESC LIMIT 1`,
			[patientId, String(CACHE_MINUTTER), krevTenant().id]
		);
		if (cachet) {
			return {
				patientId,
				harFrikort: cachet.har_frikort,
				frikortGyldigTil: cachet.frikort_til,
				opptjentOre: cachet.opptjent_ore ?? 0,
				gjenstaendeOre: Math.max(0, EGENANDELSTAK_ORE - (cachet.opptjent_ore ?? 0)),
				kilde: 'cache',
				hentet: cachet.utfort
			};
		}
	}

	const svar = config.integrasjoner.modus === 'mock' ? mockStatus(fnr) : await hentFraHelfo(fnr);

	await exec(
		`INSERT INTO egenandel_oppslag (id, tenant_id, patient_id, utfort_av, har_frikort, frikort_til, opptjent_ore, kilde)
		 VALUES ($1,$8,$2,$3,$4,$5,$6,$7)`,
		[nyId(), patientId, aktor.userId ?? 'system', svar.harFrikort, svar.frikortGyldigTil, svar.opptjentOre, svar.kilde, krevTenant().id]
	);
	await logg(
		{
			type: 'integrasjon', subtype: 'helfo:egenandel', handling: 'R', utfall: '0',
			patientId, purposeOfUse: 'HPAYMT',
			detaljer: { frikort: svar.harFrikort, kilde: svar.kilde }
		},
		aktor
	);

	return { ...svar, patientId, gjenstaendeOre: Math.max(0, EGENANDELSTAK_ORE - svar.opptjentOre), hentet: new Date().toISOString() };
}

async function hentFraHelfo(fnr: string): Promise<Omit<Egenandelstatus, 'patientId' | 'gjenstaendeOre' | 'hentet'>> {
	const url = config.integrasjoner.helfo.egenandelUrl;
	if (!url) throw new Error('Helfo egenandelstjeneste er ikke konfigurert (EPJ_HELFO_EGENANDEL_URL)');
	const svar = await fetch(`${url}/frikortstatus`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ foedselsnummer: fnr, avtaleId: config.integrasjoner.helfo.avtaleId }),
		signal: AbortSignal.timeout(20_000)
	});
	if (!svar.ok) throw new Error(`Helfo svarte ${svar.status}`);
	const kropp = (await svar.json()) as { harFrikort: boolean; gyldigTil?: string; opptjentBelop?: number };
	return {
		harFrikort: kropp.harFrikort,
		frikortGyldigTil: kropp.gyldigTil ?? null,
		opptjentOre: Math.round((kropp.opptjentBelop ?? 0) * 100),
		kilde: 'helfo'
	};
}

/**
 * Deterministisk simulering: siste siffer i fødselsnummeret avgjør status, slik
 * at testdata gir forutsigbare og gjentakbare resultater.
 */
function mockStatus(fnr: string): Omit<Egenandelstatus, 'patientId' | 'gjenstaendeOre' | 'hentet'> {
	const siffer = Number(fnr.slice(-1)) || 0;
	if (siffer >= 8) {
		return {
			harFrikort: true,
			frikortGyldigTil: `${EGENANDELSTAK_AR}-12-31`,
			opptjentOre: EGENANDELSTAK_ORE,
			kilde: 'helfo'
		};
	}
	return {
		harFrikort: false,
		frikortGyldigTil: null,
		opptjentOre: Math.round((siffer / 10) * EGENANDELSTAK_ORE),
		kilde: 'helfo'
	};
}
