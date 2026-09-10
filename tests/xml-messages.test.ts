import { describe, expect, it } from 'vitest';
import { document, el, find, parseXml, serialiser, textValue } from '../src/lib/server/util/xml';
import { buildMsgHead, ownPart, MESSAGETYPES, type Part, type PatientPart } from '../src/lib/server/integrations/nhn/msg-head';
import { buildDialogueMessage, buildDischargeSummary, buildReferral, buildLabOrder, DIALOG_TEMA } from '../src/lib/server/integrations/nhn/messages';
import { APPREC_ERROR, buildApprec, readApprec, readMsgHead } from '../src/lib/server/integrations/nhn/apprec';

const recipient: Part = {
	name: 'Oslo universitetssykehus HF',
	identifier: [{ id: '8142519', type: 'HER' }, { id: '993467049', type: 'ENH' }]
};

const patient: PatientPart = {
	fnr: '13086510035',
	givenName: 'Anne',
	familyName: 'Bakken',
	birthDate: '1965-08-13',
	gender: 'K'
};

const practitioner = { name: 'Ingrid Fastlege', hpr: '9144889' };

describe('XML-byggeklosser', () => {
	it('escaper tegn som ellers ville brutt dokumentet', () => {
		const xml = serialiser(el('Tekst', 'A & B < C > D "E" \'F\''));
		expect(xml).toContain('A &amp; B &lt; C &gt; D &quot;E&quot; &apos;F&apos;');
	});

	it('lager tomt element uten innhold', () => {
		expect(serialiser(el('Tom', null))).toBe('<Tom/>');
	});

	it('skriver attributter og hopper over udefinerte', () => {
		expect(serialiser(el('K', null, { V: '1', S: undefined, DN: 'En' }))).toBe('<K V="1" DN="En"/>');
	});

	it('leser tilbake det den skrev', () => {
		const xml = document(el('Rot', [el('Barn', 'æøå & <verdi>', { attr: 'x' })]));
		const parsed = parseXml(xml);
		expect(parsed.name).toBe('Rot');
		expect(textValue(parsed, 'Barn')).toBe('æøå & <verdi>');
		expect(find(parsed, 'Barn')?.attributes.attr).toBe('x');
	});
});

describe('hodemelding (MsgHead)', () => {
	const xml = buildMsgHead({
		msgId: 'msg-1',
		type: MESSAGETYPES.DIALOG_HELSEFAGLIG,
		sender: ownPart(practitioner),
		recipient,
		patient,
		clinicalMessage: el('Dialogmelding', [el('Notat', 'Hei')]),
		clinicalMessageDescription: 'Helsefaglig dialog'
	});

	it('bruker riktig navnerom', () => {
		expect(xml).toContain('xmlns="http://www.kith.no/xmlstds/msghead/2006-05-24"');
	});

	it('inneholder meldingstype, id og kvitteringsønske', () => {
		const read = readMsgHead(xml);
		expect(read?.msgId).toBe('msg-1');
		expect(read?.type.code).toBe('DIALOG_HELSEFAGLIG');
		expect(read?.requireReceipt).toBe(true);
	});

	it('bærer pasientens fødselsnummer og navn', () => {
		const read = readMsgHead(xml);
		expect(read?.patientFnr).toBe('13086510035');
		expect(read?.patientName).toBe('Anne Bakken');
	});

	it('identifiserer avsender med HER-id og organisasjonsnummer', () => {
		const read = readMsgHead(xml);
		expect(read?.sender.her).toBe('8000001');
		expect(read?.sender.orgnr).toBeDefined();
	});

	it('merker D-nummer som DNR', () => {
		const withDnr = buildMsgHead({
			msgId: 'msg-2',
			type: MESSAGETYPES.DIALOG_NOTE,
			sender: ownPart(),
			recipient,
			patient: { ...patient, fnr: '53086510035' },
			clinicalMessage: el('X', 'y'),
			clinicalMessageDescription: 'x'
		});
		expect(withDnr).toContain('V="DNR"');
	});
});

describe('dialogmelding', () => {
	it('setter temakode fra kodeverk 8127', () => {
		const xml = buildDialogueMessage({
			msgId: 'd-1',
			type: 'foresporsel',
			temaCode: DIALOG_TEMA.REQUEST_HELSEOPPLYSNINGER.code,
			temaDescription: DIALOG_TEMA.REQUEST_HELSEOPPLYSNINGER.text,
			content: 'Kan dere sende siste notat?',
			recipient,
			patient,
			practitioner
		});
		expect(xml).toContain('S="2.16.578.1.12.4.1.1.8127"');
		expect(xml).toContain('Kan dere sende siste notat?');
		expect(readMsgHead(xml)?.type.code).toBe('DIALOG_FORESPORSEL');
	});

	it('refererer meldingen det svares på', () => {
		const xml = buildDialogueMessage({
			msgId: 'd-2', type: 'svar', content: 'Vedlagt.', recipient, patient, practitioner, refMsgId: 'd-1'
		});
		expect(xml).toContain('<RefToParent>d-1</RefToParent>');
	});
});

describe('henvisning', () => {
	const xml = buildReferral({
		msgId: 'h-1',
		recipient,
		patient,
		practitioner,
		diagnosis: { code: 'K86', text: 'Hypertensjon' },
		problem: 'Vedvarende høyt blodtrykk tross tre legemidler.',
		anamnese: 'Kjent hypertensjon siden 2018.',
		requestedExamination: 'Utredning for sekundær hypertensjon',
		hastegrad: 'haster',
		pasientenInformed: true
	});

	it('setter hastegrad', () => {
		expect(xml).toContain('V="2" DN="Haster"');
	});

	it('bruker ICPC-2 som standard kodeverk for diagnosen', () => {
		expect(xml).toContain('S="urn:oid:2.16.578.1.12.4.1.1.7170"');
	});

	it('dokumenterer at pasienten er informert', () => {
		expect(xml).toContain('<PasientInformert V="J"/>');
	});

	it('er en gyldig hodemelding av typen HENVIS', () => {
		expect(readMsgHead(xml)?.type.code).toBe('HENVIS');
	});
});

describe('epikrise og rekvisisjon', () => {
	it('markerer hoveddiagnose', () => {
		const xml = buildDischargeSummary({
			msgId: 'e-1', recipient, patient, practitioner,
			encounterFrom: '2026-01-10',
			diagnoses: [{ code: 'I10', text: 'Essensiell hypertensjon', hoveddiagnose: true }],
			sammendrag: 'Innlagt til utredning.'
		});
		expect(xml).toContain('<Hoveddiagnose V="J"/>');
		expect(xml).toContain('S="urn:oid:2.16.578.1.12.4.1.1.7110"');
	});

	it('lister analysene i en rekvisisjon', () => {
		const xml = buildLabOrder({
			msgId: 'r-1', recipient, patient, practitioner,
			analyser: [
				{ code: '4548-4', name: 'HbA1c' },
				{ code: '2160-0', name: 'Kreatinin' }
			],
			clinicalOpplysninger: 'Diabeteskontroll'
		});
		expect(xml).toContain('V="4548-4"');
		expect(xml).toContain('V="2160-0"');
		expect(readMsgHead(xml)?.type.code).toBe('MEDLAB');
	});
});

describe('applikasjonskvittering', () => {
	it('bygger og leser en positiv kvittering', () => {
		const xml = buildApprec({
			refMsgId: 'msg-1',
			refGenDate: '2026-01-01T10:00:00Z',
			refType: MESSAGETYPES.HENVIS,
			status: '1',
			originalSender: { name: 'Fastlegen', her: '8142519' }
		});
		const read = readApprec(xml);
		expect(read).toMatchObject({ status: '1', refMsgId: 'msg-1' });
		expect(read?.error).toHaveLength(0);
	});

	it('bærer feilkoder ved avvisning', () => {
		const xml = buildApprec({
			refMsgId: 'msg-2',
			refGenDate: '2026-01-01T10:00:00Z',
			refType: MESSAGETYPES.HENVIS,
			status: '3',
			error: [APPREC_ERROR.UNKNOWN_PATIENT, APPREC_ERROR.MISSING_FNR],
			originalSender: { name: 'Fastlegen', her: '8142519' }
		});
		const read = readApprec(xml);
		expect(read?.status).toBe('3');
		expect(read?.error.map((f) => f.code)).toEqual(['E30', 'E31']);
	});

	it('gir null for noe som ikke er en kvittering', () => {
		expect(readApprec('<Noe/>')).toBeNull();
		expect(readApprec('ikke xml i det hele tatt')).toBeNull();
	});

	it('gir null når hodemeldingen ikke lar seg lese', () => {
		expect(readMsgHead('<AppRec/>')).toBeNull();
	});
});
