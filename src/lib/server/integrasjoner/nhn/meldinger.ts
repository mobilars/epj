import { el, type XmlNode } from '../../util/xml';
import { SYSTEM } from '../../fhir/kodeverk';
import { byggHodemelding, egenPart, MELDINGSTYPER, type Part, type PasientPart } from './hodemelding';

/**
 * Fagmeldingene et fastlegekontor sender og mottar:
 * dialogmelding, henvisning, epikrise og laboratorierekvisisjon.
 */

export const NS = {
	DIALOG: 'http://www.kith.no/xmlstds/dialog/2013-01-23',
	HENVISNING: 'http://www.kith.no/xmlstds/henvisning/2012-02-15',
	EPIKRISE: 'http://www.kith.no/xmlstds/epikrise/2012-02-15',
	BASE: 'http://www.kith.no/xmlstds'
} as const;

// ---------------------------------------------------------------------------
// Dialogmelding
// ---------------------------------------------------------------------------

export type DialogType = 'notat' | 'foresporsel' | 'svar' | 'henvendelse';

export interface DialogmeldingInn {
	msgId: string;
	type: DialogType;
	temaKode?: string;
	temaBeskrivelse?: string;
	innhold: string;
	mottaker: Part;
	pasient: PasientPart;
	behandler: { navn: string; hpr: string };
	refMsgId?: string;
}

/** Kodeverk 8127 - temakoder for helsefaglig dialog. */
export const DIALOG_TEMA = {
	FORESPORSEL_HELSEOPPLYSNINGER: { kode: '1', tekst: 'Forespørsel om pasient' },
	SVAR_HELSEOPPLYSNINGER: { kode: '2', tekst: 'Svar på forespørsel om pasient' },
	AVVIK: { kode: '3', tekst: 'Avviksmelding' },
	NOTAT: { kode: '4', tekst: 'Helsefaglig notat' },
	MEDISINSK_VURDERING: { kode: '5', tekst: 'Medisinsk vurdering' }
} as const;

export function byggDialogmelding(inn: DialogmeldingInn): string {
	const typeKode =
		inn.type === 'notat' ? MELDINGSTYPER.DIALOG_NOTAT
		: inn.type === 'foresporsel' ? MELDINGSTYPER.DIALOG_FORESPORSEL
		: inn.type === 'svar' ? MELDINGSTYPER.DIALOG_SVAR
		: MELDINGSTYPER.DIALOG_HELSEFAGLIG;

	const fagmelding: XmlNode = el(
		'Dialogmelding',
		[
			el(inn.type === 'foresporsel' || inn.type === 'svar' ? 'Foresporsel' : 'Notat', [
				el('TemaKodet', null, {
					V: inn.temaKode ?? DIALOG_TEMA.NOTAT.kode,
					S: '2.16.578.1.12.4.1.1.8127',
					DN: inn.temaBeskrivelse ?? DIALOG_TEMA.NOTAT.tekst
				}),
				el('TekstNotatInnhold', inn.innhold),
				el('DokIdNotat', inn.msgId)
			])
		],
		{ xmlns: NS.DIALOG }
	);

	return byggHodemelding({
		msgId: inn.msgId,
		type: typeKode,
		avsender: egenPart(inn.behandler),
		mottaker: inn.mottaker,
		pasient: inn.pasient,
		fagmelding,
		fagmeldingBeskrivelse: typeKode.navn,
		refMsgId: inn.refMsgId,
		krevKvittering: true
	});
}

// ---------------------------------------------------------------------------
// Henvisning
// ---------------------------------------------------------------------------

export interface HenvisningInn {
	msgId: string;
	mottaker: Part;
	pasient: PasientPart;
	behandler: { navn: string; hpr: string };
	/** ICPC-2 eller ICD-10. */
	diagnose?: { kode: string; tekst: string; system?: string };
	problemstilling: string;
	anamnese?: string;
	funn?: string;
	tidligereBehandling?: string;
	medisiner?: string;
	onsketUndersokelse?: string;
	hastegrad: 'ordinaer' | 'haster' | 'akutt';
	pasientenInformert?: boolean;
	vedlegg?: { tittel: string; type: string }[];
}

const HASTEGRAD_KODE: Record<HenvisningInn['hastegrad'], { V: string; DN: string }> = {
	ordinaer: { V: '3', DN: 'Ordinær' },
	haster: { V: '2', DN: 'Haster' },
	akutt: { V: '1', DN: 'Akutt' }
};

export function byggHenvisning(inn: HenvisningInn): string {
	const fagmelding: XmlNode = el(
		'Henvisning',
		[
			el('TypeHenvendelse', null, { V: 'H', DN: 'Henvisning', S: '2.16.578.1.12.4.1.1.8121' }),
			el('Hastegrad', null, { ...HASTEGRAD_KODE[inn.hastegrad], S: '2.16.578.1.12.4.1.1.8125' }),
			el('DatoHenvisning', new Date().toISOString().slice(0, 10)),
			inn.diagnose
				? el('Diagnose', [
						el('DiagnoseKode', null, {
							V: inn.diagnose.kode,
							S: inn.diagnose.system ?? SYSTEM.ICPC2,
							DN: inn.diagnose.tekst
						})
					])
				: null,
			el('Problemstilling', [
				el('Overskrift', 'Problemstilling'),
				el('Tekst', inn.problemstilling)
			]),
			inn.anamnese ? el('Anamnese', [el('Overskrift', 'Anamnese'), el('Tekst', inn.anamnese)]) : null,
			inn.funn ? el('Funn', [el('Overskrift', 'Aktuelle funn'), el('Tekst', inn.funn)]) : null,
			inn.tidligereBehandling
				? el('TidligereBehandling', [el('Overskrift', 'Tidligere behandling'), el('Tekst', inn.tidligereBehandling)])
				: null,
			inn.medisiner ? el('Medisiner', [el('Overskrift', 'Legemidler i bruk'), el('Tekst', inn.medisiner)]) : null,
			inn.onsketUndersokelse
				? el('OnsketUndersokelse', [el('Overskrift', 'Ønsket undersøkelse'), el('Tekst', inn.onsketUndersokelse)])
				: null,
			el('PasientInformert', null, { V: inn.pasientenInformert === false ? 'N' : 'J' }),
			...(inn.vedlegg ?? []).map((v) => el('Vedlegg', [el('Tittel', v.tittel), el('Type', v.type)]))
		],
		{ xmlns: NS.HENVISNING }
	);

	return byggHodemelding({
		msgId: inn.msgId,
		type: MELDINGSTYPER.HENVIS,
		avsender: egenPart(inn.behandler),
		mottaker: inn.mottaker,
		pasient: inn.pasient,
		fagmelding,
		fagmeldingBeskrivelse: 'Henvisning',
		krevKvittering: true
	});
}

// ---------------------------------------------------------------------------
// Epikrise
// ---------------------------------------------------------------------------

export interface EpikriseInn {
	msgId: string;
	mottaker: Part;
	pasient: PasientPart;
	behandler: { navn: string; hpr: string };
	kontaktFra: string;
	kontaktTil?: string;
	diagnoser: { kode: string; tekst: string; system?: string; hoveddiagnose?: boolean }[];
	sammendrag: string;
	behandling?: string;
	legemidlerVedUtskrivning?: string;
	oppfolging?: string;
	vurdering?: string;
}

export function byggEpikrise(inn: EpikriseInn): string {
	const fagmelding: XmlNode = el(
		'Epikrise',
		[
			el('Kontakt', [
				el('KontaktFra', inn.kontaktFra),
				inn.kontaktTil ? el('KontaktTil', inn.kontaktTil) : null
			]),
			...inn.diagnoser.map((d) =>
				el('Diagnose', [
					el('DiagnoseKode', null, { V: d.kode, S: d.system ?? SYSTEM.ICD10, DN: d.tekst }),
					el('Hoveddiagnose', null, { V: d.hoveddiagnose ? 'J' : 'N' })
				])
			),
			el('Sammendrag', [el('Overskrift', 'Sammendrag'), el('Tekst', inn.sammendrag)]),
			inn.behandling ? el('Behandling', [el('Overskrift', 'Behandling'), el('Tekst', inn.behandling)]) : null,
			inn.vurdering ? el('Vurdering', [el('Overskrift', 'Vurdering'), el('Tekst', inn.vurdering)]) : null,
			inn.legemidlerVedUtskrivning
				? el('Legemidler', [el('Overskrift', 'Legemidler ved utskrivning'), el('Tekst', inn.legemidlerVedUtskrivning)])
				: null,
			inn.oppfolging ? el('Oppfolging', [el('Overskrift', 'Videre oppfølging'), el('Tekst', inn.oppfolging)]) : null
		],
		{ xmlns: NS.EPIKRISE }
	);

	return byggHodemelding({
		msgId: inn.msgId,
		type: MELDINGSTYPER.EPIKRISE,
		avsender: egenPart(inn.behandler),
		mottaker: inn.mottaker,
		pasient: inn.pasient,
		fagmelding,
		fagmeldingBeskrivelse: 'Epikrise',
		krevKvittering: true
	});
}

// ---------------------------------------------------------------------------
// Laboratorierekvisisjon
// ---------------------------------------------------------------------------

export interface RekvisisjonInn {
	msgId: string;
	mottaker: Part;
	pasient: PasientPart;
	behandler: { navn: string; hpr: string };
	analyser: { kode: string; navn: string; system?: string }[];
	kliniskeOpplysninger?: string;
	prøvetakingstidspunkt?: string;
	hastegrad?: 'ordinaer' | 'haster';
}

export function byggRekvisisjon(inn: RekvisisjonInn): string {
	const fagmelding: XmlNode = el(
		'MedicalRequest',
		[
			el('RequestDate', new Date().toISOString()),
			el('Priority', null, { V: inn.hastegrad === 'haster' ? '2' : '3', DN: inn.hastegrad === 'haster' ? 'Haster' : 'Ordinær' }),
			inn.prøvetakingstidspunkt ? el('SpecimenCollected', inn.prøvetakingstidspunkt) : null,
			inn.kliniskeOpplysninger ? el('ClinicalInfo', inn.kliniskeOpplysninger) : null,
			...inn.analyser.map((a) =>
				el('RequestedService', [el('ServiceCode', null, { V: a.kode, S: a.system ?? SYSTEM.LOINC, DN: a.navn })])
			)
		],
		{ xmlns: NS.BASE }
	);

	return byggHodemelding({
		msgId: inn.msgId,
		type: MELDINGSTYPER.MEDLAB,
		avsender: egenPart(inn.behandler),
		mottaker: inn.mottaker,
		pasient: inn.pasient,
		fagmelding,
		fagmeldingBeskrivelse: 'Laboratorierekvisisjon',
		krevKvittering: true
	});
}
