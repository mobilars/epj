import { one } from '../db';
import { decrypt } from '../util/crypto';
import { requireTenant } from '../tenant/context';
import { totpCode } from './totp';

/**
 * The demo accounts.
 *
 * These exist only where `EPJ_TEST_LOGIN` and `EPJ_SHOW_DEMO_USERS` are on -
 * development, and reference installations such as epj.apps.apus.no. Both the
 * password and the one-time code are then handed out on the sign-in page, so
 * the accounts offer no protection at all. Neither flag belongs in an
 * installation holding real patient data.
 *
 * The seed script and the sign-in page read the same constants from here, so
 * the two cannot drift apart - the page used to claim the one-time code was
 * `000000`, which was the input's placeholder rather than any real code.
 */

export const DEMO_PASSWORD = 'Testpassord1!';

/** Fixed TOTP secret in the demo, so the code can always be computed. */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

export interface DemoUser {
	username: string;
	name: string;
	role: string;
}

export const DEMO_USERS: readonly DemoUser[] = [
	{ username: 'lege', name: 'Dr. Ingrid Fastlege', role: 'Lege' },
	{ username: 'sykepleier', name: 'Kari Sykepleier', role: 'Sykepleier' },
	{ username: 'sekretaer', name: 'Ola Helsesekretær', role: 'Helsesekretær' },
	{ username: 'admin', name: 'Systemansvarlig', role: 'Systemansvarlig' },
	{ username: 'ombud', name: 'Personvernombud', role: 'Personvernombud' }
];

export function isDemoUser(username: string): boolean {
	return DEMO_USERS.some((d) => d.username === username);
}

/**
 * The current one-time code for a demo account.
 *
 * Read from the account's own secret rather than from the constant above, so a
 * code is only ever handed out for an account that really is seeded as a demo
 * account in this organisation.
 */
export async function demoOneTimeCode(username: string): Promise<string | null> {
	if (!isDemoUser(username)) return null;
	const row = await one<{ totp_secret_enc: string | null }>(
		'SELECT totp_secret_enc FROM user_account WHERE username = $1 AND tenant_id = $2',
		[username, requireTenant().id]
	);
	if (!row?.totp_secret_enc) return null;
	return totpCode(decrypt(row.totp_secret_enc));
}
