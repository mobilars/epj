import { describe, expect, it } from 'vitest';
import { appManifests } from '../src/apps/registry';
import { canEmergencyAccess, canSeeAllPatients, permissionsForRoles, PLATFORM_PERMISSIONS, ROLES } from '../src/platform/server/authz/roles';

/**
 * Exactly what each role may do, written out by hand.
 *
 * The permissions are put together from the platform and from each app's manifest,
 * so a change in one manifest changes who may do what without any file about access
 * being touched. This table is what has to change with it, on purpose.
 */
const EXPECTED: Record<(typeof ROLES)[number], string[]> = {
	behandler: [
		'journal:les', 'journal:rett', 'journal:signer', 'journal:skriv', 'journal:slett-begjaering', 'journal:utlever',
		'logg:innsyn', 'melding:les', 'melding:send', 'melding:signer', 'oppgjor:registrer', 'pasient:opprett',
		'pasient:sperr', 'resept:fornye', 'resept:forskriv', 'time:administrer'
	],
	lab: ['journal:les', 'journal:skriv', 'melding:les'],
	resepsjon: [
		'journal:les', 'journal:utlever', 'melding:les', 'oppgjor:registrer', 'oppgjor:send', 'pasient:opprett',
		'time:administrer'
	],
	systemansvarlig: ['admin:apper', 'admin:brukere', 'admin:logg', 'admin:system', 'logg:innsyn'],
	pasient: ['journal:utlever', 'logg:innsyn'],
	systemeier: ['plattform:administrer']
};

describe('role permissions', () => {
	it.each(ROLES)('%s has exactly the permissions it should', (role) => {
		expect([...permissionsForRoles([role])].sort()).toEqual([...EXPECTED[role]].sort());
	});

	it('only behandler can use emergency access, and no role sees every patient', () => {
		expect(ROLES.filter((role) => canEmergencyAccess([role]))).toEqual(['behandler']);
		expect(ROLES.filter((role) => canSeeAllPatients([role]))).toEqual([]);
	});

	it('an app declares only its own permissions, and only for staff in the record', () => {
		const declared = appManifests.flatMap((app) => app.permissions ?? []);
		const ids = declared.map((permission) => permission.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(PLATFORM_PERMISSIONS as readonly string[]).not.toContain(id);
		for (const permission of declared) {
			for (const role of permission.roles) expect(['behandler', 'lab', 'resepsjon']).toContain(role);
		}
	});

	it('every permission a main menu entry asks for exists', () => {
		const known = new Set(ROLES.flatMap((role) => [...permissionsForRoles([role])] as string[]));
		for (const app of appManifests) {
			for (const permission of app.mainMenu?.anyOf ?? []) expect(known.has(permission), `${app.id}: ${permission}`).toBe(true);
		}
	});
});
