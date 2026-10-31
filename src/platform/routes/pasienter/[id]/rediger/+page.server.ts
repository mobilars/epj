import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { readResource, writeResource } from '$srv/fhir/internal';
import { maskerNationalId, validNorwegianNationalId } from '$srv/fhir/codesystems';
import { actorFromContext, log } from '$srv/audit';
import { requireTenant } from '$srv/tenant/context';
import { forgetPhoneTable } from '$srv/journal/phoneindex';
import {
	applyDetails,
	changedFields,
	detailsAsFormValues,
	detailsFromForm,
	detailsOf,
	detailsProblem,
	patientsWithNationalId
} from '$srv/journal/patientdetails';

/**
 * Correcting a patient's own details: name, identity number, birth date,
 * gender, phone, email, address.
 *
 * People move, change their name and their number, and a detail taken down at
 * the desk is sometimes wrong. The correction is an ordinary write through the
 * gateway: checked against the user's access like any other, kept as a new
 * version with the previous one intact, and logged with which details changed -
 * their names, never their values.
 *
 * Only what the form covers is changed. Everything else on the patient - other
 * identifiers, a second phone number, the general practitioner, extensions -
 * is carried over untouched.
 *
 * The same people who may register a patient may correct one.
 */

interface Form {
	error?: string;
	values?: Record<string, string>;
	duplicate?: { id: string; name: string };
	confirmIdentity?: string;
}

const PERMISSION = 'pasient:opprett';

export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, '/logg-inn');
	if (!ctx.permissions.has(PERMISSION)) error(403, 'Rollen din kan ikke endre pasientopplysninger.');

	const parent = await event.parent();
	if (!parent.patient) error(403, 'Du har ikke tilgang til denne journalen.');

	const patient = await readResource(ctx, 'Patient', event.params.id);
	const details = detailsOf(patient);
	return {
		values: detailsAsFormValues(details),
		unverified: Boolean(details.nationalId) && !validNorwegianNationalId(details.nationalId)
	};
};

export const actions: Actions = {
	default: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.permissions.has(PERMISSION)) {
			return fail(403, { error: 'Rollen din kan ikke endre pasientopplysninger.' } as Form);
		}

		const id = event.params.id;
		const form = await event.request.formData();
		const details = detailsFromForm(form);
		const values = detailsAsFormValues(details);
		const back = (message: string, extra: Partial<Form> = {}) =>
			fail(400, { error: message, values, ...extra } as Form);

		// Read as the user: no access, no correction.
		const current = await readResource(ctx, 'Patient', id);
		const before = detailsOf(current);

		// A number already saved as unverified does not need confirming again on
		// every later correction of something else. A different one does.
		const sameNumber = details.nationalId === before.nationalId;
		const problem = detailsProblem(details, sameNumber || form.get('bekreftUgyldig') === 'ja');
		if (problem?.kind === 'error') return back(problem.message);
		if (problem?.kind === 'confirm-identity') {
			return fail(400, { values, confirmIdentity: problem.message } as Form);
		}

		// Two records for one person is the mistake hardest to undo. A changed
		// number must not land on one somebody else already has.
		if (!sameNumber) {
			const others = (await patientsWithNationalId(ctx, details.nationalId)).filter((p) => p.id !== id);
			if (others.length) {
				const name = ((others[0].name as { family?: string; given?: string[] }[]) ?? [])[0];
				return back('En annen pasient er allerede registrert med dette nummeret.', {
					duplicate: {
						id: others[0].id as string,
						name: [name?.given?.join(' '), name?.family].filter(Boolean).join(' ') || 'Pasienten'
					}
				});
			}
		}

		const changed = changedFields(before, details);
		if (changed.length === 0) redirect(303, `/pasienter/${id}`);

		await writeResource(ctx, applyDetails(current, details), id);

		await log(
			{
				type: 'rest',
				subtype: 'pasient:endret',
				action: 'U',
				outcome: '0',
				patientId: id,
				entityRef: `Patient/${id}`,
				details: {
					// Which details, not what they were or became.
					changed: changed.join(' '),
					...(sameNumber
						? {}
						: {
								fodselsnummer: maskerNationalId(details.nationalId),
								unverified: !validNorwegianNationalId(details.nationalId)
							})
				}
			},
			actorFromContext(ctx)
		);

		// The phone number may be among what changed.
		forgetPhoneTable(requireTenant().id);
		redirect(303, `/pasienter/${id}`);
	}
};
