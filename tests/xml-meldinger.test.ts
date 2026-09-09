import { describe, expect, it } from 'vitest';
import { dokument, el, finn, parseXml, serialiser, tekstVerdi } from '../src/lib/server/util/xml';
import { byggHodemelding, egenPart, MELDINGSTYPER, type Part, type PasientPart } from '../src/lib/server/integrasjoner/nhn/hodemelding';
import { byggDialogmelding, byggEpikrise, byggHenvisning, byggRekvisisjon, DIALOG_TEMA } from '../src/lib/server/integrasjoner/nhn/meldinger';
import { APPREC_FEIL, byggApprec, lesApprec, lesHodemelding } from '../src/lib/server/integrasjoner/nhn/apprec';

const mottaker: Part = {
	navn: 'Oslo universitetssykehus HF',
	ident: [{ id: '8142519', type: 'HER' }, { id: '993467049', type: 'ENH' }]
};

const pasient: PasientPart = {
	fnr: '13086510035',
	fornavn: 'Anne',
	etternavn: 'Bakken',
	fodselsdato: '1965-08-13',
	kjonn: 'K'
};

const behandler = { navn: 'Ingrid Fastlege', hpr: '9144889' };

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
		const xml = dokument(el('Rot', [el('Barn', 'æøå & <verdi>', { attr: 'x' })]));
		const parset = parseXml(xml);
		expect(parset.navn).toBe('Rot');
		expect(tekstVerdi(parset, 'Barn')).toBe('æøå & <verdi>');
		expect(finn(parset, 'Barn')?.attributter.attr).toBe('x');
	});
});

describe('hodemelding (MsgHead)', () => {
	const xml = byggHodemelding({
		msgId: 'msg-1',
		type: MELDINGSTYPER.DIALOG_HELSEFAGLIG,
		avsender: egenPart(behandler),
		mottaker,
		pasient,
		fagmelding: el('Dialogmelding', [el('Notat', 'Hei')]),
		fagmeldingBeskrivelse: 'Helsefaglig dialog'
	});

	it('bruker riktig navnerom', () => {
		expect(xml).toContain('xmlns="http://www.kith.no/xmlstds/msghead/2006-05-24"');
	});

	it('inneholder meldingstype, id og kvitteringsønske', () => {
		const lest = lesHodemelding(xml);
		expect(lest?.msgId).toBe('msg-1');
		expect(lest?.type.kode).toBe('DIALOG_HELSEFAGLIG');
		expect(lest?.krevKvittering).toBe(true);
	});

	it('bærer pasientens fødselsnummer og navn', () => {
		const lest = lesHodemelding(xml);
		expect(lest?.pasientFnr).toBe('13086510035');
		expect(lest?.pasientNavn).toBe('Anne Bakken');
	});

	it('identifiserer avsender med HER-id og organisasjonsnummer', () => {
		const lest = lesHodemelding(xml);
		expect(lest?.avsender.her).toBe('8000001');
		expect(lest?.avsender.orgnr).toBeDefined();
	});

	it('merker D-nummer som DNR', () => {
		const medDnr = byggHodemelding({
			msgId: 'msg-2',
			type: MELDINGSTYPER.DIALOG_NOTAT,
			avsender: egenPart(),
			mottaker,
			pasient: { ...pasient, fnr: '53086510035' },
			fagmelding: el('X', 'y'),
			fagmeldingBeskrivelse: 'x'
		});
		expect(medDnr).toContain('V="DNR"');
	});
});

describe('dialogmelding', () => {
	it('setter temakode fra kodeverk 8127', () => {
		const xml = byggDialogmelding({
			msgId: 'd-1',
			type: 'foresporsel',
			temaKode: DIALOG_TEMA.FORESPORSEL_HELSEOPPLYSNINGER.kode,
			temaBeskrivelse: DIALOG_TEMA.FORESPORSEL_HELSEOPPLYSNINGER.tekst,
			innhold: 'Kan dere sende siste notat?',
			mottaker,
			pasient,
			behandler
		});
		expect(xml).toContain('S="2.16.578.1.12.4.1.1.8127"');
		expect(xml).toContain('Kan dere sende siste notat?');
		expect(lesHodemelding(xml)?.type.kode).toBe('DIALOG_FORESPORSEL');
	});

	it('refererer meldingen det svares på', () => {
		const xml = byggDialogmelding({
			msgId: 'd-2', type: 'svar', innhold: 'Vedlagt.', mottaker, pasient, behandler, refMsgId: 'd-1'
		});
		expect(xml).toContain('<RefToParent>d-1</RefToParent>');
	});
});

describe('henvisning', () => {
	const xml = byggHenvisning({
		msgId: 'h-1',
		mottaker,
		pasient,
		behandler,
		diagnose: { kode: 'K86', tekst: 'Hypertensjon' },
		problemstilling: 'Vedvarende høyt blodtrykk tross tre legemidler.',
		anamnese: 'Kjent hypertensjon siden 2018.',
		onsketUndersokelse: 'Utredning for sekundær hypertensjon',
		hastegrad: 'haster',
		pasientenInformert: true
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
		expect(lesHodemelding(xml)?.type.kode).toBe('HENVIS');
	});
});

describe('epikrise og rekvisisjon', () => {
	it('markerer hoveddiagnose', () => {
		const xml = byggEpikrise({
			msgId: 'e-1', mottaker, pasient, behandler,
			kontaktFra: '2026-01-10',
			diagnoser: [{ kode: 'I10', tekst: 'Essensiell hypertensjon', hoveddiagnose: true }],
			sammendrag: 'Innlagt til utredning.'
		});
		expect(xml).toContain('<Hoveddiagnose V="J"/>');
		expect(xml).toContain('S="urn:oid:2.16.578.1.12.4.1.1.7110"');
	});

	it('lister analysene i en rekvisisjon', () => {
		const xml = byggRekvisisjon({
			msgId: 'r-1', mottaker, pasient, behandler,
			analyser: [
				{ kode: '4548-4', navn: 'HbA1c' },
				{ kode: '2160-0', navn: 'Kreatinin' }
			],
			kliniskeOpplysninger: 'Diabeteskontroll'
		});
		expect(xml).toContain('V="4548-4"');
		expect(xml).toContain('V="2160-0"');
		expect(lesHodemelding(xml)?.type.kode).toBe('MEDLAB');
	});
});

describe('applikasjonskvittering', () => {
	it('bygger og leser en positiv kvittering', () => {
		const xml = byggApprec({
			refMsgId: 'msg-1',
			refGenDate: '2026-01-01T10:00:00Z',
			refType: MELDINGSTYPER.HENVIS,
			status: '1',
			originalAvsender: { navn: 'Fastlegen', her: '8142519' }
		});
		const lest = lesApprec(xml);
		expect(lest).toMatchObject({ status: '1', refMsgId: 'msg-1' });
		expect(lest?.feil).toHaveLength(0);
	});

	it('bærer feilkoder ved avvisning', () => {
		const xml = byggApprec({
			refMsgId: 'msg-2',
			refGenDate: '2026-01-01T10:00:00Z',
			refType: MELDINGSTYPER.HENVIS,
			status: '3',
			feil: [APPREC_FEIL.UKJENT_PASIENT, APPREC_FEIL.MANGLER_FNR],
			originalAvsender: { navn: 'Fastlegen', her: '8142519' }
		});
		const lest = lesApprec(xml);
		expect(lest?.status).toBe('3');
		expect(lest?.feil.map((f) => f.kode)).toEqual(['E30', 'E31']);
	});

	it('gir null for noe som ikke er en kvittering', () => {
		expect(lesApprec('<Noe/>')).toBeNull();
		expect(lesApprec('ikke xml i det hele tatt')).toBeNull();
	});

	it('gir null når hodemeldingen ikke lar seg lese', () => {
		expect(lesHodemelding('<AppRec/>')).toBeNull();
	});
});
