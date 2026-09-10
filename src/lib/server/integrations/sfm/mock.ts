import { one, exec } from '../../db';
import { requireTenant } from '../../tenant/context';
import { newId } from '../../util/ids';
import type { MedicationList, MedicationEntry, SfmOperation, SfmResponse, PrescribingIn } from './index';

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

interface MockState {
	medications: MedicationEntry[];
	updated_at: string;
}

const KEY = 'mock-tilstand';

async function readState(patientId: string): Promise<MockState> {
	const row = await one<{ response: MockState }>(
		'SELECT response FROM sfm_sync WHERE tenant_id = $3 AND patient_id = $1 AND operation = $2 ORDER BY updated_at DESC LIMIT 1',
		[patientId, KEY, requireTenant().id]
	);
	return row?.response ?? { medications: [], updated_at: new Date().toISOString() };
}

async function writeState(patientId: string, state: MockState): Promise<void> {
	await exec(
		`INSERT INTO sfm_sync (id, tenant_id, patient_id, operation, status, response) VALUES ($1,$5,$2,$3,'ok',$4)`,
		[newId(), patientId, KEY, JSON.stringify({ ...state, updated_at: new Date().toISOString() }), requireTenant().id]
	);
}

/** Et lite utvalg kjente interaksjoner, nok til å vise varslingsflyten. */
const INTERACTIONS: { atc: [string, string]; severity: 'alvorlig' | 'moderat'; text: string }[] = [
	{ atc: ['B01AA03', 'M01AE01'], severity: 'alvorlig', text: 'Warfarin og ibuprofen: økt blødningsrisiko.' },
	{ atc: ['C09AA05', 'C03DA01'], severity: 'moderat', text: 'ACE-hemmer og spironolakton: risiko for hyperkalemi.' },
	{ atc: ['N05BA01', 'N02AA01'], severity: 'alvorlig', text: 'Benzodiazepin og opioid: fare for respirasjonsdepresjon.' },
	{ atc: ['J01FA01', 'C10AA01'], severity: 'moderat', text: 'Erytromycin og simvastatin: økt risiko for myopati.' }
];

function findInteractions(newAtc: string | undefined, existing: MedicationEntry[]): string[] {
	if (!newAtc) return [];
	const aktive = existing.filter((l) => l.status === 'aktiv').map((l) => l.atc).filter(Boolean) as string[];
	const findings: string[] = [];
	for (const i of INTERACTIONS) {
		const [a, b] = i.atc;
		if ((newAtc === a && aktive.includes(b)) || (newAtc === b && aktive.includes(a))) {
			findings.push(`${i.severity.toUpperCase()}: ${i.text}`);
		}
	}
	return findings;
}

export async function mockSfm<T>(operation: SfmOperation, body: unknown, patientId: string): Promise<SfmResponse<T>> {
	const state = await readState(patientId);

	switch (operation) {
		case 'hentLegemiddelliste': {
			const list: MedicationList = {
				patientId,
				updated_at: state.updated_at,
				source: 'sfm',
				medications: state.medications,
				deviation: state.medications.filter((l) => l.status === 'utkast').map((l) => `${l.name} er ikke bekreftet mot PLL`)
			};
			return { ok: true, data: list as T };
		}

		case 'forskriv': {
			const inValue = body as PrescribingIn;
			const alerts = findInteractions(inValue.medication.atc, state.medications);
			const dobbelt = state.medications.some(
				(l) => l.status === 'aktiv' && l.atc && l.atc === inValue.medication.atc
			);
			if (dobbelt) alerts.push('DOBBELTFORSKRIVNING: pasienten har allerede en aktiv resept med samme virkestoff.');

			const prescriptionId = `R${Date.now().toString(36).toUpperCase()}`;
			const entry: MedicationEntry = {
				prescriptionId,
				name: [inValue.medication.name, inValue.medication.strength, inValue.medication.form].filter(Boolean).join(' '),
				atc: inValue.medication.atc,
				form: inValue.medication.form,
				strength: inValue.medication.strength,
				dosage: inValue.dosage,
				indication: inValue.indication,
				started_at: new Date().toISOString().slice(0, 10),
				forskriver: inValue.forskriverName,
				reimbursement: inValue.reimbursementCode ? { legalBasis: inValue.reimbursementLegalBasis ?? '§ 5-14', code: inValue.reimbursementCode } : null,
				status: 'aktiv'
			};
			await writeState(patientId, { medications: [...state.medications, entry], updated_at: new Date().toISOString() });
			return { ok: true, prescriptionId, data: { prescriptionId, alerts } as T };
		}

		case 'seponer': {
			const { prescriptionId, arsak } = body as { prescriptionId: string; arsak: string };
			const funnet = state.medications.find((l) => l.prescriptionId === prescriptionId);
			if (!funnet) return { ok: false, error: `Fant ingen resept med id ${prescriptionId}` };
			const updated_at = state.medications.map((l) =>
				l.prescriptionId === prescriptionId ? { ...l, status: 'seponert' as const, discontinued: new Date().toISOString().slice(0, 10), indication: arsak } : l
			);
			await writeState(patientId, { medications: updated_at, updated_at: new Date().toISOString() });
			return { ok: true, prescriptionId, data: { prescriptionId } as T };
		}

		case 'fornye': {
			const { prescriptionId } = body as { prescriptionId: string };
			const old = state.medications.find((l) => l.prescriptionId === prescriptionId);
			if (!old) return { ok: false, error: `Fant ingen resept med id ${prescriptionId}` };
			const newPrescriptionId = `R${Date.now().toString(36).toUpperCase()}`;
			await writeState(patientId, {
				medications: [
					...state.medications.map((l) => (l.prescriptionId === prescriptionId ? { ...l, status: 'utgatt' as const } : l)),
					{ ...old, prescriptionId: newPrescriptionId, started_at: new Date().toISOString().slice(0, 10), status: 'aktiv' }
				],
				updated_at: new Date().toISOString()
			});
			return { ok: true, prescriptionId: newPrescriptionId, data: { prescriptionId: newPrescriptionId } as T };
		}

		case 'tilbakekall': {
			const { prescriptionId } = body as { prescriptionId: string };
			await writeState(patientId, {
				medications: state.medications.filter((l) => l.prescriptionId !== prescriptionId),
				updated_at: new Date().toISOString()
			});
			return { ok: true, prescriptionId, data: { prescriptionId } as T };
		}

		case 'hentUtleveringer': {
			const utleveringer = state.medications
				.filter((l) => l.status === 'aktiv')
				.map((l) => ({
					prescriptionId: l.prescriptionId,
					medication: l.name,
					apotek: 'Apotek 1 Storgata',
					utlevert: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10),
					count: 1
				}));
			return { ok: true, data: { utleveringer } as T };
		}
	}
}
