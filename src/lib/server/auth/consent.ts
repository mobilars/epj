import { exec, one, query } from '../db';
import { requireTenant } from '../tenant/context';
import { newId } from '../util/ids';

/**
 * What a user has already agreed to give an app.
 *
 * Consent used to be asked on every launch. An app in the record's side panel
 * opens on every patient, so that was a dialog many times an hour - which is
 * not a decision anyone makes, but a thing people learn to click past. Asked
 * once and remembered, the question keeps its meaning, and it is asked again
 * precisely when the app wants something new.
 */

export interface StoredConsent {
	clientId: string;
	scopes: string;
	granted_at: string;
}

/** Every scope in `wanted` is covered by something already agreed. */
export async function alreadyConsented(userId: string, clientId: string, wanted: string): Promise<boolean> {
	const row = await one<{ scopes: string }>(
		'SELECT scopes FROM oauth_consent WHERE tenant_id = $1 AND user_id = $2 AND client_id = $3 AND revoked_at IS NULL',
		[requireTenant().id, userId, clientId]
	);
	if (!row) return false;
	const granted = new Set(row.scopes.split(/\s+/).filter(Boolean));
	return wanted
		.split(/\s+/)
		.filter(Boolean)
		.every((s) => granted.has(s));
}

/**
 * Records the agreement, or widens one that exists.
 *
 * The union, never a replacement: a launch asking for less than last time must
 * not quietly withdraw what the user agreed to before, and one asking for more
 * has just been shown the whole list.
 */
export async function rememberConsent(userId: string, clientId: string, scopes: string): Promise<void> {
	const tenantId = requireTenant().id;
	const row = await one<{ id: string; scopes: string }>(
		'SELECT id, scopes FROM oauth_consent WHERE tenant_id = $1 AND user_id = $2 AND client_id = $3 AND revoked_at IS NULL',
		[tenantId, userId, clientId]
	);
	const union = [...new Set([...(row?.scopes ?? '').split(/\s+/), ...scopes.split(/\s+/)].filter(Boolean))]
		.sort()
		.join(' ');

	if (row) {
		await exec('UPDATE oauth_consent SET scopes = $2, granted_at = now() WHERE id = $1', [row.id, union]);
		return;
	}
	await exec('INSERT INTO oauth_consent (id, tenant_id, user_id, client_id, scopes) VALUES ($1,$2,$3,$4,$5)', [
		newId(),
		tenantId,
		userId,
		clientId,
		union
	]);
}

export async function consentsFor(userId: string): Promise<StoredConsent[]> {
	return query<StoredConsent>(
		`SELECT client_id AS "clientId", scopes, granted_at
		 FROM oauth_consent
		 WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL
		 ORDER BY granted_at DESC`,
		[requireTenant().id, userId]
	);
}

/** Withdraws it. Tokens already issued are revoked by the caller. */
export async function revokeConsent(userId: string, clientId: string): Promise<void> {
	await exec(
		'UPDATE oauth_consent SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND client_id = $3 AND revoked_at IS NULL',
		[requireTenant().id, userId, clientId]
	);
}
