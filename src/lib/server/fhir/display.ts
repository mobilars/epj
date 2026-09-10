import { SYSTEM, maskerNationalId } from './codesystems';
import type { CodeableConcept, FhirResource } from './types';

/**
 * Presentasjonshjelpere. Holdes på serversiden slik at klienten aldri trenger
 * å motta mer av ressursen enn den skal vise.
 */

export interface PatientDisplay {
	id: string;
	name: string;
	nationalId: string | null;
	nationalIdMasked: string | null;
	birthDate: string | null;
	age: number | null;
	gender: string;
	phone: string | null;
	email: string | null;
	address: string | null;
	gp: string | null;
	dod: boolean;
	reservertAgainstDigital?: boolean;
}

const GENDER: Record<string, string> = { male: 'Mann', female: 'Kvinne', other: 'Annet', unknown: 'Ukjent' };

export function toPatientDisplay(p: FhirResource): PatientDisplay {
	const name = (p.name as { given?: string[]; family?: string; use?: string }[] | undefined) ?? [];
	const offisielt = name.find((n) => n.use === 'official') ?? name[0];
	const identifikatorer = (p.identifier as { system?: string; value?: string }[] | undefined) ?? [];
	const fnr = identifikatorer.find((i) => i.system === SYSTEM.FNR || i.system === SYSTEM.DNR)?.value ?? null;
	const telecom = (p.telecom as { system?: string; value?: string }[] | undefined) ?? [];
	const address = (p.address as { line?: string[]; postalCode?: string; city?: string }[] | undefined)?.[0];
	const gp = (p.generalPractitioner as { display?: string; reference?: string }[] | undefined)?.[0];
	const birthDate = (p.birthDate as string) ?? null;

	return {
		id: (p.id as string) ?? '',
		name: [offisielt?.given?.join(' '), offisielt?.family].filter(Boolean).join(' ') || 'Uten navn',
		nationalId: fnr,
		nationalIdMasked: fnr ? maskerNationalId(fnr) : null,
		birthDate,
		age: birthDate ? ageFrom(birthDate) : null,
		gender: GENDER[(p.gender as string) ?? 'unknown'] ?? 'Ukjent',
		phone: telecom.find((t) => t.system === 'phone')?.value ?? null,
		email: telecom.find((t) => t.system === 'email')?.value ?? null,
		address: address ? [address.line?.join(', '), address.postalCode, address.city].filter(Boolean).join(', ') : null,
		gp: gp?.display ?? gp?.reference ?? null,
		dod: Boolean(p.deceasedBoolean) || Boolean(p.deceasedDateTime)
	};
}

export function ageFrom(birthDate: string): number {
	const f = new Date(birthDate);
	const now = new Date();
	let age = now.getUTCFullYear() - f.getUTCFullYear();
	const m = now.getUTCMonth() - f.getUTCMonth();
	if (m < 0 || (m === 0 && now.getUTCDate() < f.getUTCDate())) age--;
	return age;
}

export function codeText(cc: unknown): string {
	if (!cc || typeof cc !== 'object') return '';
	const c = cc as CodeableConcept;
	if (c.text) return c.text;
	const coding = c.coding?.[0];
	return coding?.display ?? coding?.code ?? '';
}

export function codeValue(cc: unknown): { system?: string; code?: string } {
	const c = cc as CodeableConcept | undefined;
	const coding = c?.coding?.[0];
	return { system: coding?.system, code: coding?.code };
}

export function formatsDate(iso: string | undefined | null, withTid = false): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString('nb-NO', {
		day: '2-digit', month: '2-digit', year: 'numeric',
		...(withTid ? { hour: '2-digit', minute: '2-digit' } : {})
	});
}

export function referenceId(ref: unknown): string | null {
	if (!ref || typeof ref !== 'object') return null;
	const r = (ref as { reference?: string }).reference;
	if (!r) return null;
	const parts = r.split('/');
	return parts[parts.length - 1] ?? null;
}

/** Klinisk status på en Condition, oversatt. */
export function klinisksStatus(c: FhirResource): string {
	const code = codeValue(c.clinicalStatus).code;
	switch (code) {
		case 'active': return 'Aktiv';
		case 'recurrence': return 'Residiv';
		case 'relapse': return 'Tilbakefall';
		case 'inactive': return 'Inaktiv';
		case 'remission': return 'I remisjon';
		case 'resolved': return 'Avsluttet';
		default: return code ?? '';
	}
}
