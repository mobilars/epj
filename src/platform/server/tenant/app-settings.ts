import { appManifests } from '$apps/registry';
import { exec, query, transaction } from '../db';

/**
 * Per-practice settings an app has declared in its manifest.
 *
 * The platform keeps them and draws the form, without knowing what they mean.
 * They live in `tenant_setting`, under a key naming the app, and an empty value
 * removes the setting.
 */

const prefix = (appId: string) => `app:${appId}:`;
const formName = (appId: string, key: string) => `setting-${appId}-${key}`;

const appsWithSettings = () => appManifests.filter((app) => app.practiceSettings?.length);

/** What one app has stored for one practice. */
export async function appSettings(tenantId: string, appId: string): Promise<Record<string, string>> {
	const rows = await query<{ key: string; value: string }>(
		'SELECT key, value FROM tenant_setting WHERE tenant_id = $1 AND starts_with(key, $2)',
		[tenantId, prefix(appId)]
	);
	return Object.fromEntries(rows.map((row) => [row.key.slice(prefix(appId).length), row.value]));
}

/** The fields to draw on the practice's page, one group per app. */
export async function practiceSettingsForm(tenantId: string) {
	return Promise.all(
		appsWithSettings().map(async (app) => {
			const stored = await appSettings(tenantId, app.id);
			return {
				app: app.name,
				fields: (app.practiceSettings ?? []).map((field) => ({
					name: formName(app.id, field.key),
					label: field.label,
					help: field.help,
					inputMode: field.inputMode,
					value: stored[field.key] ?? ''
				}))
			};
		})
	);
}

export interface SettingValue {
	key: string;
	value: string;
}

/** Reads the submitted form, and refuses it if a value is not what the app asked for. */
export function readPracticeSettings(
	read: (name: string) => string
): { ok: true; values: SettingValue[] } | { ok: false; error: string } {
	const values: SettingValue[] = [];
	for (const app of appsWithSettings()) {
		for (const field of app.practiceSettings ?? []) {
			const value = read(formName(app.id, field.key));
			if (value && !new RegExp(field.pattern).test(value)) return { ok: false, error: field.invalid };
			values.push({ key: prefix(app.id) + field.key, value });
		}
	}
	return { ok: true, values };
}

export async function storePracticeSettings(tenantId: string, values: SettingValue[], updatedBy: string | null): Promise<void> {
	await transaction(async () => {
		for (const { key, value } of values) {
			if (value) {
				await exec(
					`INSERT INTO tenant_setting (tenant_id, key, value, updated_by) VALUES ($1,$2,$3,$4)
					 ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
					[tenantId, key, value, updatedBy]
				);
			} else {
				await exec('DELETE FROM tenant_setting WHERE tenant_id = $1 AND key = $2', [tenantId, key]);
			}
		}
	});
}
