import { pasientJournal, ressurser } from '../fhir/internt';
import { aktorFraKontekst, logg } from '../audit';
import { formaterDato, klinisksStatus, kodeTekst, kodeVerdi, tilPasientVisning } from '../fhir/visning';
import { SYSTEM } from '../fhir/kodeverk';
import { krevTenant } from '../tenant/kontekst';
import { nyId } from '../util/ids';
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

const GRUNN_TEKST: Record<Utleveringsgrunn, string> = {
	'pasient-innsyn': 'Innsyn etter pasient- og brukerrettighetsloven § 5-1',
	'overforing-behandler': 'Overføring til annen behandler',
	rettslig: 'Utlevering på rettslig grunnlag',
	forskning: 'Utlevering til forskning',
	'egen-dokumentasjon': 'Virksomhetens egen dokumentasjon'
};

export interface Utleveringsvalg {
	grunn: Utleveringsgrunn;
	/** Hvem journalen utleveres til. Skrives i dokumentet og i loggen. */
	mottaker?: string;
	/** Ta bare med opplysninger fra og med denne datoen (ISO). */
	fraDato?: string;
	/** Ta bare med opplysninger til og med denne datoen (ISO). */
	tilDato?: string;
	/** Hvor mange ressurser som hentes fra journalen. */
	maksRessurser?: number;
}

export interface Journaluttrekk {
	/** FHIR-dokumentet. Dette er den maskinlesbare utleveringen. */
	dokument: Bundle;
	/** Identifikator som går igjen i dokument, lesbar utgave og logg. */
	utleveringsId: string;
	pasient: ReturnType<typeof tilPasientVisning>;
	tidspunkt: string;
	grunn: Utleveringsgrunn;
	mottaker: string | null;
	periode: { fra?: string; til?: string };
	/** Antall ressurser per type, slik det står i kvitteringen. */
	innhold: { type: string; antall: number }[];
	antallRessurser: number;
}

interface Seksjon {
	tittel: string;
	kode: { system: string; code: string; display: string };
	typer: string[];
	/** Én linje per ressurs, slik den vises i den lesbare utgaven. */
	linje(r: FhirResource): { dato: string; hovedtekst: string; detaljer: string[] } | null;
}

const LOINC = SYSTEM.LOINC;

/**
 * Seksjonene i dokumentet.
 *
 * Rekkefølgen og kodene følger IPS/LOINC der det finnes en etablert kode, slik
 * at et mottakersystem kan kjenne seksjonene igjen uten å tolke overskriftene.
 */
const SEKSJONER: Seksjon[] = [
	{
		tittel: 'Diagnoser og helseproblemer',
		kode: { system: LOINC, code: '11450-4', display: 'Problem list' },
		typer: ['Condition'],
		linje: (c) => ({
			dato: formaterDato(c.recordedDate as string),
			hovedtekst: kodeTekst(c.code) || 'Uten kodet diagnose',
			detaljer: [
				kodeVerdi(c.code).kode ? `Kode ${kodeVerdi(c.code).kode}` : '',
				`Status: ${klinisksStatus(c)}`
			].filter(Boolean)
		})
	},
	{
		tittel: 'Legemidler',
		kode: { system: LOINC, code: '10160-0', display: 'History of medication use' },
		typer: ['MedicationRequest', 'MedicationStatement'],
		linje: (m) => {
			const navn =
				kodeTekst((m.medication as { concept?: unknown })?.concept) ||
				kodeTekst(m.medicationCodeableConcept) ||
				'Uten legemiddelnavn';
			const dosering = ((m.dosageInstruction as { text?: string }[]) ?? [])[0]?.text ?? '';
			return {
				dato: formaterDato((m.authoredOn as string) ?? (m.effectiveDateTime as string)),
				hovedtekst: navn,
				detaljer: [dosering, `Status: ${m.status ?? 'ukjent'}`].filter(Boolean)
			};
		}
	},
	{
		tittel: 'Allergier og overfølsomhet',
		kode: { system: LOINC, code: '48765-2', display: 'Allergies and adverse reactions' },
		typer: ['AllergyIntolerance'],
		linje: (a) => ({
			dato: formaterDato(a.recordedDate as string),
			hovedtekst: kodeTekst(a.code) || 'Uten kodet allergi',
			detaljer: [a.criticality ? `Kritikalitet: ${a.criticality}` : '', `Status: ${klinisksStatus(a)}`].filter(Boolean)
		})
	},
	{
		tittel: 'Journalnotater',
		kode: { system: LOINC, code: '34117-2', display: 'History and physical note' },
		typer: ['Composition', 'DocumentReference'],
		linje: (c) => ({
			dato: formaterDato((c.date as string) ?? (c.meta?.lastUpdated as string), true),
			hovedtekst: (c.title as string) || kodeTekst(c.type) || 'Notat',
			detaljer: [
				((c.author as { display?: string }[]) ?? [])[0]?.display ?? '',
				notattekst(c)
			].filter(Boolean)
		})
	},
	{
		tittel: 'Konsultasjoner og kontakter',
		kode: { system: LOINC, code: '46240-8', display: 'History of encounters' },
		typer: ['Encounter'],
		linje: (e) => ({
			dato: formaterDato((e.actualPeriod as { start?: string })?.start, true),
			hovedtekst:
				kodeTekst(((e.type as unknown[]) ?? [])[0]) || kodeTekst(((e.class as unknown[]) ?? [])[0]) || 'Kontakt',
			detaljer: [`Status: ${e.status ?? 'ukjent'}`]
		})
	},
	{
		tittel: 'Målinger og prøvesvar',
		kode: { system: LOINC, code: '30954-2', display: 'Relevant diagnostic tests' },
		typer: ['Observation', 'DiagnosticReport'],
		linje: (o) => {
			const kvantitet = o.valueQuantity as { value?: number; unit?: string } | undefined;
			const verdi = kvantitet
				? `${kvantitet.value ?? ''} ${kvantitet.unit ?? ''}`.trim()
				: kodeTekst(o.valueCodeableConcept) || String(o.valueString ?? o.conclusion ?? '');
			return {
				dato: formaterDato((o.effectiveDateTime as string) ?? (o.issued as string), true),
				hovedtekst: kodeTekst(o.code) || 'Måling',
				detaljer: [verdi].filter(Boolean)
			};
		}
	},
	{
		tittel: 'Vaksinasjoner',
		kode: { system: LOINC, code: '11369-6', display: 'History of immunization' },
		typer: ['Immunization'],
		linje: (i) => ({
			dato: formaterDato((i.occurrenceDateTime as string) ?? (i.occurrenceString as string)),
			hovedtekst: kodeTekst(i.vaccineCode) || 'Vaksine',
			detaljer: [`Status: ${i.status ?? 'ukjent'}`]
		})
	},
	{
		tittel: 'Prosedyrer',
		kode: { system: LOINC, code: '47519-4', display: 'History of procedures' },
		typer: ['Procedure'],
		linje: (p) => ({
			dato: formaterDato((p.occurrenceDateTime as string) ?? (p.performedDateTime as string)),
			hovedtekst: kodeTekst(p.code) || 'Prosedyre',
			detaljer: [`Status: ${p.status ?? 'ukjent'}`]
		})
	},
	{
		tittel: 'Henvisninger og planer',
		kode: { system: LOINC, code: '18776-5', display: 'Plan of care' },
		typer: ['ServiceRequest', 'CarePlan', 'Appointment'],
		linje: (s) => ({
			dato: formaterDato((s.authoredOn as string) ?? (s.start as string) ?? (s.created as string), true),
			hovedtekst: kodeTekst(s.code) || (s.description as string) || s.resourceType,
			detaljer: [`Status: ${s.status ?? 'ukjent'}`]
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

function dateringAv(r: FhirResource): string {
	const kandidater = [
		r.recordedDate, r.authoredOn, r.date, r.issued, r.effectiveDateTime,
		r.occurrenceDateTime, r.created, r.start, (r.actualPeriod as { start?: string })?.start,
		r.meta?.lastUpdated
	];
	return String(kandidater.find((v) => typeof v === 'string' && v) ?? '');
}

function innenforPeriode(r: FhirResource, fra?: string, til?: string): boolean {
	if (!fra && !til) return true;
	const dato = dateringAv(r).slice(0, 10);
	// Uten datering tas ressursen med: en utlevering skal heller inneholde for
	// mye enn å utelate noe i stillhet.
	if (!dato) return true;
	if (fra && dato < fra) return false;
	if (til && dato > til) return false;
	return true;
}

/**
 * Henter journalen og bygger FHIR-dokumentet.
 *
 * Uttrekket går gjennom vokteren, som avgjør tilgang og skriver til
 * sikkerhetsloggen. Selve utleveringen loggføres i tillegg som en egen hendelse
 * med hjemmelen som purposeOfUse - det er den linjen et tilsyn ser etter.
 */
export async function byggJournaluttrekk(
	ctx: AuthContext,
	patientId: string,
	valg: Utleveringsvalg
): Promise<Journaluttrekk> {
	const tenant = krevTenant();
	const utleveringsId = nyId();
	const tidspunkt = new Date().toISOString();

	const bundle = await pasientJournal(ctx, patientId, valg.maksRessurser ?? 1000);
	const alle = ressurser(bundle);
	const pasientRessurs = alle.find((r) => r.resourceType === 'Patient');
	const pasient = tilPasientVisning(pasientRessurs ?? { resourceType: 'Patient', id: patientId });

	const med = alle
		.filter((r) => !UTELATT.has(r.resourceType))
		.filter((r) => innenforPeriode(r, valg.fraDato, valg.tilDato));

	const brukt = new Set<FhirResource>();
	const seksjoner = SEKSJONER.map((s) => {
		const treff = med
			.filter((r) => s.typer.includes(r.resourceType))
			.sort((a, b) => dateringAv(b).localeCompare(dateringAv(a)));
		for (const r of treff) brukt.add(r);
		return { seksjon: s, ressurser: treff };
	}).filter((s) => s.ressurser.length > 0);

	// Alt som ikke passer i en seksjon havner til slutt, slik at ingenting
	// forsvinner bare fordi vi ikke hadde en overskrift til det.
	const ovrige = med.filter((r) => !brukt.has(r));

	const composition: FhirResource = {
		resourceType: 'Composition',
		id: utleveringsId,
		status: 'final',
		type: {
			coding: [{ system: LOINC, code: '11503-0', display: 'Medical records' }],
			text: 'Utskrift av pasientjournal'
		},
		subject: { reference: `Patient/${patientId}`, display: pasient.navn },
		date: tidspunkt,
		author: [{ reference: ctx.actorRef, display: ctx.navn }],
		title: `Journalutskrift for ${pasient.navn}`,
		custodian: {
			display: tenant.navn,
			identifier: { system: SYSTEM.ORGNR, value: tenant.organisasjonsnummer }
		},
		attester: [{ mode: 'legal', time: tidspunkt, party: { reference: ctx.actorRef, display: ctx.navn } }],
		event: [
			{
				period: valg.fraDato || valg.tilDato ? { start: valg.fraDato, end: valg.tilDato } : undefined,
				detail: [{ text: GRUNN_TEKST[valg.grunn] }]
			}
		],
		extension: [
			{ url: 'https://epj.local/fhir/StructureDefinition/utleveringsgrunn', valueCode: valg.grunn },
			...(valg.mottaker
				? [{ url: 'https://epj.local/fhir/StructureDefinition/utlevert-til', valueString: valg.mottaker }]
				: [])
		],
		section: [
			...seksjoner.map(({ seksjon, ressurser: rs }) => ({
				title: seksjon.tittel,
				code: { coding: [seksjon.kode] },
				entry: rs.map((r) => ({ reference: `${r.resourceType}/${r.id}` })),
				text: {
					status: 'generated',
					div: xhtml(seksjonHtml(seksjon, rs))
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

	const iDokument = [composition, ...(pasientRessurs ? [pasientRessurs] : []), ...med];
	const dokument: Bundle = {
		resourceType: 'Bundle',
		id: utleveringsId,
		type: 'document',
		identifier: { system: `${tenant.base_url}/utlevering`, value: utleveringsId },
		timestamp: tidspunkt,
		total: iDokument.length,
		entry: iDokument.map((r) => ({
			fullUrl: `urn:uuid:${r.id ?? nyId()}`,
			resource: r
		}))
	};

	const innhold = tellPerType(med);

	await logg(
		{
			type: 'utlevering',
			subtype: `journal:${valg.grunn}`,
			handling: 'R',
			utfall: '0',
			patientId,
			entityRef: `Bundle/${utleveringsId}`,
			purposeOfUse: PURPOSE_OF_USE[valg.grunn],
			detaljer: {
				utleveringsId,
				mottaker: valg.mottaker ?? null,
				fraDato: valg.fraDato ?? null,
				tilDato: valg.tilDato ?? null,
				antallRessurser: med.length,
				innhold: innhold.map((i) => `${i.type}:${i.antall}`).join(' ')
			}
		},
		aktorFraKontekst(ctx)
	);

	return {
		dokument,
		utleveringsId,
		pasient,
		tidspunkt,
		grunn: valg.grunn,
		mottaker: valg.mottaker ?? null,
		periode: { fra: valg.fraDato, til: valg.tilDato },
		innhold,
		antallRessurser: med.length
	};
}

function tellPerType(ressurser: FhirResource[]): { type: string; antall: number }[] {
	const teller = new Map<string, number>();
	for (const r of ressurser) teller.set(r.resourceType, (teller.get(r.resourceType) ?? 0) + 1);
	return [...teller.entries()]
		.map(([type, antall]) => ({ type, antall }))
		.sort((a, b) => b.antall - a.antall || a.type.localeCompare(b.type));
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function xhtml(innhold: string): string {
	return `<div xmlns="http://www.w3.org/1999/xhtml">${innhold}</div>`;
}

function seksjonHtml(seksjon: Seksjon, rs: FhirResource[]): string {
	const rader = rs
		.map((r) => {
			const l = seksjon.linje(r);
			if (!l) return '';
			return `<tr><td>${esc(l.dato)}</td><td>${esc(l.hovedtekst)}</td><td>${esc(l.detaljer.join(' · '))}</td></tr>`;
		})
		.filter(Boolean)
		.join('');
	return `<table><thead><tr><th>Dato</th><th>Opplysning</th><th>Detaljer</th></tr></thead><tbody>${rader}</tbody></table>`;
}

/**
 * Lesbar utgave av det samme uttrekket.
 *
 * Selvstendig HTML uten skript og uten eksterne ressurser: den skal kunne åpnes
 * fra en minnepinne om ti år, og skrives ut uten at noe forsvinner.
 */
export function tilHtml(uttrekk: Journaluttrekk): string {
	const { pasient } = uttrekk;
	const dokument = uttrekk.dokument;
	const composition = (dokument.entry ?? [])[0]?.resource as FhirResource | undefined;
	const seksjoner = (composition?.section as { title?: string; text?: { div?: string } }[] | undefined) ?? [];

	const rad = (n: string, v: string | null | undefined) =>
        v ? `<tr><th>${esc(n)}</th><td>${esc(v)}</td></tr>` : '';

	return `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8" />
<title>Journalutskrift for ${esc(pasient.navn)}</title>
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
<p>${esc(GRUNN_TEKST[uttrekk.grunn])}</p>

<table class="forside">
${rad('Pasient', pasient.navn)}
${rad('Fødselsnummer', pasient.fodselsnummer)}
${rad('Fødselsdato', pasient.fodselsdato)}
${rad('Adresse', pasient.adresse)}
${rad('Journalansvarlig virksomhet', (composition?.custodian as { display?: string })?.display)}
${rad('Utlevert til', uttrekk.mottaker)}
${rad('Utlevert av', ((composition?.author as { display?: string }[]) ?? [])[0]?.display)}
${rad('Utlevert', new Date(uttrekk.tidspunkt).toLocaleString('nb-NO'))}
${rad('Periode', uttrekk.periode.fra || uttrekk.periode.til ? `${uttrekk.periode.fra ?? 'fra journalens start'} – ${uttrekk.periode.til ?? 'i dag'}` : 'Hele journalen')}
${rad('Referanse', uttrekk.utleveringsId)}
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
${uttrekk.innhold.map((i) => `<tr><td>${esc(i.type)}</td><td>${i.antall}</td></tr>`).join('\n')}
<tr><th>Til sammen</th><th>${uttrekk.antallRessurser}</th></tr>
</tbody>
</table>

<footer>
Utlevering ${esc(uttrekk.utleveringsId)} · ${esc(new Date(uttrekk.tidspunkt).toLocaleString('nb-NO'))}<br />
Utleveringen er registrert i virksomhetens sikkerhetslogg. Pasienten kan be om
innsyn i loggen for å se hvem som har hentet opplysninger fra journalen.
</footer>
</main>
</body>
</html>`;
}

/** Ren tekst, for arkivering og for lesere som ikke tar imot HTML. */
export function tilTekst(uttrekk: Journaluttrekk): string {
	const composition = (uttrekk.dokument.entry ?? [])[0]?.resource as FhirResource | undefined;
	const seksjoner = (composition?.section as { title?: string; entry?: { reference?: string }[] }[] | undefined) ?? [];
	const perRef = new Map(
		(uttrekk.dokument.entry ?? [])
			.map((e) => e.resource as FhirResource)
			.filter(Boolean)
			.map((r) => [`${r.resourceType}/${r.id}`, r])
	);

	const linjer: string[] = [
		'UTSKRIFT AV PASIENTJOURNAL',
		GRUNN_TEKST[uttrekk.grunn],
		'',
		`Pasient:        ${uttrekk.pasient.navn}`,
		`Fødselsnummer:  ${uttrekk.pasient.fodselsnummer ?? 'ukjent'}`,
		`Utlevert:       ${new Date(uttrekk.tidspunkt).toLocaleString('nb-NO')}`,
		`Utlevert til:   ${uttrekk.mottaker ?? '(ikke oppgitt)'}`,
		`Referanse:      ${uttrekk.utleveringsId}`,
		''
	];

	for (const s of seksjoner) {
		const seksjon = SEKSJONER.find((k) => k.tittel === s.title);
		linjer.push('', (s.title ?? '').toUpperCase(), '='.repeat((s.title ?? '').length));
		for (const e of s.entry ?? []) {
			const r = e.reference ? perRef.get(e.reference) : undefined;
			if (!r) continue;
			const l = seksjon?.linje(r);
			linjer.push(
				l
					? `${l.dato.padEnd(18)} ${l.hovedtekst}${l.detaljer.length ? `\n${' '.repeat(19)}${l.detaljer.join(' · ')}` : ''}`
					: `${r.resourceType}/${r.id}`
			);
		}
	}

	linjer.push(
		'',
		'INNHOLD I UTLEVERINGEN',
		'======================',
		...uttrekk.innhold.map((i) => `${i.type.padEnd(24)} ${i.antall}`),
		`${'Til sammen'.padEnd(24)} ${uttrekk.antallRessurser}`,
		'',
		'Utskriften viser opplysningene den som utleverte hadde tilgang til på',
		'utleveringstidspunktet. Utleveringen er registrert i sikkerhetsloggen.'
	);

	return linjer.join('\n');
}

/** Filnavn som tåler å bli lagret og sendt videre. */
export function filnavn(uttrekk: Journaluttrekk, endelse: 'json' | 'html' | 'txt'): string {
	const navn = uttrekk.pasient.navn
		.toLowerCase()
		.replace(/æ/g, 'ae')
		.replace(/ø/g, 'o')
		.replace(/å/g, 'a')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	return `journal-${navn || 'pasient'}-${uttrekk.tidspunkt.slice(0, 10)}.${endelse}`;
}

export const UTLEVERINGSGRUNNER: { kode: Utleveringsgrunn; tekst: string; purposeOfUse: string }[] = (
	Object.keys(GRUNN_TEKST) as Utleveringsgrunn[]
).map((kode) => ({ kode, tekst: GRUNN_TEKST[kode], purposeOfUse: PURPOSE_OF_USE[kode] }));
