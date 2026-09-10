import { en, exec, query, transaction } from '../../db';
import { krevTenant } from '../../tenant/kontekst';
import { config } from '../../config';
import { dokument, el } from '../../util/xml';
import { nyId } from '../../util/ids';
import { logg, type AuditAktor } from '../../audit';
import { oreTilKroner } from './takster';
import type { Regningskort, Regningslinje } from './regningskort';

/**
 * Oppgjør mot Helfo (KUHR).
 *
 * Legen sender periodiske oppgjørskrav med regningskortene fra perioden.
 * Helfo kontrollerer og avregner, og returnerer en oppgjørsrapport der enkelte
 * kort kan være avvist. Avviste kort må rettes og sendes på nytt - derfor
 * beholder vi koblingen mellom kort, innsending og avvisningsårsak.
 */

export type Oppgjorstatus = 'generert' | 'sendt' | 'mottatt' | 'avregnet' | 'avvist';

export interface Oppgjor {
	id: string;
	periode_fra: string;
	periode_til: string;
	antall_kort: number;
	sum_refusjon_ore: number;
	sum_egenandel_ore: number;
	status: Oppgjorstatus;
	kvittering: unknown;
	opprettet: string;
	sendt: string | null;
	sendt_av: string | null;
}

export interface ForhandsvisningsResultat {
	antallKort: number;
	sumRefusjonOre: number;
	sumEgenandelOre: number;
	kort: { id: string; dato: string; patientId: string; refusjonOre: number; egenandelOre: number }[];
	advarsler: string[];
}

export async function forhandsvis(fra: string, til: string): Promise<ForhandsvisningsResultat> {
	const kort = await query<Regningskort>(
		"SELECT * FROM regningskort WHERE tenant_id = $3 AND status = 'klar' AND dato >= $1 AND dato <= $2 ORDER BY dato",
		[fra, til, krevTenant().id]
	);
	const advarsler: string[] = [];
	if (kort.length === 0) advarsler.push('Ingen regningskort med status «klar» i perioden.');
	const utenDiagnose = kort.filter((k) => !k.diagnose_kode);
	if (utenDiagnose.length > 0) {
		advarsler.push(`${utenDiagnose.length} regningskort mangler diagnosekode. Helfo kan avvise disse.`);
	}
	return {
		antallKort: kort.length,
		sumRefusjonOre: kort.reduce((s, k) => s + k.refusjon_ore, 0),
		sumEgenandelOre: kort.reduce((s, k) => s + k.egenandel_ore, 0),
		kort: kort.map((k) => ({
			id: k.id, dato: k.dato, patientId: k.patient_id,
			refusjonOre: k.refusjon_ore, egenandelOre: k.egenandel_ore
		})),
		advarsler
	};
}

/** Bygger oppgjørsfilen og markerer kortene som sendt. */
export async function genererOppgjor(fra: string, til: string, aktor: AuditAktor): Promise<{ ok: boolean; id?: string; feil?: string }> {
	const tenantId = krevTenant().id;
	const kort = await query<Regningskort>(
		"SELECT * FROM regningskort WHERE tenant_id = $3 AND status = 'klar' AND dato >= $1 AND dato <= $2 ORDER BY dato",
		[fra, til, tenantId]
	);
	if (kort.length === 0) return { ok: false, feil: 'Ingen regningskort å sende i perioden' };

	const linjerPerKort = new Map<string, Regningslinje[]>();
	for (const k of kort) {
		linjerPerKort.set(k.id, await query<Regningslinje>('SELECT * FROM regningslinje WHERE regningskort_id = $1', [k.id]));
	}

	const id = nyId();
	const fil = byggOppgjorsfil(id, fra, til, kort, linjerPerKort);
	const sumRefusjon = kort.reduce((s, k) => s + k.refusjon_ore, 0);
	const sumEgenandel = kort.reduce((s, k) => s + k.egenandel_ore, 0);

	await transaction(async () => {
		await exec(
			`INSERT INTO oppgjor (id, tenant_id, periode_fra, periode_til, antall_kort, sum_refusjon_ore, sum_egenandel_ore, status, fil)
			 VALUES ($1,$8,$2,$3,$4,$5,$6,'generert',$7)`,
			[id, fra, til, kort.length, sumRefusjon, sumEgenandel, fil, tenantId]
		);
		await exec(
			"UPDATE regningskort SET status = 'sendt', oppgjor_id = $1, oppdatert = now() WHERE id = ANY($2::text[]) AND tenant_id = $3",
			[id, kort.map((k) => k.id), tenantId]
		);
	});

	await logg(
		{
			type: 'oppgjor', subtype: 'oppgjor:generert', handling: 'C', utfall: '0',
			entityRef: `urn:oppgjor:${id}`, purposeOfUse: 'HPAYMT',
			detaljer: { periode: `${fra}..${til}`, antall: kort.length, refusjon: oreTilKroner(sumRefusjon) }
		},
		aktor
	);
	return { ok: true, id };
}

export async function sendOppgjor(id: string, aktor: AuditAktor): Promise<{ ok: boolean; feil?: string }> {
	const oppgjor = await en<Oppgjor & { fil: string }>('SELECT * FROM oppgjor WHERE id = $1 AND tenant_id = $2', [id, krevTenant().id]);
	if (!oppgjor) return { ok: false, feil: 'Ukjent oppgjør' };
	if (oppgjor.status !== 'generert') return { ok: false, feil: `Oppgjøret har status ${oppgjor.status}` };

	try {
		const kvittering =
			config.integrasjoner.modus === 'mock'
				? mockInnsending(oppgjor)
				: await sendTilHelfo(oppgjor.fil);

		await exec(
			"UPDATE oppgjor SET status = 'sendt', sendt = now(), sendt_av = $2, kvittering = $3 WHERE id = $1 AND tenant_id = $4",
			[id, aktor.userId, JSON.stringify(kvittering), krevTenant().id]
		);
		await logg(
			{ type: 'oppgjor', subtype: 'oppgjor:sendt', handling: 'E', utfall: '0', entityRef: `urn:oppgjor:${id}`, purposeOfUse: 'HPAYMT', detaljer: { referanse: kvittering.referanse } },
			aktor
		);
		return { ok: true };
	} catch (err) {
		const melding = (err as Error).message;
		await logg(
			{ type: 'oppgjor', subtype: 'oppgjor:sendt', handling: 'E', utfall: '8', utfallBeskrivelse: melding, entityRef: `urn:oppgjor:${id}` },
			aktor
		);
		return { ok: false, feil: melding };
	}
}

async function sendTilHelfo(fil: string): Promise<{ referanse: string; mottatt: string }> {
	const url = config.integrasjoner.helfo.oppgjorUrl;
	if (!url) throw new Error('Helfo oppgjørstjeneste er ikke konfigurert (EPJ_HELFO_OPPGJOR_URL)');
	const svar = await fetch(`${url}/oppgjor`, {
		method: 'POST',
		headers: { 'content-type': 'application/xml', accept: 'application/json' },
		body: fil,
		signal: AbortSignal.timeout(60_000)
	});
	if (!svar.ok) throw new Error(`Helfo svarte ${svar.status}: ${(await svar.text()).slice(0, 300)}`);
	return (await svar.json()) as { referanse: string; mottatt: string };
}

function mockInnsending(oppgjor: Oppgjor): { referanse: string; mottatt: string } {
	return { referanse: `KUHR-${oppgjor.id.slice(0, 8).toUpperCase()}`, mottatt: new Date().toISOString() };
}

/**
 * Registrerer oppgjørsrapporten fra Helfo: hvilke kort som er godkjent og
 * hvilke som er avvist, med årsak.
 */
export async function registrerAvregning(
	oppgjorId: string,
	rapport: { kortId: string; godkjent: boolean; arsak?: string; utbetaltOre?: number }[],
	aktor: AuditAktor
): Promise<{ godkjent: number; avvist: number }> {
	let godkjent = 0;
	let avvist = 0;
	const tenantId = krevTenant().id;
	await transaction(async () => {
		for (const r of rapport) {
			if (r.godkjent) {
				await exec("UPDATE regningskort SET status = 'godkjent', avvisning = NULL, oppdatert = now() WHERE id = $1 AND oppgjor_id = $2 AND tenant_id = $3", [r.kortId, oppgjorId, tenantId]);
				godkjent++;
			} else {
				await exec("UPDATE regningskort SET status = 'avvist', avvisning = $3, oppdatert = now() WHERE id = $1 AND oppgjor_id = $2 AND tenant_id = $4", [r.kortId, oppgjorId, r.arsak ?? 'Avvist av Helfo', tenantId]);
				avvist++;
			}
		}
		await exec("UPDATE oppgjor SET status = 'avregnet' WHERE id = $1 AND tenant_id = $2", [oppgjorId, tenantId]);
	});
	await logg(
		{ type: 'oppgjor', subtype: 'oppgjor:avregnet', handling: 'U', utfall: avvist > 0 ? '4' : '0', entityRef: `urn:oppgjor:${oppgjorId}`, detaljer: { godkjent, avvist } },
		aktor
	);
	return { godkjent, avvist };
}

/**
 * Oppgjørsfil.
 *
 * KUHR tar imot regningskort i et fastsatt XML-format. Strukturen under følger
 * hovedelementene (konto, regningskort, takstlinjer), men feltnavn og
 * kodeverksreferanser må kontrolleres mot Helfos gjeldende meldingsbeskrivelse
 * før produksjonssetting.
 */
export function byggOppgjorsfil(
	id: string,
	fra: string,
	til: string,
	kort: Regningskort[],
	linjer: Map<string, Regningslinje[]>
): string {
	const rot = el('Oppgjorskrav', [
		el('Kravhode', [
			el('KravId', id),
			el('Konto', config.integrasjoner.helfo.avtaleId || krevTenant().organisasjonsnummer),
			el('Organisasjonsnummer', krevTenant().organisasjonsnummer),
			el('Virksomhet', krevTenant().navn),
			el('PeriodeFra', fra),
			el('PeriodeTil', til),
			el('Generert', new Date().toISOString()),
			el('AntallRegningskort', kort.length),
			el('SumRefusjon', (kort.reduce((s, k) => s + k.refusjon_ore, 0) / 100).toFixed(2)),
			el('SumEgenandel', (kort.reduce((s, k) => s + k.egenandel_ore, 0) / 100).toFixed(2))
		]),
		el(
			'Regningskort',
			kort.map((k) =>
				el('Kort', [
					el('KortId', k.id),
					el('Dato', k.dato),
					el('Kontakttype', k.kontakttype),
					el('BehandlerHPR', k.hpr_nummer),
					k.diagnose_kode
						? el('Diagnose', [el('Kode', k.diagnose_kode), el('Kodeverk', k.diagnose_system)])
						: null,
					el('Frikort', k.frikort ? 'J' : 'N'),
					k.fritak_grunn ? el('FritakGrunn', k.fritak_grunn) : null,
					el('Refusjon', (k.refusjon_ore / 100).toFixed(2)),
					el('Egenandel', (k.egenandel_ore / 100).toFixed(2)),
					el(
						'Takstlinjer',
						(linjer.get(k.id) ?? []).map((l) =>
							el('Takstlinje', [
								el('Takstkode', l.takstkode),
								el('Antall', l.antall),
								el('Refusjon', (l.refusjon_ore / 100).toFixed(2)),
								el('Egenandel', (l.egenandel_ore / 100).toFixed(2)),
								l.merknad ? el('Merknad', l.merknad) : null
							])
						)
					)
				])
			)
		)
	]);
	return dokument(rot);
}

export async function listOppgjor(grense = 50): Promise<Oppgjor[]> {
	return query<Oppgjor>(
		`SELECT id, periode_fra, periode_til, antall_kort, sum_refusjon_ore, sum_egenandel_ore, status, kvittering, opprettet, sendt, sendt_av
		 FROM oppgjor WHERE tenant_id = $2 ORDER BY opprettet DESC LIMIT $1`,
		[grense, krevTenant().id]
	);
}

export async function hentOppgjor(id: string): Promise<(Oppgjor & { fil: string }) | null> {
	return en<Oppgjor & { fil: string }>('SELECT * FROM oppgjor WHERE id = $1 AND tenant_id = $2', [id, krevTenant().id]);
}
