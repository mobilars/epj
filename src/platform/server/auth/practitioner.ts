import { exec, one, transaction } from '../db';
import { fhirClient } from '../fhir/client';
import { SYSTEM } from '../fhir/codesystems';
import { errorForLog } from '../util/error-log';
import type { Role } from '../authz/roles';
import type { User } from './users';

/**
 * The Practitioner a clinician signs as, created the first time it is needed.
 *
 * Everything a clinician writes names them by this resource: the author of a note,
 * the provider on a billing card, `fhirUser` for an app. An account made without one,
 * as from a HelseID sign-in, would otherwise write references to nobody.
 *
 * Only for `behandler`: nobody else writes to a record as its author. A failure here
 * must not stop anyone signing in, so it leaves the account as it was and is tried
 * again on the next request.
 */
export async function ensurePractitioner(user: User, roles: Role[]): Promise<string | null> {
	if (user.practitioner_id) return user.practitioner_id;
	if (!roles.includes('behandler')) return null;
	try {
		return await transaction(async () => {
			// One sign-in often makes several requests at once, and each must not make its own.
			await one('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [user.id]);
			const current = await one<{ practitioner_id: string | null }>('SELECT practitioner_id FROM user_account WHERE id = $1', [user.id]);
			if (current?.practitioner_id) return current.practitioner_id;

			const id = (await practitionerWithHpr(user.hpr_number)) ?? (await createPractitioner(user));
			await exec('UPDATE user_account SET practitioner_id = $2, updated_at = now() WHERE id = $1', [user.id, id]);
			return id;
		});
	} catch (err) {
		console.error('[auth] could not create a Practitioner for user', user.id, errorForLog(err));
		return null;
	}
}

/** HPR-nummer: the national register number of health personnel. It names one person. */
async function practitionerWithHpr(hprNumber: string | null): Promise<string | null> {
	if (!hprNumber) return null;
	const bundle = await fhirClient.search('Practitioner', new URLSearchParams({ identifier: `${SYSTEM.HPR}|${hprNumber}` }));
	return (bundle.entry?.[0]?.resource?.id as string | undefined) ?? null;
}

async function createPractitioner(user: User): Promise<string> {
	const created = await fhirClient.create({
		resourceType: 'Practitioner',
		active: true,
		...(user.hpr_number ? { identifier: [{ system: SYSTEM.HPR, value: user.hpr_number }] } : {}),
		name: [{ text: user.name }]
	});
	return created.resource.id as string;
}
