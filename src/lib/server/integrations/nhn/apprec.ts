import { document, el, find, lokaltName, parseXml, textValue, type ParsedNode } from '../../util/xml';
import { newId } from '../../util/ids';
import { config } from '../../config';

/**
 * Application receipt (AppRec).
 *
 * Once a health message has been received and read into the record system, the
 * recipient must send an AppRec back. The status tells the sender whether the
 * message was accepted (1), accepted with a remark (2), or rejected (3).
 * Without an AppRec the sender does not know the referral actually arrived.
 */

export const APPREC_NS = 'http://www.kith.no/xmlstds/apprec/2004-11-21';

export type ApprecStatus = '1' | '2' | '3';

export const APPREC_STATUS_TEXT: Record<ApprecStatus, string> = {
	'1': 'OK',
	'2': 'OK, med merknad',
	'3': 'Avvist'
};

/** Kodeverk 8221 - feilmeldinger i applikasjonskvittering. */
export const APPREC_ERROR = {
	UNKNOWN_RECIPIENT: { code: 'E21', text: 'Ukjent mottaker' },
	UNKNOWN_PATIENT: { code: 'E30', text: 'Pasienten er ukjent for mottaker' },
	MISSING_FNR: { code: 'E31', text: 'Fødselsnummer mangler eller er ugyldig' },
	ERROR_MESSAGETYPE: { code: 'E10', text: 'Meldingstypen kan ikke behandles' },
	XML_ERROR: { code: 'E11', text: 'Meldingen validerer ikke mot XSD' },
	DUPLIKAT: { code: 'S02', text: 'Meldingen er mottatt tidligere' }
} as const;

export interface ApprecIn {
	/** MsgId of the message being acknowledged. */
	refMsgId: string;
	refGenDate: string;
	refType: { code: string; name: string };
	status: ApprecStatus;
	error?: { code: string; text: string; details?: string }[];
	/** Sender of the original message - becomes recipient of the receipt. */
	originalSender: { name: string; her: string; orgnr?: string };
	patientFnr?: string;
}

export function buildApprec(inValue: ApprecIn): string {
	const root = el(
		'AppRec',
		[
			el('MsgType', null, { V: 'APPREC', DN: 'Applikasjonskvittering' }),
			el('MIGversion', 'v1.0 2004-11-21'),
			el('GenDate', new Date().toISOString()),
			el('Id', newId()),
			el('Sender', [
				el('HCP', [
					el('Inst', [
						el('Name', config.organisation.name),
						el('Id', config.organisation.herId),
						el('TypeId', null, { V: 'HER', S: '2.16.578.1.12.4.1.1.9051', DN: 'HER-id' })
					])
				])
			]),
			el('Receiver', [
				el('HCP', [
					el('Inst', [
						el('Name', inValue.originalSender.name),
						el('Id', inValue.originalSender.her),
						el('TypeId', null, { V: 'HER', S: '2.16.578.1.12.4.1.1.9051', DN: 'HER-id' })
					])
				])
			]),
			el('Status', null, { V: inValue.status, S: '2.16.578.1.12.4.1.1.8222', DN: APPREC_STATUS_TEXT[inValue.status] }),
			...(inValue.error ?? []).map((f) =>
				el('Error', [el('Description', f.details ?? f.text)], { V: f.code, S: '2.16.578.1.12.4.1.1.8221', DN: f.text })
			),
			el('OriginalMsgId', [
				el('MsgType', null, { V: inValue.refType.code, DN: inValue.refType.name }),
				el('Id', inValue.refMsgId),
				el('GenDate', inValue.refGenDate)
			])
		],
		{ xmlns: APPREC_NS }
	);
	return document(root);
}

export interface ReadApprec {
	status: ApprecStatus;
	refMsgId: string;
	error: { code: string; text: string }[];
}

export function readApprec(xml: string): ReadApprec | null {
	try {
		const root = parseXml(xml);
		if (lokaltName(root.name) !== 'AppRec') return null;
		const status = (find(root, 'Status')?.attributes.V ?? '3') as ApprecStatus;
		const refMsgId = textValue(root, 'OriginalMsgId/Id') ?? '';
		const error = root.children
			.filter((b) => lokaltName(b.name) === 'Error')
			.map((b) => ({ code: b.attributes.V ?? '', text: b.attributes.DN ?? b.text }));
		return { status, refMsgId, error };
	} catch {
		return null;
	}
}

/** Reads the key fields from an incoming MsgHead. */
export interface ReadMsgHead {
	msgId: string;
	genDate: string;
	type: { code: string; name: string };
	requireReceipt: boolean;
	sender: { name: string; her: string; orgnr?: string };
	patientFnr?: string;
	patientName?: string;
	clinicalMessage?: ParsedNode;
}

export function readMsgHead(xml: string): ReadMsgHead | null {
	try {
		const root = parseXml(xml);
		if (lokaltName(root.name) !== 'MsgHead') return null;
		const info = find(root, 'MsgInfo');
		if (!info) return null;
		const typeNode = find(info, 'Type');
		const senderOrg = find(info, 'Sender/Organisation');
		const idents = (senderOrg?.children ?? []).filter((b) => lokaltName(b.name) === 'Ident');
		const findIdent = (type: string) =>
			idents.find((i) => find(i, 'TypeId')?.attributes.V === type)?.children.find((b) => lokaltName(b.name) === 'Id')?.text;

		const patient = find(info, 'Patient');
		const patientIdents = (patient?.children ?? []).filter((b) => lokaltName(b.name) === 'Ident');
		const fnr = patientIdents
			.map((i) => i.children.find((b) => lokaltName(b.name) === 'Id')?.text)
			.find((v) => v && /^\d{11}$/.test(v));

		return {
			msgId: textValue(info, 'MsgId') ?? '',
			genDate: textValue(info, 'GenDate') ?? new Date().toISOString(),
			type: { code: typeNode?.attributes.V ?? 'UKJENT', name: typeNode?.attributes.DN ?? 'Ukjent' },
			requireReceipt: find(info, 'Ack')?.attributes.V !== 'N',
			sender: {
				name: textValue(senderOrg ?? root, 'OrganisationName') ?? 'Ukjent avsender',
				her: findIdent('HER') ?? '',
				orgnr: findIdent('ENH')
			},
			patientFnr: fnr,
			patientName: patient
				? [textValue(patient, 'GivenName'), textValue(patient, 'FamilyName')].filter(Boolean).join(' ')
				: undefined,
			clinicalMessage: find(root, 'Document/RefDoc/Content')?.children[0]
		};
	} catch {
		return null;
	}
}
