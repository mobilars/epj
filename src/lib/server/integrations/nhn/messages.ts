import { el, type XmlNode } from '../../util/xml';
import { SYSTEM } from '../../fhir/codesystems';
import { buildMsgHead, ownPart, MESSAGETYPES, type Part, type PatientPart } from './msg-head';

/**
 * The clinical messages a general practice sends and receives:
 * dialogue message, referral, discharge summary and laboratory order.
 */

export const NS = {
	DIALOG: 'http://www.kith.no/xmlstds/dialog/2013-01-23',
	REFERRAL: 'http://www.kith.no/xmlstds/henvisning/2012-02-15',
	DISCHARGESUMMARY: 'http://www.kith.no/xmlstds/epikrise/2012-02-15',
	BASE: 'http://www.kith.no/xmlstds'
} as const;

// ---------------------------------------------------------------------------
// Dialogmelding
// ---------------------------------------------------------------------------

export type DialogType = 'notat' | 'foresporsel' | 'svar' | 'henvendelse';

export interface DialogueMessageIn {
	msgId: string;
	type: DialogType;
	temaCode?: string;
	temaDescription?: string;
	content: string;
	recipient: Part;
	patient: PatientPart;
	practitioner: { name: string; hpr: string };
	refMsgId?: string;
}

/** Code system 8127 - topic codes for clinical dialogue. */
export const DIALOG_TEMA = {
	REQUEST_HELSEOPPLYSNINGER: { code: '1', text: 'Forespørsel om pasient' },
	RESPONSE_HELSEOPPLYSNINGER: { code: '2', text: 'Svar på forespørsel om pasient' },
	DEVIATION: { code: '3', text: 'Avviksmelding' },
	NOTE: { code: '4', text: 'Helsefaglig notat' },
	MEDISINSK_ASSESSMENT: { code: '5', text: 'Medisinsk vurdering' }
} as const;

export function buildDialogueMessage(inValue: DialogueMessageIn): string {
	const typeCode =
		inValue.type === 'notat' ? MESSAGETYPES.DIALOG_NOTE
		: inValue.type === 'foresporsel' ? MESSAGETYPES.DIALOG_REQUEST
		: inValue.type === 'svar' ? MESSAGETYPES.DIALOG_RESPONSE
		: MESSAGETYPES.DIALOG_HELSEFAGLIG;

	const clinicalMessage: XmlNode = el(
		'Dialogmelding',
		[
			el(inValue.type === 'foresporsel' || inValue.type === 'svar' ? 'Foresporsel' : 'Notat', [
				el('TemaKodet', null, {
					V: inValue.temaCode ?? DIALOG_TEMA.NOTE.code,
					S: '2.16.578.1.12.4.1.1.8127',
					DN: inValue.temaDescription ?? DIALOG_TEMA.NOTE.text
				}),
				el('TekstNotatInnhold', inValue.content),
				el('DokIdNotat', inValue.msgId)
			])
		],
		{ xmlns: NS.DIALOG }
	);

	return buildMsgHead({
		msgId: inValue.msgId,
		type: typeCode,
		sender: ownPart(inValue.practitioner),
		recipient: inValue.recipient,
		patient: inValue.patient,
		clinicalMessage,
		clinicalMessageDescription: typeCode.name,
		refMsgId: inValue.refMsgId,
		requireReceipt: true
	});
}

// ---------------------------------------------------------------------------
// Henvisning
// ---------------------------------------------------------------------------

export interface ReferralIn {
	msgId: string;
	recipient: Part;
	patient: PatientPart;
	practitioner: { name: string; hpr: string };
	/** ICPC-2 or ICD-10. */
	diagnosis?: { code: string; text: string; system?: string };
	problem: string;
	anamnese?: string;
	findings?: string;
	earlierBehandling?: string;
	medisiner?: string;
	requestedExamination?: string;
	hastegrad: 'ordinaer' | 'haster' | 'akutt';
	pasientenInformed?: boolean;
	attachment?: { title: string; type: string }[];
}

const HASTEGRAD_CODE: Record<ReferralIn['hastegrad'], { V: string; DN: string }> = {
	ordinaer: { V: '3', DN: 'Ordinær' },
	haster: { V: '2', DN: 'Haster' },
	akutt: { V: '1', DN: 'Akutt' }
};

export function buildReferral(inValue: ReferralIn): string {
	const clinicalMessage: XmlNode = el(
		'Henvisning',
		[
			el('TypeHenvendelse', null, { V: 'H', DN: 'Henvisning', S: '2.16.578.1.12.4.1.1.8121' }),
			el('Hastegrad', null, { ...HASTEGRAD_CODE[inValue.hastegrad], S: '2.16.578.1.12.4.1.1.8125' }),
			el('DatoHenvisning', new Date().toISOString().slice(0, 10)),
			inValue.diagnosis
				? el('Diagnose', [
						el('DiagnoseKode', null, {
							V: inValue.diagnosis.code,
							S: inValue.diagnosis.system ?? SYSTEM.ICPC2,
							DN: inValue.diagnosis.text
						})
					])
				: null,
			el('Problemstilling', [
				el('Overskrift', 'Problemstilling'),
				el('Tekst', inValue.problem)
			]),
			inValue.anamnese ? el('Anamnese', [el('Overskrift', 'Anamnese'), el('Tekst', inValue.anamnese)]) : null,
			inValue.findings ? el('Funn', [el('Overskrift', 'Aktuelle funn'), el('Tekst', inValue.findings)]) : null,
			inValue.earlierBehandling
				? el('TidligereBehandling', [el('Overskrift', 'Tidligere behandling'), el('Tekst', inValue.earlierBehandling)])
				: null,
			inValue.medisiner ? el('Medisiner', [el('Overskrift', 'Legemidler i bruk'), el('Tekst', inValue.medisiner)]) : null,
			inValue.requestedExamination
				? el('OnsketUndersokelse', [el('Overskrift', 'Ønsket undersøkelse'), el('Tekst', inValue.requestedExamination)])
				: null,
			el('PasientInformert', null, { V: inValue.pasientenInformed === false ? 'N' : 'J' }),
			...(inValue.attachment ?? []).map((v) => el('Vedlegg', [el('Tittel', v.title), el('Type', v.type)]))
		],
		{ xmlns: NS.REFERRAL }
	);

	return buildMsgHead({
		msgId: inValue.msgId,
		type: MESSAGETYPES.HENVIS,
		sender: ownPart(inValue.practitioner),
		recipient: inValue.recipient,
		patient: inValue.patient,
		clinicalMessage,
		clinicalMessageDescription: 'Henvisning',
		requireReceipt: true
	});
}

// ---------------------------------------------------------------------------
// Epikrise
// ---------------------------------------------------------------------------

export interface DischargeSummaryIn {
	msgId: string;
	recipient: Part;
	patient: PatientPart;
	practitioner: { name: string; hpr: string };
	encounterFrom: string;
	encounterTo?: string;
	diagnoses: { code: string; text: string; system?: string; hoveddiagnose?: boolean }[];
	sammendrag: string;
	behandling?: string;
	medicationsAtUtskrivning?: string;
	oppfolging?: string;
	assessment?: string;
}

export function buildDischargeSummary(inValue: DischargeSummaryIn): string {
	const clinicalMessage: XmlNode = el(
		'Epikrise',
		[
			el('Kontakt', [
				el('KontaktFra', inValue.encounterFrom),
				inValue.encounterTo ? el('KontaktTil', inValue.encounterTo) : null
			]),
			...inValue.diagnoses.map((d) =>
				el('Diagnose', [
					el('DiagnoseKode', null, { V: d.code, S: d.system ?? SYSTEM.ICD10, DN: d.text }),
					el('Hoveddiagnose', null, { V: d.hoveddiagnose ? 'J' : 'N' })
				])
			),
			el('Sammendrag', [el('Overskrift', 'Sammendrag'), el('Tekst', inValue.sammendrag)]),
			inValue.behandling ? el('Behandling', [el('Overskrift', 'Behandling'), el('Tekst', inValue.behandling)]) : null,
			inValue.assessment ? el('Vurdering', [el('Overskrift', 'Vurdering'), el('Tekst', inValue.assessment)]) : null,
			inValue.medicationsAtUtskrivning
				? el('Legemidler', [el('Overskrift', 'Legemidler ved utskrivning'), el('Tekst', inValue.medicationsAtUtskrivning)])
				: null,
			inValue.oppfolging ? el('Oppfolging', [el('Overskrift', 'Videre oppfølging'), el('Tekst', inValue.oppfolging)]) : null
		],
		{ xmlns: NS.DISCHARGESUMMARY }
	);

	return buildMsgHead({
		msgId: inValue.msgId,
		type: MESSAGETYPES.DISCHARGESUMMARY,
		sender: ownPart(inValue.practitioner),
		recipient: inValue.recipient,
		patient: inValue.patient,
		clinicalMessage,
		clinicalMessageDescription: 'Epikrise',
		requireReceipt: true
	});
}

// ---------------------------------------------------------------------------
// Laboratorierekvisisjon
// ---------------------------------------------------------------------------

export interface LabOrderIn {
	msgId: string;
	recipient: Part;
	patient: PatientPart;
	practitioner: { name: string; hpr: string };
	analyser: { code: string; name: string; system?: string }[];
	clinicalOpplysninger?: string;
	specimenCollectedAt?: string;
	hastegrad?: 'ordinaer' | 'haster';
}

export function buildLabOrder(inValue: LabOrderIn): string {
	const clinicalMessage: XmlNode = el(
		'MedicalRequest',
		[
			el('RequestDate', new Date().toISOString()),
			el('Priority', null, { V: inValue.hastegrad === 'haster' ? '2' : '3', DN: inValue.hastegrad === 'haster' ? 'Haster' : 'Ordinær' }),
			inValue.specimenCollectedAt ? el('SpecimenCollected', inValue.specimenCollectedAt) : null,
			inValue.clinicalOpplysninger ? el('ClinicalInfo', inValue.clinicalOpplysninger) : null,
			...inValue.analyser.map((a) =>
				el('RequestedService', [el('ServiceCode', null, { V: a.code, S: a.system ?? SYSTEM.LOINC, DN: a.name })])
			)
		],
		{ xmlns: NS.BASE }
	);

	return buildMsgHead({
		msgId: inValue.msgId,
		type: MESSAGETYPES.MEDLAB,
		sender: ownPart(inValue.practitioner),
		recipient: inValue.recipient,
		patient: inValue.patient,
		clinicalMessage,
		clinicalMessageDescription: 'Laboratorierekvisisjon',
		requireReceipt: true
	});
}
