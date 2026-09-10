import { document, el, type XmlNode } from '../../util/xml';
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
const CODESYSTEM_IDENT = '2.16.578.1.12.4.1.1.9051';

export type IdentType = 'ENH' | 'HER' | 'HPR' | 'FNR' | 'DNR' | 'RSH';

const IDENT_NAME: Record<IdentType, string> = {
	ENH: 'Organisasjonsnummeret i Enhetsregisteret',
	HER: 'Identifikator fra Helsetjenesteenhetsregisteret',
	HPR: 'HPR-nummer',
	FNR: 'Fødselsnummer',
	DNR: 'D-nummer',
	RSH: 'Identifikator fra Register for enheter i spesialisthelsetjenesten'
};

export interface Part {
	name: string;
	identifier: { id: string; type: IdentType }[];
	/** Underliggende avdeling eller helsepersonell. */
	underPart?: Part;
	role?: string;
	address?: { line?: string; postalCode?: string; poststed?: string; land?: string };
	phone?: string;
	email?: string;
}

export interface PatientPart {
	fnr: string;
	givenName: string;
	familyName: string;
	birthDate?: string;
	gender?: 'M' | 'K';
	address?: { line?: string; postalCode?: string; poststed?: string };
	phone?: string;
}

export interface MessageType {
	code: string;
	name: string;
}

export const MESSAGETYPES = {
	DIALOG_HELSEFAGLIG: { code: 'DIALOG_HELSEFAGLIG', name: 'Helsefaglig dialog' },
	DIALOG_REQUEST: { code: 'DIALOG_FORESPORSEL', name: 'Forespørsel' },
	DIALOG_NOTE: { code: 'DIALOG_NOTAT', name: 'Notat' },
	DIALOG_RESPONSE: { code: 'DIALOG_SVAR', name: 'Svar på forespørsel' },
	HENVIS: { code: 'HENVIS', name: 'Henvisning' },
	DISCHARGESUMMARY: { code: 'EPIKRISE', name: 'Epikrise' },
	MEDLAB: { code: 'MEDLAB', name: 'Medisinsk laboratorierekvisisjon' },
	RESPONSE_LAB: { code: 'SVAR_LAB', name: 'Laboratoriesvar' },
	APPREC: { code: 'APPREC', name: 'Applikasjonskvittering' }
} as const satisfies Record<string, MessageType>;

function identNode(id: string, type: IdentType): XmlNode {
	return el('Ident', [
		el('Id', id),
		el('TypeId', null, { V: type, S: CODESYSTEM_IDENT, DN: IDENT_NAME[type] })
	]);
}

function partNode(name: string, part: Part): XmlNode {
	return el(name, [
		el('Organisation', [
			el('OrganisationName', part.name),
			...part.identifier.map((i) => identNode(i.id, i.type)),
			part.address
				? el('Address', [
						el('Type', null, { V: 'PST', DN: 'Postadresse' }),
						el('StreetAdr', part.address.line),
						el('PostalCode', part.address.postalCode),
						el('City', part.address.poststed),
						el('Country', part.address.land ?? 'Norge')
					])
				: null,
			part.phone ? el('TeleCom', [el('TeleAddress', null, { V: `tel:${part.phone}` })]) : null,
			part.email ? el('TeleCom', [el('TeleAddress', null, { V: `mailto:${part.email}` })]) : null,
			part.underPart ? underPartNode(part.underPart) : null
		])
	]);
}

function underPartNode(part: Part): XmlNode {
	// HealthcareProfessional brukes for navngitt helsepersonell, ellers Organisation.
	const isPerson = part.identifier.some((i) => i.type === 'HPR' || i.type === 'FNR');
	if (isPerson) {
		const [givenName, ...resten] = part.name.split(' ');
		return el('HealthcareProfessional', [
			el('TypeHealthcareProfessional', null, { V: 'LE', DN: 'Lege', S: '2.16.578.1.12.4.1.1.9034' }),
			el('RoleToPatient', null, { V: part.role ?? '6', DN: 'Fastlege', S: '2.16.578.1.12.4.1.1.9034' }),
			el('FamilyName', resten.join(' ') || givenName),
			el('GivenName', givenName),
			...part.identifier.map((i) => identNode(i.id, i.type))
		]);
	}
	return el('Organisation', [
		el('OrganisationName', part.name),
		...part.identifier.map((i) => identNode(i.id, i.type))
	]);
}

function patientNode(p: PatientPart): XmlNode {
	return el('Patient', [
		el('FamilyName', p.familyName),
		el('GivenName', p.givenName),
		el('DateOfBirth', p.birthDate),
		p.gender ? el('Sex', null, { V: p.gender, S: '2.16.578.1.12.4.1.1.9130', DN: p.gender === 'M' ? 'Mann' : 'Kvinne' }) : null,
		identNode(p.fnr, p.fnr.length === 11 && Number(p.fnr.slice(0, 2)) > 40 ? 'DNR' : 'FNR'),
		p.address
			? el('Address', [
					el('Type', null, { V: 'H', DN: 'Bostedsadresse' }),
					el('StreetAdr', p.address.line),
					el('PostalCode', p.address.postalCode),
					el('City', p.address.poststed)
				])
			: null,
		p.phone ? el('TeleCom', [el('TeleAddress', null, { V: `tel:${p.phone}` })]) : null
	]);
}

export interface MsgHeadIn {
	msgId: string;
	type: MessageType;
	genDate?: string;
	/** Ber om applikasjonskvittering fra mottaker. */
	requireReceipt?: boolean;
	sender: Part;
	recipient: Part;
	patient?: PatientPart;
	/** Fagmeldingen som legges i RefDoc/Content. */
	clinicalMessage: XmlNode;
	clinicalMessageDescription: string;
	/** Referanse til melding det svares på. */
	refMsgId?: string;
}

export function buildMsgHead(inValue: MsgHeadIn): string {
	const root = el(
		'MsgHead',
		[
			el('MsgInfo', [
				el('Type', null, { V: inValue.type.code, DN: inValue.type.name }),
				el('MIGversion', 'v1.2 2006-05-24'),
				el('GenDate', inValue.genDate ?? new Date().toISOString()),
				el('MsgId', inValue.msgId),
				inValue.refMsgId ? el('ConversationRef', [el('RefToConversation', inValue.refMsgId), el('RefToParent', inValue.refMsgId)]) : null,
				el('Ack', null, { V: inValue.requireReceipt === false ? 'N' : 'J', DN: inValue.requireReceipt === false ? 'Nei' : 'Ja' }),
				partNode('Sender', inValue.sender),
				partNode('Receiver', inValue.recipient),
				inValue.patient ? patientNode(inValue.patient) : null
			]),
			el('Document', [
				el('DocumentConnection', null, { V: 'H', DN: 'Hoveddokument' }),
				el('RefDoc', [
					el('MsgType', null, { V: 'XML', DN: 'XML-instans' }),
					el('MimeType', 'text/xml'),
					el('Description', inValue.clinicalMessageDescription),
					el('Content', [inValue.clinicalMessage])
				])
			])
		],
		{ xmlns: MSGHEAD_NS }
	);
	return document(root);
}

/** Standard avsenderpart for denne virksomheten. */
export function ownPart(practitioner?: { name: string; hpr: string }): Part {
	return {
		name: config.organisation.name,
		identifier: [
			{ id: config.organisation.organisation_number, type: 'ENH' },
			{ id: config.organisation.herId, type: 'HER' }
		],
		...(practitioner ? { underPart: { name: practitioner.name, identifier: [{ id: practitioner.hpr, type: 'HPR' }] } } : {})
	};
}
