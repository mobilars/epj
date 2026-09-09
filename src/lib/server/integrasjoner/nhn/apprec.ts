import { dokument, el, finn, lokaltNavn, parseXml, tekstVerdi, type ParsedNode } from '../../util/xml';
import { nyId } from '../../util/ids';
import { config } from '../../config';

/**
 * Applikasjonskvittering (AppRec).
 *
 * Etter at en helsemelding er mottatt og lest inn i journalsystemet, skal
 * mottakeren sende en AppRec tilbake. Statusen forteller avsender om meldingen
 * ble tatt imot (1), tatt imot med merknad (2), eller avvist (3). Uten AppRec
 * vet ikke avsender om henvisningen faktisk kom fram.
 */

export const APPREC_NS = 'http://www.kith.no/xmlstds/apprec/2004-11-21';

export type ApprecStatus = '1' | '2' | '3';

export const APPREC_STATUS_TEKST: Record<ApprecStatus, string> = {
	'1': 'OK',
	'2': 'OK, med merknad',
	'3': 'Avvist'
};

/** Kodeverk 8221 - feilmeldinger i applikasjonskvittering. */
export const APPREC_FEIL = {
	UKJENT_MOTTAKER: { kode: 'E21', tekst: 'Ukjent mottaker' },
	UKJENT_PASIENT: { kode: 'E30', tekst: 'Pasienten er ukjent for mottaker' },
	MANGLER_FNR: { kode: 'E31', tekst: 'Fødselsnummer mangler eller er ugyldig' },
	FEIL_MELDINGSTYPE: { kode: 'E10', tekst: 'Meldingstypen kan ikke behandles' },
	XML_FEIL: { kode: 'E11', tekst: 'Meldingen validerer ikke mot XSD' },
	DUPLIKAT: { kode: 'S02', tekst: 'Meldingen er mottatt tidligere' }
} as const;

export interface ApprecInn {
	/** MsgId på meldingen det kvitteres for. */
	refMsgId: string;
	refGenDate: string;
	refType: { kode: string; navn: string };
	status: ApprecStatus;
	feil?: { kode: string; tekst: string; detaljer?: string }[];
	/** Avsender av originalmeldingen - blir mottaker av kvitteringen. */
	originalAvsender: { navn: string; her: string; orgnr?: string };
	pasientFnr?: string;
}

export function byggApprec(inn: ApprecInn): string {
	const rot = el(
		'AppRec',
		[
			el('MsgType', null, { V: 'APPREC', DN: 'Applikasjonskvittering' }),
			el('MIGversion', 'v1.0 2004-11-21'),
			el('GenDate', new Date().toISOString()),
			el('Id', nyId()),
			el('Sender', [
				el('HCP', [
					el('Inst', [
						el('Name', config.organisasjon.navn),
						el('Id', config.organisasjon.herId),
						el('TypeId', null, { V: 'HER', S: '2.16.578.1.12.4.1.1.9051', DN: 'HER-id' })
					])
				])
			]),
			el('Receiver', [
				el('HCP', [
					el('Inst', [
						el('Name', inn.originalAvsender.navn),
						el('Id', inn.originalAvsender.her),
						el('TypeId', null, { V: 'HER', S: '2.16.578.1.12.4.1.1.9051', DN: 'HER-id' })
					])
				])
			]),
			el('Status', null, { V: inn.status, S: '2.16.578.1.12.4.1.1.8222', DN: APPREC_STATUS_TEKST[inn.status] }),
			...(inn.feil ?? []).map((f) =>
				el('Error', [el('Description', f.detaljer ?? f.tekst)], { V: f.kode, S: '2.16.578.1.12.4.1.1.8221', DN: f.tekst })
			),
			el('OriginalMsgId', [
				el('MsgType', null, { V: inn.refType.kode, DN: inn.refType.navn }),
				el('Id', inn.refMsgId),
				el('GenDate', inn.refGenDate)
			])
		],
		{ xmlns: APPREC_NS }
	);
	return dokument(rot);
}

export interface LestApprec {
	status: ApprecStatus;
	refMsgId: string;
	feil: { kode: string; tekst: string }[];
}

export function lesApprec(xml: string): LestApprec | null {
	try {
		const rot = parseXml(xml);
		if (lokaltNavn(rot.navn) !== 'AppRec') return null;
		const status = (finn(rot, 'Status')?.attributter.V ?? '3') as ApprecStatus;
		const refMsgId = tekstVerdi(rot, 'OriginalMsgId/Id') ?? '';
		const feil = rot.barn
			.filter((b) => lokaltNavn(b.navn) === 'Error')
			.map((b) => ({ kode: b.attributter.V ?? '', tekst: b.attributter.DN ?? b.tekst }));
		return { status, refMsgId, feil };
	} catch {
		return null;
	}
}

/** Leser nøkkelfeltene fra en innkommende hodemelding. */
export interface LestHodemelding {
	msgId: string;
	genDate: string;
	type: { kode: string; navn: string };
	krevKvittering: boolean;
	avsender: { navn: string; her: string; orgnr?: string };
	pasientFnr?: string;
	pasientNavn?: string;
	fagmelding?: ParsedNode;
}

export function lesHodemelding(xml: string): LestHodemelding | null {
	try {
		const rot = parseXml(xml);
		if (lokaltNavn(rot.navn) !== 'MsgHead') return null;
		const info = finn(rot, 'MsgInfo');
		if (!info) return null;
		const typeNode = finn(info, 'Type');
		const avsenderOrg = finn(info, 'Sender/Organisation');
		const idents = (avsenderOrg?.barn ?? []).filter((b) => lokaltNavn(b.navn) === 'Ident');
		const finnIdent = (type: string) =>
			idents.find((i) => finn(i, 'TypeId')?.attributter.V === type)?.barn.find((b) => lokaltNavn(b.navn) === 'Id')?.tekst;

		const pasient = finn(info, 'Patient');
		const pasientIdents = (pasient?.barn ?? []).filter((b) => lokaltNavn(b.navn) === 'Ident');
		const fnr = pasientIdents
			.map((i) => i.barn.find((b) => lokaltNavn(b.navn) === 'Id')?.tekst)
			.find((v) => v && /^\d{11}$/.test(v));

		return {
			msgId: tekstVerdi(info, 'MsgId') ?? '',
			genDate: tekstVerdi(info, 'GenDate') ?? new Date().toISOString(),
			type: { kode: typeNode?.attributter.V ?? 'UKJENT', navn: typeNode?.attributter.DN ?? 'Ukjent' },
			krevKvittering: finn(info, 'Ack')?.attributter.V !== 'N',
			avsender: {
				navn: tekstVerdi(avsenderOrg ?? rot, 'OrganisationName') ?? 'Ukjent avsender',
				her: finnIdent('HER') ?? '',
				orgnr: finnIdent('ENH')
			},
			pasientFnr: fnr,
			pasientNavn: pasient
				? [tekstVerdi(pasient, 'GivenName'), tekstVerdi(pasient, 'FamilyName')].filter(Boolean).join(' ')
				: undefined,
			fagmelding: finn(rot, 'Document/RefDoc/Content')?.barn[0]
		};
	} catch {
		return null;
	}
}
