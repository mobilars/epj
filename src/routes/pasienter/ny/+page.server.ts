import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { searchResources, writeResource, resources } from '$srv/fhir/internal';
import {
	SYSTEM,
	genderFromNationalId,
	isDNumber,
	maskerNationalId,
	validDateDel,
	validNorwegianNationalId
} from '$srv/fhir/codesystems';
import { log, actorFromContext } from '$srv/audit';
import { exec } from '$srv/db';
import { requireTenant } from '$srv/tenant/context';
import { newId } from '$srv/util/ids';

/**
 * Registering a patient.
 *
 * A search that finds nobody is the ordinary way in: a new patient turns up at
 * the desk, is not in the record, and has to be put there. The form is reached
 * from the empty search result with the search term carried over.
 *
 * Two things happen together, and both matter:
 *
 *   - The Patient resource is created in FHIR.
 *   - A care relationship is recorded for whoever registered them. Without it
 *     the person who just created the record could not open it, since access
 *     rests on a documented relationship rather than on having been the author.
 *
 * The national identity number is checked against its own check digits before
 * anything is written, and the register is searched for it first: two records
 * for the same person is the mistake that is hardest to undo afterwards.
 */

interface Form {
	error?: string;
	values?: Record<string, string>;
	duplicate?: { id: string; name: string };
}

export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	if (!ctx.permissions.has('pasient:opprett')) {
		error(403, 'Rollen din kan ikke registrere nye pasienter.');
	}

	// Carried over from the search, so what was typed there is not typed again.
	const from = (event.url.searchParams.get('sok') ?? '').trim();
	const isNationalId = /^\d{11}$/.test(from);
	return {
		nationalId: isNationalId ? from : '',
		name: isNationalId ? '' : from
	};
};

export const actions: Actions = {
	default: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('pasient:opprett')) {
			return fail(403, { error: 'Rollen din kan ikke registrere nye pasienter.' } as Form);
		}

		const form = await event.request.formData();
		const text = (name: string) => String(form.get(name) ?? '').trim();
		const nationalId = text('fodselsnummer').replace(/\s/g, '');
		const family = text('etternavn');
		const given = text('fornavn');
		const values = {
			fodselsnummer: nationalId,
			etternavn: family,
			fornavn: given,
			telefon: text('telefon'),
			adresse: text('adresse'),
			postnummer: text('postnummer'),
			poststed: text('poststed')
		};
		const back = (message: string, extra: Partial<Form> = {}) =>
			fail(400, { error: message, values, ...extra } as Form);

		if (!family || !given) return back('Fornavn og etternavn må fylles ut.');
		if (!validNorwegianNationalId(nationalId)) {
			return back('Ugyldig fødselsnummer eller D-nummer (kontrollsiffer stemmer ikke).');
		}

		// Look before writing. The search runs as the user, so a hit they may not
		// see is reported without saying who it is - see below.
		const existing = resources(
			await searchResources(ctx, 'Patient', { identifier: `${SYSTEM.FNR}|${nationalId}`, _count: 1 })
		);
		if (existing.length) {
			const patient = existing[0];
			const name = ((patient.name as { family?: string; given?: string[] }[]) ?? [])[0];
			return back('Pasienten er allerede registrert.', {
				duplicate: {
					id: patient.id as string,
					name: [name?.given?.join(' '), name?.family].filter(Boolean).join(' ') || 'Pasienten'
				}
			});
		}

		const birthDate = validDateDel(nationalId) ?? undefined;
		const created = await writeResource(ctx, {
			resourceType: 'Patient',
			identifier: [{ system: SYSTEM.FNR, value: nationalId, use: 'official' }],
			active: true,
			name: [{ use: 'official', family, given: [given] }],
			gender: genderFromNationalId(nationalId),
			birthDate,
			...(values.telefon ? { telecom: [{ system: 'phone', value: values.telefon, use: 'mobile' }] } : {}),
			...(values.adresse || values.postnummer || values.poststed
				? {
						address: [
							{
								use: 'home',
								...(values.adresse ? { line: [values.adresse] } : {}),
								...(values.postnummer ? { postalCode: values.postnummer } : {}),
								...(values.poststed ? { city: values.poststed } : {}),
								country: 'NO'
							}
						]
					}
				: {})
		});
		const patientId = created.id as string;

		// The relationship is what gives access to the record afterwards, and it
		// is recorded as its own fact - not inferred from having created it.
		await exec('INSERT INTO care_relationship (id, tenant_id, user_id, patient_id, basis) VALUES ($1,$2,$3,$4,$5)', [
			newId(),
			requireTenant().id,
			ctx.userId,
			patientId,
			'registrering'
		]);

		await log(
			{
				type: 'rest',
				subtype: 'pasient:registrert',
				action: 'C',
				outcome: '0',
				entityRef: `Patient/${patientId}`,
				// The number is masked in the log: it identifies the person directly,
				// and the reference above already says which record this concerns.
				details: { fodselsnummer: maskerNationalId(nationalId), dNumber: isDNumber(nationalId) }
			},
			actorFromContext(ctx)
		);

		redirect(303, `/pasienter/${patientId}`);
	}
};
