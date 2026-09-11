/**
 * Pre-registers the standard HelseID test persons.
 *
 * HelseID's test environment offers a fixed set of synthetic people to sign in
 * as. Registering them here, with a role each, is what makes a HelseID sign-in
 * useful: the account is otherwise created on first sign-in with no role at
 * all, and lands on "Kontoen mangler rolle".
 *
 * They are matched on the national identity number, not on HPR number. Two of
 * the seven are not health personnel and hold no HPR number - which is the
 * ordinary case for a medical secretary or an office manager, and the reason
 * the HPR number cannot be the way a person is recognised.
 *
 * The script is idempotent: run it as often as you like. It only ever adds the
 * accounts and their roles, and never touches an account somebody has signed
 * in with beyond filling in what was missing.
 *
 * Synthetic numbers from HelseID's own test set. They belong to no real person.
 */

import { exec, one, query } from '../src/lib/server/db';
import { ensureDefaultOrganisation, getTenant } from '../src/lib/server/tenant/tenant';
import { PLATFORM_TENANT, requireTenant, withTenant } from '../src/lib/server/tenant/context';
import { createUser } from '../src/lib/server/auth/users';
import { newId } from '../src/lib/server/util/ids';
import type { Role } from '../src/lib/server/authz/roles';

interface TestPerson {
	nationalId: string;
	name: string;
	username: string;
	/** What HelseID calls them, for the note in the user list. */
	profession: string;
	role: Role;
}

/** The practice's own staff. */
const PRACTICE: TestPerson[] = [
	{ nationalId: '05898597468', name: 'GRØNN VITS', username: 'gronn.vits', profession: 'Lege', role: 'behandler' },
	{ nationalId: '06828399789', name: 'KVART GREVLING', username: 'kvart.grevling', profession: 'Lege', role: 'behandler' },
	{ nationalId: '11857998857', name: 'VIRKELIG KJELTRING', username: 'virkelig.kjeltring', profession: 'Sykepleier', role: 'behandler' },
	{ nationalId: '15849197352', name: 'LIVSTRETT BEVER', username: 'livstrett.bever', profession: 'Vernepleier', role: 'behandler' },
	{ nationalId: '67865800174', name: 'DIREKTE HEI', username: 'direkte.hei', profession: 'Sykepleier', role: 'behandler' },
	{
		nationalId: '60838200624',
		name: 'VEIK LOGARITME',
		username: 'veik.logaritme',
		profession: 'Ikke helsepersonell',
		role: 'systemansvarlig'
	}
];

/**
 * The platform administrator sits in the platform organisation, not in the
 * practice, and is reached on the platform's own hostname. The role holds no
 * clinical scopes at all.
 */
const PLATFORM: TestPerson = {
	nationalId: '02037340726',
	// The account the seed script already creates. Giving it the identity number
	// means the same platform administrator can be reached both locally and
	// through HelseID, rather than there being two of them. The name is replaced
	// when the person first signs in: HelseID is the source of that.
	name: 'Plattformadministrator',
	username: 'systemeier',
	profession: 'Plattformadministrator',
	role: 'systemeier'
};

async function ensure(person: TestPerson): Promise<'created' | 'linked' | 'unchanged'> {
	const existing = await one<{ id: string }>('SELECT id FROM user_account WHERE national_id = $1 AND tenant_id = $2', [
		person.nationalId,
		requireTenant().id
	]);

	let userId = existing?.id;
	let outcome: 'created' | 'linked' | 'unchanged' = 'unchanged';

	if (!userId) {
		/**
		 * The account may already exist under another identifier:
		 *
		 *   - the username this script would use, from the ordinary seed;
		 *   - an account HelseID created on a sign-in made before the person was
		 *     registered here, which carries the name HelseID gave it.
		 *
		 * The name is only trusted for an account HelseID itself created, and
		 * never on its own: two people can share a name, and attaching an
		 * identity number to the wrong account would hand one person another
		 * person's access.
		 */
		const match = await one<{ id: string }>(
			`SELECT id FROM user_account
			 WHERE tenant_id = $1 AND national_id IS NULL
			   AND (username = $2 OR (name = $3 AND helseid_sub IS NOT NULL))
			 ORDER BY (username = $2) DESC
			 LIMIT 1`,
			[requireTenant().id, person.username, person.name]
		);
		if (match) {
			await exec('UPDATE user_account SET national_id = $2, updated_at = now() WHERE id = $1', [match.id, person.nationalId]);
			userId = match.id;
			outcome = 'linked';
		}
	}

	if (!userId) {
		const user = await createUser({ username: person.username, name: person.name, roles: [] });
		await exec('UPDATE user_account SET national_id = $2, must_change_password = false WHERE id = $1', [user.id, person.nationalId]);
		userId = user.id;
		outcome = 'created';
	}

	const roles = await query<{ role: string }>('SELECT role FROM role_assignment WHERE user_id = $1 AND valid_until IS NULL', [userId]);
	if (!roles.some((r) => r.role === person.role)) {
		await exec('INSERT INTO role_assignment (id, user_id, role, assigned_by) VALUES ($1,$2,$3,$4)', [
			newId(),
			userId,
			person.role,
			null
		]);
		if (outcome === 'unchanged') outcome = 'linked';
	}
	return outcome;
}

async function main(): Promise<void> {
	await ensureDefaultOrganisation();

	const tenantId = process.env.EPJ_SEED_TENANT ?? 'standard';
	const tenant = await getTenant(tenantId);
	if (!tenant) throw new Error(`Virksomheten «${tenantId}» finnes ikke. Kjør migrasjonene først.`);

	await withTenant(tenant, async () => {
		for (const person of PRACTICE) {
			const outcome = await ensure(person);
			console.log(`  ${person.nationalId}  ${person.name.padEnd(20)} ${person.role.padEnd(16)} ${outcome}`);
		}
	});

	const platform = await getTenant(PLATFORM_TENANT);
	if (platform) {
		await withTenant(platform, async () => {
			const outcome = await ensure(PLATFORM);
			console.log(`  ${PLATFORM.nationalId}  ${PLATFORM.name.padEnd(20)} ${PLATFORM.role.padEnd(16)} ${outcome} (plattform)`);
		});
	}
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err);
		process.exit(1);
	}
);
