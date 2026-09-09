import { SYSTEM, maskerPersonnummer } from './kodeverk';
import type { CodeableConcept, FhirResource } from './types';

/**
 * Presentasjonshjelpere. Holdes på serversiden slik at klienten aldri trenger
 * å motta mer av ressursen enn den skal vise.
 */

export interface PasientVisning {
	id: string;
	navn: string;
	fodselsnummer: string | null;
	fodselsnummerMaskert: string | null;
	fodselsdato: string | null;
	alder: number | null;
	kjonn: string;
	telefon: string | null;
	epost: string | null;
	adresse: string | null;
	fastlege: string | null;
	dod: boolean;
	reservertMotDigital?: boolean;
}

const KJONN: Record<string, string> = { male: 'Mann', female: 'Kvinne', other: 'Annet', unknown: 'Ukjent' };

export function tilPasientVisning(p: FhirResource): PasientVisning {
	const navn = (p.name as { given?: string[]; family?: string; use?: string }[] | undefined) ?? [];
	const offisielt = navn.find((n) => n.use === 'official') ?? navn[0];
	const identifikatorer = (p.identifier as { system?: string; value?: string }[] | undefined) ?? [];
	const fnr = identifikatorer.find((i) => i.system === SYSTEM.FNR || i.system === SYSTEM.DNR)?.value ?? null;
	const telecom = (p.telecom as { system?: string; value?: string }[] | undefined) ?? [];
	const adresse = (p.address as { line?: string[]; postalCode?: string; city?: string }[] | undefined)?.[0];
	const fastlege = (p.generalPractitioner as { display?: string; reference?: string }[] | undefined)?.[0];
	const fodselsdato = (p.birthDate as string) ?? null;

	return {
		id: (p.id as string) ?? '',
		navn: [offisielt?.given?.join(' '), offisielt?.family].filter(Boolean).join(' ') || 'Uten navn',
		fodselsnummer: fnr,
		fodselsnummerMaskert: fnr ? maskerPersonnummer(fnr) : null,
		fodselsdato,
		alder: fodselsdato ? alderFra(fodselsdato) : null,
		kjonn: KJONN[(p.gender as string) ?? 'unknown'] ?? 'Ukjent',
		telefon: telecom.find((t) => t.system === 'phone')?.value ?? null,
		epost: telecom.find((t) => t.system === 'email')?.value ?? null,
		adresse: adresse ? [adresse.line?.join(', '), adresse.postalCode, adresse.city].filter(Boolean).join(', ') : null,
		fastlege: fastlege?.display ?? fastlege?.reference ?? null,
		dod: Boolean(p.deceasedBoolean) || Boolean(p.deceasedDateTime)
	};
}

export function alderFra(fodselsdato: string): number {
	const f = new Date(fodselsdato);
	const nå = new Date();
	let alder = nå.getUTCFullYear() - f.getUTCFullYear();
	const m = nå.getUTCMonth() - f.getUTCMonth();
	if (m < 0 || (m === 0 && nå.getUTCDate() < f.getUTCDate())) alder--;
	return alder;
}

export function kodeTekst(cc: unknown): string {
	if (!cc || typeof cc !== 'object') return '';
	const c = cc as CodeableConcept;
	if (c.text) return c.text;
	const coding = c.coding?.[0];
	return coding?.display ?? coding?.code ?? '';
}

export function kodeVerdi(cc: unknown): { system?: string; kode?: string } {
	const c = cc as CodeableConcept | undefined;
	const coding = c?.coding?.[0];
	return { system: coding?.system, kode: coding?.code };
}

export function formaterDato(iso: string | undefined | null, medTid = false): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString('nb-NO', {
		day: '2-digit', month: '2-digit', year: 'numeric',
		...(medTid ? { hour: '2-digit', minute: '2-digit' } : {})
	});
}

export function referanseId(ref: unknown): string | null {
	if (!ref || typeof ref !== 'object') return null;
	const r = (ref as { reference?: string }).reference;
	if (!r) return null;
	const deler = r.split('/');
	return deler[deler.length - 1] ?? null;
}

/** Klinisk status på en Condition, oversatt. */
export function klinisksStatus(c: FhirResource): string {
	const kode = kodeVerdi(c.clinicalStatus).kode;
	switch (kode) {
		case 'active': return 'Aktiv';
		case 'recurrence': return 'Residiv';
		case 'relapse': return 'Tilbakefall';
		case 'inactive': return 'Inaktiv';
		case 'remission': return 'I remisjon';
		case 'resolved': return 'Avsluttet';
		default: return kode ?? '';
	}
}
