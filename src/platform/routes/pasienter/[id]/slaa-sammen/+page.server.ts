import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { movePatientInApps } from '$apps/registry.server';
import { actorFromContext, log } from '$srv/audit';
import { maskerNationalId, validNorwegianNationalId } from '$srv/fhir/codesystems';
import { fhirClient } from '$srv/fhir/client';
import { readResource } from '$srv/fhir/internal';
import { mayJoinPatient } from '$srv/journal/care-relationship';
import { keptPatientFor, mergeCandidate, mergePatients } from '$srv/journal/patient-merge';
import { nationalIdOf, patientsWithNationalId } from '$srv/journal/patientdetails';
import { forgetPhoneTable } from '$srv/journal/phoneindex';
import { requireTenant } from '$srv/tenant/context';
import { errorForLog } from '$srv/util/error-log';

/**
 * Joining a record registered twice into this one.
 *
 * Offers what has the same fødselsnummer, and can look up another number, for someone
 * registered once under a wrong one. Merging two different people is the worst mistake
 * available here, so it takes a reason, a confirmation, and a second one if the numbers
 * differ. The number is sent by POST, since it does not belong in an address.
 */

const PERMISSION = 'pasient:slaa-sammen';

async function candidates(ctx: NonNullable<App.Locals['auth']>, keptId: string, number: string, ownNumber: string) {
	const found = number ? (await patientsWithNationalId(number)).filter((p) => p.id !== keptId) : [];
	const usable = [];
	for (const patient of found) {
		// A patient who has blocked this user is not theirs to touch, or to know of.
		if (await mayJoinPatient(ctx, patient.id as string)) usable.push(await mergeCandidate(patient, ownNumber));
	}
	return usable;
}

export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.permissions.has(PERMISSION)) error(403, 'Rollen din kan ikke slå sammen pasienter.');
	const parent = await event.parent();
	if (!parent.patient) return { self: null, sameNumber: [] };

	// As the user: without access to this record, nothing is offered.
	const self = await readResource(ctx, 'Patient', event.params.id);
	const number = nationalIdOf(self);
	return {
		self: await mergeCandidate(self, number),
		sameNumber: await candidates(ctx, event.params.id, number, number)
	};
};

export const actions: Actions = {
	finn: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has(PERMISSION)) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const number = String(form.get('fodselsnummer') ?? '').replace(/\s/g, '');
		if (!/^\d{11}$/.test(number)) return fail(400, { error: 'Skriv elleve siffer.' });

		const self = await readResource(ctx, 'Patient', event.params.id);
		const found = await candidates(ctx, event.params.id, number, nationalIdOf(self));
		await log(
			{
				type: 'rest',
				subtype: 'pasientsøk',
				action: 'E',
				outcome: '0',
				details: { type: 'fødselsnummer', formaal: 'sammenslåing', match: found.length }
			},
			actorFromContext(ctx)
		);
		return { found, searched: maskerNationalId(number), invalidNumber: !validNorwegianNationalId(number) };
	},

	slaaSammen: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has(PERMISSION)) return fail(403, { error: 'Ingen tilgang.' });
		const keptId = event.params.id;
		const form = await event.request.formData();
		const mergedId = String(form.get('annen') ?? '');
		const reason = String(form.get('arsak') ?? '').trim();

		if (!/^[A-Za-z0-9.-]{1,64}$/.test(mergedId) || mergedId === keptId) return fail(400, { error: 'Ugyldig pasient.' });
		if (reason.length < 10) return fail(400, { error: 'Skriv hvorfor journalene slås sammen (minst ti tegn).' });
		if (form.get('bekreftet') !== 'ja') return fail(400, { error: 'Du må bekrefte at dette er samme person.' });
		if (!(await mayJoinPatient(ctx, mergedId))) return fail(403, { error: 'Du kan ikke slå sammen med denne pasienten.' });
		if (await keptPatientFor(mergedId)) return fail(400, { error: 'Denne journalen er allerede slått sammen.' });

		const kept = await readResource(ctx, 'Patient', keptId);
		const merged = await fhirClient.read('Patient', mergedId).catch(() => null);
		if (!merged) return fail(404, { error: 'Fant ikke pasienten.' });

		const [keptNumber, mergedNumber] = [nationalIdOf(kept), nationalIdOf(merged)];
		const sameNumber = Boolean(keptNumber) && keptNumber === mergedNumber;
		if (!sameNumber && form.get('bekreftUlikt') !== 'ja') {
			return fail(400, { error: 'Journalene har ulikt fødselsnummer. Bekreft at du har kontrollert at det er samme person.' });
		}

		let moved: number;
		try {
			({ moved } = await mergePatients(ctx, { keptId, mergedId, reason, moveInApps: movePatientInApps }));
		} catch (err) {
			console.error('[sammenslåing] feilet', errorForLog(err));
			return fail(500, {
				error: 'Sammenslåingen ble ikke fullført. Noen oppføringer kan være flyttet, men ingenting er tapt. Prøv igjen.'
			});
		}

		// In the log of both, which is where someone will look for either.
		for (const [patientId, other] of [[keptId, mergedId], [mergedId, keptId]]) {
			await log(
				{
					type: 'rest',
					subtype: 'pasient:slatt-sammen',
					action: 'U',
					outcome: '0',
					patientId,
					entityRef: `Patient/${patientId}`,
					details: {
						beholdt: keptId,
						sammenslatt: mergedId,
						annen: other,
						arsak: reason,
						flyttet: moved,
						sammeFodselsnummer: sameNumber,
						...(mergedNumber ? { fodselsnummerSammenslatt: maskerNationalId(mergedNumber) } : {})
					}
				},
				actorFromContext(ctx)
			);
		}

		forgetPhoneTable(requireTenant().id);
		redirect(303, `/pasienter/${keptId}`);
	}
};
