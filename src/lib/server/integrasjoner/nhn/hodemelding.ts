import { dokument, el, type XmlNode } from '../../util/xml';
import { config } from '../../config';

/**
 * Hodemelding (MsgHead) etter KITH-standarden.
 *
 * Alle helsefaglige meldinger som sendes over Norsk helsenett pakkes i en
 * hodemelding: den identifiserer avsender, mottaker, pasient og meldingstype,
 * og bærer selve fagmeldingen som `RefDoc/Content`. Mottakeren kvitterer med en
 * applikasjonskvittering (AppRec) som refererer `MsgId`.
 */

export const MSGHEAD_NS = 'http://www.kith.no/xmlstds/msghead/2006-05-24';

/** Kodeverk 9051 - identifikatortyper for organisasjon og person. */
const KODEVERK_IDENT = '2.16.578.1.12.4.1.1.9051';

export type IdentType = 'ENH' | 'HER' | 'HPR' | 'FNR' | 'DNR' | 'RSH';

const IDENT_NAVN: Record<IdentType, string> = {
	ENH: 'Organisasjonsnummeret i Enhetsregisteret',
	HER: 'Identifikator fra Helsetjenesteenhetsregisteret',
	HPR: 'HPR-nummer',
	FNR: 'Fødselsnummer',
	DNR: 'D-nummer',
	RSH: 'Identifikator fra Register for enheter i spesialisthelsetjenesten'
};

export interface Part {
	navn: string;
	ident: { id: string; type: IdentType }[];
	/** Underliggende avdeling eller helsepersonell. */
	underPart?: Part;
	rolle?: string;
	adresse?: { linje?: string; postnummer?: string; poststed?: string; land?: string };
	telefon?: string;
	epost?: string;
}

export interface PasientPart {
	fnr: string;
	fornavn: string;
	etternavn: string;
	fodselsdato?: string;
	kjonn?: 'M' | 'K';
	adresse?: { linje?: string; postnummer?: string; poststed?: string };
	telefon?: string;
}

export interface Meldingstype {
	kode: string;
	navn: string;
}

export const MELDINGSTYPER = {
	DIALOG_HELSEFAGLIG: { kode: 'DIALOG_HELSEFAGLIG', navn: 'Helsefaglig dialog' },
	DIALOG_FORESPORSEL: { kode: 'DIALOG_FORESPORSEL', navn: 'Forespørsel' },
	DIALOG_NOTAT: { kode: 'DIALOG_NOTAT', navn: 'Notat' },
	DIALOG_SVAR: { kode: 'DIALOG_SVAR', navn: 'Svar på forespørsel' },
	HENVIS: { kode: 'HENVIS', navn: 'Henvisning' },
	EPIKRISE: { kode: 'EPIKRISE', navn: 'Epikrise' },
	MEDLAB: { kode: 'MEDLAB', navn: 'Medisinsk laboratorierekvisisjon' },
	SVAR_LAB: { kode: 'SVAR_LAB', navn: 'Laboratoriesvar' },
	APPREC: { kode: 'APPREC', navn: 'Applikasjonskvittering' }
} as const satisfies Record<string, Meldingstype>;

function identNode(id: string, type: IdentType): XmlNode {
	return el('Ident', [
		el('Id', id),
		el('TypeId', null, { V: type, S: KODEVERK_IDENT, DN: IDENT_NAVN[type] })
	]);
}

function partNode(navn: string, part: Part): XmlNode {
	return el(navn, [
		el('Organisation', [
			el('OrganisationName', part.navn),
			...part.ident.map((i) => identNode(i.id, i.type)),
			part.adresse
				? el('Address', [
						el('Type', null, { V: 'PST', DN: 'Postadresse' }),
						el('StreetAdr', part.adresse.linje),
						el('PostalCode', part.adresse.postnummer),
						el('City', part.adresse.poststed),
						el('Country', part.adresse.land ?? 'Norge')
					])
				: null,
			part.telefon ? el('TeleCom', [el('TeleAddress', null, { V: `tel:${part.telefon}` })]) : null,
			part.epost ? el('TeleCom', [el('TeleAddress', null, { V: `mailto:${part.epost}` })]) : null,
			part.underPart ? underPartNode(part.underPart) : null
		])
	]);
}

function underPartNode(part: Part): XmlNode {
	// HealthcareProfessional brukes for navngitt helsepersonell, ellers Organisation.
	const erPerson = part.ident.some((i) => i.type === 'HPR' || i.type === 'FNR');
	if (erPerson) {
		const [fornavn, ...resten] = part.navn.split(' ');
		return el('HealthcareProfessional', [
			el('TypeHealthcareProfessional', null, { V: 'LE', DN: 'Lege', S: '2.16.578.1.12.4.1.1.9034' }),
			el('RoleToPatient', null, { V: part.rolle ?? '6', DN: 'Fastlege', S: '2.16.578.1.12.4.1.1.9034' }),
			el('FamilyName', resten.join(' ') || fornavn),
			el('GivenName', fornavn),
			...part.ident.map((i) => identNode(i.id, i.type))
		]);
	}
	return el('Organisation', [
		el('OrganisationName', part.navn),
		...part.ident.map((i) => identNode(i.id, i.type))
	]);
}

function pasientNode(p: PasientPart): XmlNode {
	return el('Patient', [
		el('FamilyName', p.etternavn),
		el('GivenName', p.fornavn),
		el('DateOfBirth', p.fodselsdato),
		p.kjonn ? el('Sex', null, { V: p.kjonn, S: '2.16.578.1.12.4.1.1.9130', DN: p.kjonn === 'M' ? 'Mann' : 'Kvinne' }) : null,
		identNode(p.fnr, p.fnr.length === 11 && Number(p.fnr.slice(0, 2)) > 40 ? 'DNR' : 'FNR'),
		p.adresse
			? el('Address', [
					el('Type', null, { V: 'H', DN: 'Bostedsadresse' }),
					el('StreetAdr', p.adresse.linje),
					el('PostalCode', p.adresse.postnummer),
					el('City', p.adresse.poststed)
				])
			: null,
		p.telefon ? el('TeleCom', [el('TeleAddress', null, { V: `tel:${p.telefon}` })]) : null
	]);
}

export interface HodemeldingInn {
	msgId: string;
	type: Meldingstype;
	genDate?: string;
	/** Ber om applikasjonskvittering fra mottaker. */
	krevKvittering?: boolean;
	avsender: Part;
	mottaker: Part;
	pasient?: PasientPart;
	/** Fagmeldingen som legges i RefDoc/Content. */
	fagmelding: XmlNode;
	fagmeldingBeskrivelse: string;
	/** Referanse til melding det svares på. */
	refMsgId?: string;
}

export function byggHodemelding(inn: HodemeldingInn): string {
	const rot = el(
		'MsgHead',
		[
			el('MsgInfo', [
				el('Type', null, { V: inn.type.kode, DN: inn.type.navn }),
				el('MIGversion', 'v1.2 2006-05-24'),
				el('GenDate', inn.genDate ?? new Date().toISOString()),
				el('MsgId', inn.msgId),
				inn.refMsgId ? el('ConversationRef', [el('RefToConversation', inn.refMsgId), el('RefToParent', inn.refMsgId)]) : null,
				el('Ack', null, { V: inn.krevKvittering === false ? 'N' : 'J', DN: inn.krevKvittering === false ? 'Nei' : 'Ja' }),
				partNode('Sender', inn.avsender),
				partNode('Receiver', inn.mottaker),
				inn.pasient ? pasientNode(inn.pasient) : null
			]),
			el('Document', [
				el('DocumentConnection', null, { V: 'H', DN: 'Hoveddokument' }),
				el('RefDoc', [
					el('MsgType', null, { V: 'XML', DN: 'XML-instans' }),
					el('MimeType', 'text/xml'),
					el('Description', inn.fagmeldingBeskrivelse),
					el('Content', [inn.fagmelding])
				])
			])
		],
		{ xmlns: MSGHEAD_NS }
	);
	return dokument(rot);
}

/** Standard avsenderpart for denne virksomheten. */
export function egenPart(behandler?: { navn: string; hpr: string }): Part {
	return {
		navn: config.organisasjon.navn,
		ident: [
			{ id: config.organisasjon.organisasjonsnummer, type: 'ENH' },
			{ id: config.organisasjon.herId, type: 'HER' }
		],
		...(behandler ? { underPart: { navn: behandler.navn, ident: [{ id: behandler.hpr, type: 'HPR' }] } } : {})
	};
}
