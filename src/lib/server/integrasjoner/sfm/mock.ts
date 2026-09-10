import { en, exec } from '../../db';
import { krevTenant } from '../../tenant/kontekst';
import { nyId } from '../../util/ids';
import type { Legemiddelliste, LegemiddelOppforing, SfmOperasjon, SfmSvar, ForskrivningInn } from './index';

/**
 * Lokal SFM-simulator.
 *
 * Gjengir hovedtrekkene i SFM Basis så flyten kan kjøres ende-til-ende uten
 * oppkobling mot Norsk helsenett: forskrivning gir en reseptid, legemiddellisten
 * bygges opp av det som er forskrevet, seponering markerer oppføringen, og
 * interaksjons- og dobbeltforskrivningsvarsler simuleres.
 *
 * Tilstanden lagres i `sfm_synk`, slik at simulatoren overlever omstart.
 */

interface MockTilstand {
	legemidler: LegemiddelOppforing[];
	oppdatert: string;
}

const NOKKEL = 'mock-tilstand';

async function lesTilstand(patientId: string): Promise<MockTilstand> {
	const rad = await en<{ svar: MockTilstand }>(
		'SELECT svar FROM sfm_synk WHERE tenant_id = $3 AND patient_id = $1 AND operasjon = $2 ORDER BY oppdatert DESC LIMIT 1',
		[patientId, NOKKEL, krevTenant().id]
	);
	return rad?.svar ?? { legemidler: [], oppdatert: new Date().toISOString() };
}

async function skrivTilstand(patientId: string, tilstand: MockTilstand): Promise<void> {
	await exec(
		`INSERT INTO sfm_synk (id, tenant_id, patient_id, operasjon, status, svar) VALUES ($1,$5,$2,$3,'ok',$4)`,
		[nyId(), patientId, NOKKEL, JSON.stringify({ ...tilstand, oppdatert: new Date().toISOString() }), krevTenant().id]
	);
}

/** Et lite utvalg kjente interaksjoner, nok til å vise varslingsflyten. */
const INTERAKSJONER: { atc: [string, string]; alvorlighet: 'alvorlig' | 'moderat'; tekst: string }[] = [
	{ atc: ['B01AA03', 'M01AE01'], alvorlighet: 'alvorlig', tekst: 'Warfarin og ibuprofen: økt blødningsrisiko.' },
	{ atc: ['C09AA05', 'C03DA01'], alvorlighet: 'moderat', tekst: 'ACE-hemmer og spironolakton: risiko for hyperkalemi.' },
	{ atc: ['N05BA01', 'N02AA01'], alvorlighet: 'alvorlig', tekst: 'Benzodiazepin og opioid: fare for respirasjonsdepresjon.' },
	{ atc: ['J01FA01', 'C10AA01'], alvorlighet: 'moderat', tekst: 'Erytromycin og simvastatin: økt risiko for myopati.' }
];

function finnInteraksjoner(nyAtc: string | undefined, eksisterende: LegemiddelOppforing[]): string[] {
	if (!nyAtc) return [];
	const aktive = eksisterende.filter((l) => l.status === 'aktiv').map((l) => l.atc).filter(Boolean) as string[];
	const funn: string[] = [];
	for (const i of INTERAKSJONER) {
		const [a, b] = i.atc;
		if ((nyAtc === a && aktive.includes(b)) || (nyAtc === b && aktive.includes(a))) {
			funn.push(`${i.alvorlighet.toUpperCase()}: ${i.tekst}`);
		}
	}
	return funn;
}

export async function mockSfm<T>(operasjon: SfmOperasjon, kropp: unknown, patientId: string): Promise<SfmSvar<T>> {
	const tilstand = await lesTilstand(patientId);

	switch (operasjon) {
		case 'hentLegemiddelliste': {
			const liste: Legemiddelliste = {
				patientId,
				oppdatert: tilstand.oppdatert,
				kilde: 'sfm',
				legemidler: tilstand.legemidler,
				avvik: tilstand.legemidler.filter((l) => l.status === 'utkast').map((l) => `${l.navn} er ikke bekreftet mot PLL`)
			};
			return { ok: true, data: liste as T };
		}

		case 'forskriv': {
			const inn = kropp as ForskrivningInn;
			const varsler = finnInteraksjoner(inn.legemiddel.atc, tilstand.legemidler);
			const dobbelt = tilstand.legemidler.some(
				(l) => l.status === 'aktiv' && l.atc && l.atc === inn.legemiddel.atc
			);
			if (dobbelt) varsler.push('DOBBELTFORSKRIVNING: pasienten har allerede en aktiv resept med samme virkestoff.');

			const reseptId = `R${Date.now().toString(36).toUpperCase()}`;
			const oppforing: LegemiddelOppforing = {
				reseptId,
				navn: [inn.legemiddel.navn, inn.legemiddel.styrke, inn.legemiddel.form].filter(Boolean).join(' '),
				atc: inn.legemiddel.atc,
				form: inn.legemiddel.form,
				styrke: inn.legemiddel.styrke,
				dosering: inn.dosering,
				indikasjon: inn.indikasjon,
				startet: new Date().toISOString().slice(0, 10),
				forskriver: inn.forskriverNavn,
				refusjon: inn.refusjonKode ? { hjemmel: inn.refusjonHjemmel ?? '§ 5-14', kode: inn.refusjonKode } : null,
				status: 'aktiv'
			};
			await skrivTilstand(patientId, { legemidler: [...tilstand.legemidler, oppforing], oppdatert: new Date().toISOString() });
			return { ok: true, reseptId, data: { reseptId, varsler } as T };
		}

		case 'seponer': {
			const { reseptId, arsak } = kropp as { reseptId: string; arsak: string };
			const funnet = tilstand.legemidler.find((l) => l.reseptId === reseptId);
			if (!funnet) return { ok: false, feil: `Fant ingen resept med id ${reseptId}` };
			const oppdatert = tilstand.legemidler.map((l) =>
				l.reseptId === reseptId ? { ...l, status: 'seponert' as const, seponert: new Date().toISOString().slice(0, 10), indikasjon: arsak } : l
			);
			await skrivTilstand(patientId, { legemidler: oppdatert, oppdatert: new Date().toISOString() });
			return { ok: true, reseptId, data: { reseptId } as T };
		}

		case 'fornye': {
			const { reseptId } = kropp as { reseptId: string };
			const gammel = tilstand.legemidler.find((l) => l.reseptId === reseptId);
			if (!gammel) return { ok: false, feil: `Fant ingen resept med id ${reseptId}` };
			const nyReseptId = `R${Date.now().toString(36).toUpperCase()}`;
			await skrivTilstand(patientId, {
				legemidler: [
					...tilstand.legemidler.map((l) => (l.reseptId === reseptId ? { ...l, status: 'utgatt' as const } : l)),
					{ ...gammel, reseptId: nyReseptId, startet: new Date().toISOString().slice(0, 10), status: 'aktiv' }
				],
				oppdatert: new Date().toISOString()
			});
			return { ok: true, reseptId: nyReseptId, data: { reseptId: nyReseptId } as T };
		}

		case 'tilbakekall': {
			const { reseptId } = kropp as { reseptId: string };
			await skrivTilstand(patientId, {
				legemidler: tilstand.legemidler.filter((l) => l.reseptId !== reseptId),
				oppdatert: new Date().toISOString()
			});
			return { ok: true, reseptId, data: { reseptId } as T };
		}

		case 'hentUtleveringer': {
			const utleveringer = tilstand.legemidler
				.filter((l) => l.status === 'aktiv')
				.map((l) => ({
					reseptId: l.reseptId,
					legemiddel: l.navn,
					apotek: 'Apotek 1 Storgata',
					utlevert: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
					antall: 1
				}));
			return { ok: true, data: { utleveringer } as T };
		}
	}
}
