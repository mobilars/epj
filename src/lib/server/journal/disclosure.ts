import { patientRecord, resources } from '../fhir/internal';
import { actorFromContext, log } from '../audit';
import { formatsDate, klinisksStatus, codeText, codeValue, toPatientDisplay } from '../fhir/display';
import { SYSTEM } from '../fhir/codesystems';
import { requireTenant } from '../tenant/context';
import { newId } from '../util/ids';
import type { AuthContext } from '../authz/context';
import type { Bundle, FhirResource } from '../fhir/types';

/**
 * Utlevering av journal.
 *
 * Pasienten har rett til innsyn i og kopi av sin egen journal (pasient- og
 * brukerrettighetsloven § 5-1), og journalen skal kunne overføres til en annen
 * behandler (pasientjournalforskriften § 12). EPJ-standarden krever i tillegg
 * at en utlevering er sporbar: hvem som utleverte, til hvem, når, hvorfor, og
 * hva som faktisk ble utlevert.
 *
 * Derfor to formater av det samme innholdet:
 *
 *  - Et FHIR-dokument (Bundle av typen `document` med en Composition først).
 *    Det er formatet en annen journal kan lese maskinelt, og det er signerbart
 *    som en helhet.
 *  - En lesbar utgave - HTML for utskrift, og ren tekst - for pasienten selv,
 *    for advokater, og for NAV.
 *
 * Begge bygges av det samme uttrekket, slik at de ikke kan si forskjellige ting.
 * Uttrekket hentes gjennom vokteren, så en utlevering gir aldri mer enn den som
 * utleverer selv har tilgang til: sperret materiale faller bort på samme måte
 * som ellers, og det står i dokumentet at det kan ha skjedd.
 */

/** Hjemmelen utleveringen skjer på. Styrer purposeOfUse i sikkerhetsloggen. */
export type Utleveringsgrunn =
	| 'pasient-innsyn'
	| 'overforing-behandler'
	| 'rettslig'
	| 'forskning'
	| 'egen-dokumentasjon';

const PURPOSE_OF_USE: Record<Utleveringsgrunn, string> = {
	// v3-ActReason: pasienten ber om egne opplysninger
	'pasient-innsyn': 'PATRQT',
	// Behandling hos ny behandler
	'overforing-behandler': 'TREAT',
	// Rettslig krav
	rettslig: 'HLEGAL',
	forskning: 'HRESCH',
	// Virksomhetens egen dokumentasjon
	'egen-dokumentasjon': 'HOPERAT'
};

const REASON_TEXT: Record<Utleveringsgrunn, string> = {
	'pasient-innsyn': 'Innsyn etter pasient- og brukerrettighetsloven § 5-1',
	'overforing-behandler': 'Overføring til annen behandler',
	rettslig: 'Utlevering på rettslig grunnlag',
	forskning: 'Utlevering til forskning',
	'egen-dokumentasjon': 'Virksomhetens egen dokumentasjon'
};

export interface Utleveringsvalg {
	reason: Utleveringsgrunn;
	/** Hvem journalen utleveres til. Skrives i dokumentet og i loggen. */
	recipient?: string;
	/** Ta bare med opplysninger fra og med denne datoen (ISO). */
	fromDate?: string;
	/** Ta bare med opplysninger til og med denne datoen (ISO). */
	toDate?: string;
	/** Hvor mange ressurser som hentes fra journalen. */
	maxResources?: number;
}

export interface RecordExtract {
	/** FHIR-dokumentet. Dette er den maskinlesbare utleveringen. */
	document: Bundle;
	/** Identifikator som går igjen i dokument, lesbar utgave og logg. */
	disclosureId: string;
	patient: ReturnType<typeof toPatientDisplay>;
	timestamp: string;
	reason: Utleveringsgrunn;
	recipient: string | null;
	period: { from?: string; to?: string };
	/** Antall ressurser per type, slik det står i kvitteringen. */
	content: { type: string; count: number }[];
	countResources: number;
}

interface Section {
	title: string;
	code: { system: string; code: string; display: string };
	types: string[];
	/** Én linje per ressurs, slik den vises i den lesbare utgaven. */
	line(r: FhirResource): { date: string; hovedtekst: string; details: string[] } | null;
}

const LOINC = SYSTEM.LOINC;

/**
 * Seksjonene i dokumentet.
 *
 * Rekkefølgen og kodene følger IPS/LOINC der det finnes en etablert kode, slik
 * at et mottakersystem kan kjenne seksjonene igjen uten å tolke overskriftene.
 */
const SEKSJONER: Section[] = [
	{
		title: 'Diagnoser og helseproblemer',
		code: { system: LOINC, code: '11450-4', display: 'Problem list' },
		types: ['Condition'],
		line: (c) => ({
			date: formatsDate(c.recordedDate as string),
			hovedtekst: codeText(c.code) || 'Uten kodet diagnose',
			details: [
				codeValue(c.code).code ? `Kode ${codeValue(c.code).code}` : '',
				`Status: ${klinisksStatus(c)}`
			].filter(Boolean)
		})
	},
	{
		title: 'Legemidler',
		code: { system: LOINC, code: '10160-0', display: 'History of medication use' },
		types: ['MedicationRequest', 'MedicationStatement'],
		line: (m) => {
			const name =
				codeText((m.medication as { concept?: unknown })?.concept) ||
				codeText(m.medicationCodeableConcept) ||
				'Uten legemiddelnavn';
			const dosage = ((m.dosageInstruction as { text?: string }[]) ?? [])[0]?.text ?? '';
			return {
				date: formatsDate((m.authoredOn as string) ?? (m.effectiveDateTime as string)),
				hovedtekst: name,
				details: [dosage, `Status: ${m.status ?? 'ukjent'}`].filter(Boolean)
			};
		}
	},
	{
		title: 'Allergier og overfølsomhet',
		code: { system: LOINC, code: '48765-2', display: 'Allergies and adverse reactions' },
		types: ['AllergyIntolerance'],
		line: (a) => ({
			date: formatsDate(a.recordedDate as string),
			hovedtekst: codeText(a.code) || 'Uten kodet allergi',
			details: [a.criticality ? `Kritikalitet: ${a.criticality}` : '', `Status: ${klinisksStatus(a)}`].filter(Boolean)
		})
	},
	{
		title: 'Journalnotater',
		code: { system: LOINC, code: '34117-2', display: 'History and physical note' },
		types: ['Composition', 'DocumentReference'],
		line: (c) => ({
			date: formatsDate((c.date as string) ?? (c.meta?.loadUpdated as string), true),
			hovedtekst: (c.title as string) || codeText(c.type) || 'Notat',
			details: [
				((c.author as { display?: string }[]) ?? [])[0]?.display ?? '',
				notattekst(c)
			].filter(Boolean)
		})
	},
	{
		title: 'Konsultasjoner og kontakter',
		code: { system: LOINC, code: '46240-8', display: 'History of encounters' },
		types: ['Encounter'],
		line: (e) => ({
			date: formatsDate((e.actualPeriod as { start?: string })?.start, true),
			hovedtekst:
				codeText(((e.type as unknown[]) ?? [])[0]) || codeText(((e.class as unknown[]) ?? [])[0]) || 'Kontakt',
			details: [`Status: ${e.status ?? 'ukjent'}`]
		})
	},
	{
		title: 'Målinger og prøvesvar',
		code: { system: LOINC, code: '30954-2', display: 'Relevant diagnostic tests' },
		types: ['Observation', 'DiagnosticReport'],
		line: (o) => {
			const kvantitet = o.valueQuantity as { value?: number; unit?: string } | undefined;
			const value = kvantitet
				? `${kvantitet.value ?? ''} ${kvantitet.unit ?? ''}`.trim()
				: codeText(o.valueCodeableConcept) || String(o.valueString ?? o.conclusion ?? '');
			return {
				date: formatsDate((o.effectiveDateTime as string) ?? (o.issued as string), true),
				hovedtekst: codeText(o.code) || 'Måling',
				details: [value].filter(Boolean)
			};
		}
	},
	{
		title: 'Vaksinasjoner',
		code: { system: LOINC, code: '11369-6', display: 'History of immunization' },
		types: ['Immunization'],
		line: (i) => ({
			date: formatsDate((i.occurrenceDateTime as string) ?? (i.occurrenceString as string)),
			hovedtekst: codeText(i.vaccineCode) || 'Vaksine',
			details: [`Status: ${i.status ?? 'ukjent'}`]
		})
	},
	{
		title: 'Prosedyrer',
		code: { system: LOINC, code: '47519-4', display: 'History of procedures' },
		types: ['Procedure'],
		line: (p) => ({
			date: formatsDate((p.occurrenceDateTime as string) ?? (p.performedDateTime as string)),
			hovedtekst: codeText(p.code) || 'Prosedyre',
			details: [`Status: ${p.status ?? 'ukjent'}`]
		})
	},
	{
		title: 'Henvisninger og planer',
		code: { system: LOINC, code: '18776-5', display: 'Plan of care' },
		types: ['ServiceRequest', 'CarePlan', 'Appointment'],
		line: (s) => ({
			date: formatsDate((s.authoredOn as string) ?? (s.start as string) ?? (s.created as string), true),
			hovedtekst: codeText(s.code) || (s.description as string) || s.resourceType,
			details: [`Status: ${s.status ?? 'ukjent'}`]
		})
	}
];

/** Ressurstyper som ikke skal med i en utlevering. */
const UTELATT = new Set([
	// Sikkerhetsloggen utleveres for seg, gjennom innsyn i logg.
	'AuditEvent',
	// Sperringer er metadata om tilgangsstyring, ikke helseopplysninger.
	'Consent',
	// Pasienten selv er hentet ut separat, som dokumentets subject.
	'Patient'
]);

function notattekst(c: FhirResource): string {
	const seksjoner = (c.section as { text?: { div?: string } }[] | undefined) ?? [];
	const div = seksjoner[0]?.text?.div ?? (c.text as { div?: string } | undefined)?.div ?? '';
	return div.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function dateringOf(r: FhirResource): string {
	const candidates = [
		r.recordedDate, r.authoredOn, r.date, r.issued, r.effectiveDateTime,
		r.occurrenceDateTime, r.created, r.start, (r.actualPeriod as { start?: string })?.start,
		r.meta?.loadUpdated
	];
	return String(candidates.find((v) => typeof v === 'string' && v) ?? '');
}

function innenforPeriod(r: FhirResource, from?: string, to?: string): boolean {
	if (!from && !to) return true;
	const date = dateringOf(r).slice(0, 10);
	// Uten datering tas ressursen med: en utlevering skal heller inneholde for
	// mye enn å utelate noe i stillhet.
	if (!date) return true;
	if (from && date < from) return false;
	if (to && date > to) return false;
	return true;
}

/**
 * Henter journalen og bygger FHIR-dokumentet.
 *
 * Uttrekket går gjennom vokteren, som avgjør tilgang og skriver til
 * sikkerhetsloggen. Selve utleveringen loggføres i tillegg som en egen hendelse
 * med hjemmelen som purposeOfUse - det er den linjen et tilsyn ser etter.
 */
export async function buildRecordExtract(
	ctx: AuthContext,
	patientId: string,
	choice: Utleveringsvalg
): Promise<RecordExtract> {
	const tenant = requireTenant();
	const disclosureId = newId();
	const timestamp = new Date().toISOString();

	const bundle = await patientRecord(ctx, patientId, choice.maxResources ?? 1000);
	const all = resources(bundle);
	const patientResource = all.find((r) => r.resourceType === 'Patient');
	const patient = toPatientDisplay(patientResource ?? { resourceType: 'Patient', id: patientId });

	const withValue = all
		.filter((r) => !UTELATT.has(r.resourceType))
		.filter((r) => innenforPeriod(r, choice.fromDate, choice.toDate));

	const used = new Set<FhirResource>();
	const seksjoner = SEKSJONER.map((s) => {
		const match = withValue
			.filter((r) => s.types.includes(r.resourceType))
			.sort((a, b) => dateringOf(b).localeCompare(dateringOf(a)));
		for (const r of match) used.add(r);
		return { section: s, resources: match };
	}).filter((s) => s.resources.length > 0);

	// Alt som ikke passer i en seksjon havner til slutt, slik at ingenting
	// forsvinner bare fordi vi ikke hadde en overskrift til det.
	const ovrige = withValue.filter((r) => !used.has(r));

	const composition: FhirResource = {
		resourceType: 'Composition',
		id: disclosureId,
		status: 'final',
		type: {
			coding: [{ system: LOINC, code: '11503-0', display: 'Medical records' }],
			text: 'Utskrift av pasientjournal'
		},
		subject: { reference: `Patient/${patientId}`, display: patient.name },
		date: timestamp,
		author: [{ reference: ctx.actorRef, display: ctx.name }],
		title: `Journalutskrift for ${patient.name}`,
		custodian: {
			display: tenant.name,
			identifier: { system: SYSTEM.ORGNR, value: tenant.organisation_number }
		},
		attester: [{ mode: 'legal', time: timestamp, party: { reference: ctx.actorRef, display: ctx.name } }],
		event: [
			{
				period: choice.fromDate || choice.toDate ? { start: choice.fromDate, end: choice.toDate } : undefined,
				detail: [{ text: REASON_TEXT[choice.reason] }]
			}
		],
		extension: [
			{ url: 'https://epj.local/fhir/StructureDefinition/utleveringsgrunn', valueCode: choice.reason },
			...(choice.recipient
				? [{ url: 'https://epj.local/fhir/StructureDefinition/utlevert-til', valueString: choice.recipient }]
				: [])
		],
		section: [
			...seksjoner.map(({ section, resources: rs }) => ({
				title: section.title,
				code: { coding: [section.code] },
				entry: rs.map((r) => ({ reference: `${r.resourceType}/${r.id}` })),
				text: {
					status: 'generated',
					div: xhtml(sectionHtml(section, rs))
				}
			})),
			...(ovrige.length
				? [
						{
							title: 'Øvrige opplysninger',
							entry: ovrige.map((r) => ({ reference: `${r.resourceType}/${r.id}` })),
							text: {
								status: 'generated',
								div: xhtml(
									`<ul>${ovrige
										.map((r) => `<li>${esc(r.resourceType)} ${esc(String(r.id ?? ''))}</li>`)
										.join('')}</ul>`
								)
							}
						}
					]
				: [])
		]
	};

	const iDocument = [composition, ...(patientResource ? [patientResource] : []), ...withValue];
	const document: Bundle = {
		resourceType: 'Bundle',
		id: disclosureId,
		type: 'document',
		identifier: { system: `${tenant.base_url}/utlevering`, value: disclosureId },
		timestamp: timestamp,
		total: iDocument.length,
		entry: iDocument.map((r) => ({
			fullUrl: `urn:uuid:${r.id ?? newId()}`,
			resource: r
		}))
	};

	const content = countPerType(withValue);

	await log(
		{
			type: 'utlevering',
			subtype: `journal:${choice.reason}`,
			action: 'R',
			outcome: '0',
			patientId,
			entityRef: `Bundle/${disclosureId}`,
			purposeOfUse: PURPOSE_OF_USE[choice.reason],
			details: {
				disclosureId,
				recipient: choice.recipient ?? null,
				fromDate: choice.fromDate ?? null,
				toDate: choice.toDate ?? null,
				countResources: withValue.length,
				content: content.map((i) => `${i.type}:${i.count}`).join(' ')
			}
		},
		actorFromContext(ctx)
	);

	return {
		document,
		disclosureId,
		patient,
		timestamp,
		reason: choice.reason,
		recipient: choice.recipient ?? null,
		period: { from: choice.fromDate, to: choice.toDate },
		content,
		countResources: withValue.length
	};
}

function countPerType(resources: FhirResource[]): { type: string; count: number }[] {
	const counter = new Map<string, number>();
	for (const r of resources) counter.set(r.resourceType, (counter.get(r.resourceType) ?? 0) + 1);
	return [...counter.entries()]
		.map(([type, count]) => ({ type, count }))
		.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xhtml(content: string): string {
	return `<div xmlns="http://www.w3.org/1999/xhtml">${content}</div>`;
}

function sectionHtml(section: Section, rs: FhirResource[]): string {
	const rows = rs
		.map((r) => {
			const l = section.line(r);
			if (!l) return '';
			return `<tr><td>${esc(l.date)}</td><td>${esc(l.hovedtekst)}</td><td>${esc(l.details.join(' · '))}</td></tr>`;
		})
		.filter(Boolean)
		.join('');
	return `<table><thead><tr><th>Dato</th><th>Opplysning</th><th>Detaljer</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * Lesbar utgave av det samme uttrekket.
 *
 * Selvstendig HTML uten skript og uten eksterne ressurser: den skal kunne åpnes
 * fra en minnepinne om ti år, og skrives ut uten at noe forsvinner.
 */
export function toHtml(extract: RecordExtract): string {
	const { patient } = extract;
	const document = extract.document;
	const composition = (document.entry ?? [])[0]?.resource as FhirResource | undefined;
	const seksjoner = (composition?.section as { title?: string; text?: { div?: string } }[] | undefined) ?? [];

	const row = (n: string, v: string | null | undefined) =>
        v ? `<tr><th>${esc(n)}</th><td>${esc(v)}</td></tr>` : '';

	return `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8" />
<title>Journalutskrift for ${esc(patient.name)}</title>
<style>
:root { color-scheme: light; }
body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #14181d; background: #fff; margin: 0; padding: 2rem 1.5rem; }
main { max-width: 52rem; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 .3rem; }
h2 { font-size: 1.15rem; margin: 2rem 0 .6rem; padding-bottom: .3rem; border-bottom: 2px solid #d7dee6; }
table { border-collapse: collapse; width: 100%; margin: .4rem 0 1rem; }
th, td { text-align: left; vertical-align: top; padding: .4rem .6rem; border-bottom: 1px solid #e6ebf0; }
thead th { background: #f2f5f8; font-size: .85rem; text-transform: uppercase; letter-spacing: .03em; }
.forside th { width: 12rem; background: none; text-transform: none; letter-spacing: 0; font-size: 1rem; }
.merknad { background: #fff8e6; border: 1px solid #e6d59a; border-radius: 6px; padding: .8rem 1rem; margin: 1.2rem 0; }
footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #d7dee6; font-size: .85rem; color: #5a6672; }
@media print { body { padding: 0; } h2 { break-after: avoid; } tr { break-inside: avoid; } }
</style>
</head>
<body>
<main>
<h1>Utskrift av pasientjournal</h1>
<p>${esc(REASON_TEXT[extract.reason])}</p>

<table class="forside">
${row('Pasient', patient.name)}
${row('Fødselsnummer', patient.nationalId)}
${row('Fødselsdato', patient.birthDate)}
${row('Adresse', patient.address)}
${row('Journalansvarlig virksomhet', (composition?.custodian as { display?: string })?.display)}
${row('Utlevert til', extract.recipient)}
${row('Utlevert av', ((composition?.author as { display?: string }[]) ?? [])[0]?.display)}
${row('Utlevert', new Date(extract.timestamp).toLocaleString('nb-NO'))}
${row('Periode', extract.period.from || extract.period.to ? `${extract.period.from ?? 'fra journalens start'} – ${extract.period.to ?? 'i dag'}` : 'Hele journalen')}
${row('Referanse', extract.disclosureId)}
</table>

<div class="merknad">
<strong>Om utskriften.</strong>
Utskriften viser opplysningene den som utleverte hadde tilgang til på
utleveringstidspunktet. Har pasienten sperret deler av journalen, eller er
opplysninger registrert etter dette tidspunktet, er de ikke med her.
Journalen er ført fortløpende, og teksten er ikke omskrevet for utskriften.
</div>

${seksjoner
	.map(
		(s) =>
			`<h2>${esc(s.title ?? 'Uten overskrift')}</h2>\n${(s.text?.div ?? '').replace(
				/^<div xmlns="http:\/\/www\.w3\.org\/1999\/xhtml">|<\/div>$/g,
				''
			)}`
	)
	.join('\n')}

<h2>Innhold i utleveringen</h2>
<table>
<thead><tr><th>Opplysningstype</th><th>Antall</th></tr></thead>
<tbody>
${extract.content.map((i) => `<tr><td>${esc(i.type)}</td><td>${i.count}</td></tr>`).join('\n')}
<tr><th>Til sammen</th><th>${extract.countResources}</th></tr>
</tbody>
</table>

<footer>
Utlevering ${esc(extract.disclosureId)} · ${esc(new Date(extract.timestamp).toLocaleString('nb-NO'))}<br />
Utleveringen er registrert i virksomhetens sikkerhetslogg. Pasienten kan be om
innsyn i loggen for å se hvem som har hentet opplysninger fra journalen.
</footer>
</main>
</body>
</html>`;
}

/** Ren tekst, for arkivering og for lesere som ikke tar imot HTML. */
export function toText(extract: RecordExtract): string {
	const composition = (extract.document.entry ?? [])[0]?.resource as FhirResource | undefined;
	const seksjoner = (composition?.section as { title?: string; entry?: { reference?: string }[] }[] | undefined) ?? [];
	const perRef = new Map(
		(extract.document.entry ?? [])
			.map((e) => e.resource as FhirResource)
			.filter(Boolean)
			.map((r) => [`${r.resourceType}/${r.id}`, r])
	);

	const lines: string[] = [
		'UTSKRIFT AV PASIENTJOURNAL',
		REASON_TEXT[extract.reason],
		'',
		`Pasient:        ${extract.patient.name}`,
		`Fødselsnummer:  ${extract.patient.nationalId ?? 'ukjent'}`,
		`Utlevert:       ${new Date(extract.timestamp).toLocaleString('nb-NO')}`,
		`Utlevert til:   ${extract.recipient ?? '(ikke oppgitt)'}`,
		`Referanse:      ${extract.disclosureId}`,
		''
	];

	for (const s of seksjoner) {
		const section = SEKSJONER.find((k) => k.title === s.title);
		lines.push('', (s.title ?? '').toUpperCase(), '='.repeat((s.title ?? '').length));
		for (const e of s.entry ?? []) {
			const r = e.reference ? perRef.get(e.reference) : undefined;
			if (!r) continue;
			const l = section?.line(r);
			lines.push(
				l
					? `${l.date.padEnd(18)} ${l.hovedtekst}${l.details.length ? `\n${' '.repeat(19)}${l.details.join(' · ')}` : ''}`
					: `${r.resourceType}/${r.id}`
			);
		}
	}

	lines.push(
		'',
		'INNHOLD I UTLEVERINGEN',
		'======================',
		...extract.content.map((i) => `${i.type.padEnd(24)} ${i.count}`),
		`${'Til sammen'.padEnd(24)} ${extract.countResources}`,
		'',
		'Utskriften viser opplysningene den som utleverte hadde tilgang til på',
		'utleveringstidspunktet. Utleveringen er registrert i sikkerhetsloggen.'
	);

	return lines.join('\n');
}

/** Filnavn som tåler å bli lagret og sendt videre. */
export function filnavn(extract: RecordExtract, extension: 'json' | 'html' | 'txt'): string {
	const name = extract.patient.name
		.toLowerCase()
		.replace(/æ/g, 'ae')
		.replace(/ø/g, 'o')
		.replace(/å/g, 'a')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	return `journal-${name || 'pasient'}-${extract.timestamp.slice(0, 10)}.${extension}`;
}

export const UTLEVERINGSGRUNNER: { code: Utleveringsgrunn; text: string; purposeOfUse: string }[] = (
	Object.keys(REASON_TEXT) as Utleveringsgrunn[]
).map((code) => ({ code, text: REASON_TEXT[code], purposeOfUse: PURPOSE_OF_USE[code] }));
