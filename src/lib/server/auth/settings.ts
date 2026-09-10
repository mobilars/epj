import { exec, one } from '../db';
import { requireTenant } from '../tenant/context';

/**
 * Per-user settings.
 *
 * Small choices that belong to a person rather than to a practice - which app
 * they keep in the side panel, and whatever else turns out to be worth
 * remembering. Deliberately free-form: a setting that needs validation or a
 * migration path is not a setting, it is a feature.
 */

export const SETTING = {
	/** Client id of the app in the narrow panel, or the record's own note editor. */
	SIDE_APP: 'sidepanel-app'
} as const;

export async function getSetting(userId: string, key: string): Promise<string | null> {
	const row = await one<{ value: string }>(
		'SELECT value FROM user_setting WHERE user_id = $1 AND key = $2 AND tenant_id = $3',
		[userId, key, requireTenant().id]
	);
	return row?.value ?? null;
}

export async function setSetting(userId: string, key: string, value: string): Promise<void> {
	await exec(
		`INSERT INTO user_setting (user_id, tenant_id, key, value) VALUES ($1,$2,$3,$4)
		 ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
		[userId, requireTenant().id, key, value]
	);
}

export async function clearSetting(userId: string, key: string): Promise<void> {
	await exec('DELETE FROM user_setting WHERE user_id = $1 AND key = $2 AND tenant_id = $3', [
		userId,
		key,
		requireTenant().id
	]);
}
