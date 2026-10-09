import type { AuthContext } from '../authz/context';
import { SYSTEM, genderFromNationalId, validDateDel, validNorwegianNationalId } from '../fhir/codesystems';
import { resources, searchResources } from '../fhir/internal';
import type { FhirResource } from '../fhir/types';
import { compactPhone } from './openlink';

/**
 * A patient's own details: who they are and how to reach them.
 *
 * Shared by registering a patient and by correcting one afterwards, so the two
 * cannot disagree about what a valid entry is or how it is written to FHIR.
 *
 * On the national identity number. A real one is checked against its own check
 * digits and filed under the national system. One that fails the check may
 * still be saved - a test patient, or a number that has to be corrected later -
 * but only after the user has been told and has said so, and then under a
 * system of the record's own. It is never written as a `fødselsnummer`, so
 * nothing downstream can mistake it for one, and the gateway's own check on
 * the national systems stays exactly as strict as it was.
 */

/** The national systems, and the record's own for a number that failed its check. */
const IDENTITY_SYSTEMS: string[] = [SYSTEM.FNR, SYSTEM.DNR, SYSTEM.UNVERIFIED_NATIONAL_ID];

export const GENDERS = ['male', 'female', 'other', 'unknown'] as const;
export type Gender = (typeof GENDERS)[number];

/** What the forms post. Field names are the forms' own. */
export interface PatientDetails {
	nationalId: string;
	given: string;
	family: string;
	/** ISO date, or empty to take it from the number where that is possible. */
	birthDate: string;
	/** Empty to take it from the number. */
	gender: Gender | '';
	phone: string;
	email: string;
	addressLine: string;
	postalCode: string;
	city: string;
}

export function detailsFromForm(form: FormData): PatientDetails {
	const text = (name: string) => String(form.get(name) ?? '').trim();
	const gender = text('kjonn');
	return {
		nationalId: text('fodselsnummer').replace(/\s/g, ''),
		given: text('fornavn'),
		family: text('etternavn'),
		birthDate: text('fodselsdato'),
		gender: (GENDERS as readonly string[]).includes(gender) ? (gender as Gender) : '',
		phone: text('telefon'),
		email: text('epost'),
		addressLine: text('adresse'),
		postalCode: text('postnummer'),
		city: text('poststed')
	};
}

/** The same details as the forms want them back, to refill after a refusal. */
export function detailsAsFormValues(d: PatientDetails): Record<string, string> {
	return {
		fodselsnummer: d.nationalId,
		fornavn: d.given,
		etternavn: d.family,
		fodselsdato: d.birthDate,
		kjonn: d.gender,
		telefon: d.phone,
		epost: d.email,
		adresse: d.addressLine,
		postnummer: d.postalCode,
		poststed: d.city
	};
}

export type DetailsProblem =
	| { kind: 'error'; message: string }
	/** Savable, but only once the user has confirmed they mean it. */
	| { kind: 'confirm-identity'; message: string };

/**
 * What stands in the way of saving, or null. Messages are Norwegian: they are
 * shown as they stand.
 */
export function detailsProblem(d: PatientDetails, identityConfirmed: boolean): DetailsProblem | null {
	if (!d.given || !d.family) return { kind: 'error', message: 'Fornavn og etternavn må fylles ut.' };
	if (!/^\d{11}$/.test(d.nationalId)) {
		return { kind: 'error', message: 'Fødselsnummeret må være elleve siffer.' };
	}
	if (d.birthDate && !isRealDate(d.birthDate)) {
		return { kind: 'error', message: 'Fødselsdatoen er ikke en gyldig dato.' };
	}
	if (d.birthDate && d.birthDate > new Date().toISOString().slice(0, 10)) {
		return { kind: 'error', message: 'Fødselsdatoen kan ikke ligge fram i tid.' };
	}
	if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) {
		return { kind: 'error', message: 'E-postadressen ser ikke riktig ut.' };
	}
	if (d.postalCode && !/^\d{4}$/.test(d.postalCode)) {
		return { kind: 'error', message: 'Postnummeret må være fire siffer.' };
	}
	if (!validNorwegianNationalId(d.nationalId) && !identityConfirmed) {
		return {
			kind: 'confirm-identity',
			message:
				'Dette er ikke et gyldig fødselsnummer eller D-nummer: kontrollsifrene stemmer ikke. ' +
				'Du kan lagre likevel. Nummeret blir da merket som ikke gyldig, og brukes ikke mot Helfo, ' +
				'reseptformidleren eller i meldinger.'
		};
	}
	return null;
}

function isRealDate(iso: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
	const d = new Date(`${iso}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** The identifier a number is filed under: national when it checks out, the record's own when not. */
export function identifierFor(nationalId: string): { system: string; value: string; use: string } {
	return validNorwegianNationalId(nationalId)
		? { system: SYSTEM.FNR, value: nationalId, use: 'official' }
		: { system: SYSTEM.UNVERIFIED_NATIONAL_ID, value: nationalId, use: 'temp' };
}

/** A search value that finds the number under any of the systems it could be filed under. */
export function identitySearch(nationalId: string): string {
	return IDENTITY_SYSTEMS.map((system) => `${system}|${nationalId}`).join(',');
}

/** The patients who already have this number, as the user may see them. */
export async function patientsWithNationalId(ctx: AuthContext, nationalId: string): Promise<FhirResource[]> {
	return resources(await searchResources(ctx, 'Patient', { identifier: identitySearch(nationalId), _count: 5 }));
}

/** The number on a patient, under whichever system it was filed. */
export function nationalIdOf(patient: FhirResource): string {
	const identifiers = (patient.identifier as { system?: string; value?: string }[] | undefined) ?? [];
	return identifiers.find((i) => i.system && IDENTITY_SYSTEMS.includes(i.system))?.value ?? '';
}

type Named = { use?: string; family?: string; given?: string[] };
type Telecom = { system?: string; value?: string; use?: string };
type Address = { use?: string; line?: string[]; postalCode?: string; city?: string; country?: string };

/** The details a patient has now, for filling the form. */
export function detailsOf(patient: FhirResource): PatientDetails {
	const names = (patient.name as Named[] | undefined) ?? [];
	const name = names.find((n) => n.use === 'official') ?? names[0] ?? {};
	const telecom = (patient.telecom as Telecom[] | undefined) ?? [];
	const address = ((patient.address as Address[] | undefined) ?? [])[0] ?? {};
	const gender = String(patient.gender ?? '');
	return {
		nationalId: nationalIdOf(patient),
		given: (name.given ?? []).join(' '),
		family: name.family ?? '',
		birthDate: String(patient.birthDate ?? ''),
		gender: (GENDERS as readonly string[]).includes(gender) ? (gender as Gender) : '',
		phone: telecom.find((t) => t.system === 'phone')?.value ?? '',
		email: telecom.find((t) => t.system === 'email')?.value ?? '',
		addressLine: (address.line ?? []).join(', '),
		postalCode: address.postalCode ?? '',
		city: address.city ?? ''
	};
}

/**
 * The patient with the details written in.
 *
 * Changes what the form covers and leaves the rest of the resource as it was:
 * other identifiers, other names, a second phone number, a work address,
 * extensions, the general practitioner. A form that rewrote the resource from
 * its own fields would quietly delete everything it did not know about.
 *
 * Birth date and gender come from the form when given; otherwise from the
 * number when it is one they can be read from; otherwise they are left as they
 * were.
 */
export function applyDetails(patient: FhirResource, d: PatientDetails): FhirResource {
	const out: Record<string, unknown> = { ...patient };

	// Identity: replace whichever of the three the patient had, keep any other.
	const identifiers = ((patient.identifier as { system?: string }[] | undefined) ?? []).filter(
		(i) => !i.system || !IDENTITY_SYSTEMS.includes(i.system)
	);
	out.identifier = [identifierFor(d.nationalId), ...identifiers];

	// Name: the official one, or the first, is the one the form shows.
	const names = [...((patient.name as Named[] | undefined) ?? [])];
	const at = Math.max(0, names.findIndex((n) => n.use === 'official'));
	names[at] = { ...(names[at] ?? {}), use: 'official', family: d.family, given: d.given.split(/\s+/).filter(Boolean) };
	out.name = names;

	const valid = validNorwegianNationalId(d.nationalId);
	const birthDate = d.birthDate || (valid ? validDateDel(d.nationalId) : null) || (patient.birthDate as string | undefined);
	if (birthDate) out.birthDate = birthDate;
	else delete out.birthDate;

	const gender = d.gender || (valid ? genderFromNationalId(d.nationalId) : '') || (patient.gender as string | undefined);
	if (gender) out.gender = gender;

	// Contact: the first phone and the first email are the ones the form shows.
	out.telecom = withContact(
		withContact((patient.telecom as Telecom[] | undefined) ?? [], 'phone', d.phone ? compactPhone(d.phone) : '', 'mobile'),
		'email',
		d.email,
		undefined
	);
	if ((out.telecom as Telecom[]).length === 0) delete out.telecom;

	const addresses = [...((patient.address as Address[] | undefined) ?? [])];
	const hasAddress = Boolean(d.addressLine || d.postalCode || d.city);
	if (hasAddress) {
		addresses[0] = {
			...(addresses[0] ?? { use: 'home', country: 'NO' }),
			line: d.addressLine ? [d.addressLine] : undefined,
			postalCode: d.postalCode || undefined,
			city: d.city || undefined
		};
	} else if (addresses.length) {
		addresses.shift();
	}
	if (addresses.length) out.address = addresses;
	else delete out.address;

	return out as FhirResource;
}

function withContact(telecom: Telecom[], system: string, value: string, use: string | undefined): Telecom[] {
	const out = [...telecom];
	const at = out.findIndex((t) => t.system === system);
	if (value) {
		if (at >= 0) out[at] = { ...out[at], value };
		else out.push({ system, value, ...(use ? { use } : {}) });
	} else if (at >= 0) {
		out.splice(at, 1);
	}
	return out;
}

/** Which details differ, by the forms' field names. For the log: names, never values. */
export function changedFields(before: PatientDetails, after: PatientDetails): string[] {
	const a = detailsAsFormValues(before);
	const b = detailsAsFormValues(after);
	return Object.keys(b).filter((key) => {
		if (key === 'telefon') return compactPhone(a[key] ?? '') !== compactPhone(b[key] ?? '');
		// Left blank means "take it from the number", not "remove it".
		if ((key === 'fodselsdato' || key === 'kjonn') && !b[key]) return false;
		return (a[key] ?? '') !== (b[key] ?? '');
	});
}
