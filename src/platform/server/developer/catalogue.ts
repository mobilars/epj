import { exec, one, query, transaction } from '../db';
import { newId, newToken } from '../util/ids';
import { hashPassword } from '../util/crypto';
import { deleteClient, getClient, registerClient, setKlientstatus, setPlacement, setReplacesTab, setRequireConsent, type Placement } from '../auth/clients';
import { requireTenant } from '../tenant/context';

/**
 * The catalogue: apps as their developers describe them, before any practice
 * has them.
 *
 * An entry here is a description, not an installation. A practice that
 * installs one gets an ordinary client in its own register, with its own
 * consents, status and tokens - so revoking it at one leaves the other alone.
 * That is also what keeps the blast radius of a bad app to the practices that
 * chose it.
 *
 * The client id and the secret are the app's, the same in every practice. An app
 * serving many customers holds one registration, and learns which customer a launch
 * came from in the token, as `tenant` and `smart_app_officeApiUrl`. Every lookup of a
 * client is within a practice, so the shared id does not let one reach another.
 *
 * Platform apps are entries too, owned by the platform rather than a developer, and
 * managed in platform administration. They are approved as they stand, and a change
 * reaches the practices at once.
 *
 * The status of an entry moves:
 *
 *   utkast        the developer is still working on it
 *   til-vurdering submitted, waiting for the platform. A practice may install it,
 *                 having confirmed that it knows, and the app is marked as not
 *                 approved wherever it is shown
 *   godkjent      installable
 *   avvist        refused, with a reason the developer can read
 *
 * Editing an approved entry sends it back for review. What was approved was a
 * particular set of scopes and addresses, and an app that can change those
 * afterwards has not really been reviewed at all. So an edit reaches the practices
 * when it is approved, and until then they keep running the copy they have.
 */

export type CatalogueStatus = 'utkast' | 'til-vurdering' | 'godkjent' | 'avvist';

/** How an app proves who it is at the token endpoint. */
export type ClientType = 'public' | 'secret' | 'keys';

/** Owns the platform apps. Created by a migration, and cannot sign in. */
const PLATFORM_DEVELOPER = 'plattform-apus';

export interface CatalogueApp {
	id: string;
	/** The same in every practice that installs the app. */
	client_id: string;
	developer_id: string;
	name: string;
	summary: string;
	description: string;
	launch_url: string;
	redirect_uris: string[];
	scopes: string[];
	placement: string;
	contact_email: string;
	privacy_url: string;
	databehandleravtale: string;
	client_type: ClientType;
	secret_hash: string | null;
	jwks: { keys: unknown[] } | null;
	jwks_uri: string | null;
	is_platform_app: boolean;
	replaces_tab: string | null;
	status: CatalogueStatus;
	review_note: string | null;
	reviewed_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface AppInput {
	name: string;
	summary: string;
	description: string;
	launchUrl: string;
	redirectUris: string[];
	scopes: string[];
	placement: Placement;
	contactEmail: string;
	privacyUrl: string;
	databehandleravtale: string;
	clientType?: ClientType;
	jwks?: { keys: unknown[] } | null;
	jwksUri?: string | null;
	/** Platform apps only. */
	replacesTab?: string | null;
}

const FIELD = `id, client_id, developer_id, name, summary, description, launch_url, redirect_uris, scopes, placement,
	contact_email, privacy_url, databehandleravtale, client_type, secret_hash, jwks, jwks_uri, is_platform_app, replaces_tab,
	status, review_note, reviewed_at, created_at, updated_at`;

export async function appsForDeveloper(developerId: string): Promise<CatalogueApp[]> {
	return query<CatalogueApp>(`SELECT ${FIELD} FROM catalogue_app WHERE developer_id = $1 ORDER BY updated_at DESC`, [
		developerId
	]);
}

export async function getCatalogueApp(id: string): Promise<CatalogueApp | null> {
	return one<CatalogueApp>(`SELECT ${FIELD} FROM catalogue_app WHERE id = $1`, [id]);
}

export async function appsWithStatus(status: CatalogueStatus): Promise<CatalogueApp[]> {
	return query<CatalogueApp>(`SELECT ${FIELD} FROM catalogue_app WHERE status = $1 ORDER BY updated_at`, [status]);
}

export async function createApp(developerId: string, inValue: AppInput): Promise<string> {
	const id = newId();
	await exec(
		`INSERT INTO catalogue_app (id, developer_id, name, summary, description, launch_url, redirect_uris, scopes,
			placement, contact_email, privacy_url, databehandleravtale, client_type, jwks, jwks_uri)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
		[
			id, developerId, inValue.name, inValue.summary, inValue.description, inValue.launchUrl,
			JSON.stringify(inValue.redirectUris), JSON.stringify(inValue.scopes), inValue.placement,
			inValue.contactEmail, inValue.privacyUrl, inValue.databehandleravtale,
			inValue.clientType ?? 'public', inValue.jwks ? JSON.stringify(inValue.jwks) : null, inValue.jwksUri ?? null
		]
	);
	return id;
}

/**
 * Saves a change.
 *
 * An approved app goes back for review, because the approval was of these
 * scopes and these addresses. A refused one returns to draft, so the developer
 * can act on what the reason said.
 */
export async function updateApp(id: string, developerId: string, inValue: AppInput): Promise<void> {
	await exec(
		`UPDATE catalogue_app
		 SET name = $3, summary = $4, description = $5, launch_url = $6, redirect_uris = $7, scopes = $8,
			 placement = $9, contact_email = $10, privacy_url = $11, databehandleravtale = $12,
			 client_type = $13, jwks = $14, jwks_uri = $15,
			 status = CASE status WHEN 'godkjent' THEN 'til-vurdering' WHEN 'avvist' THEN 'utkast' ELSE status END,
			 updated_at = now()
		 WHERE id = $1 AND developer_id = $2`,
		[
			id, developerId, inValue.name, inValue.summary, inValue.description, inValue.launchUrl,
			JSON.stringify(inValue.redirectUris), JSON.stringify(inValue.scopes), inValue.placement,
			inValue.contactEmail, inValue.privacyUrl, inValue.databehandleravtale,
			inValue.clientType ?? 'public', inValue.jwks ? JSON.stringify(inValue.jwks) : null, inValue.jwksUri ?? null
		]
	);
}

/**
 * A new secret for an app, returned this once, and in force at once wherever the app
 * is already installed with a secret. Replacing a leaked one cannot wait for a review,
 * and it changes nothing about what the app may do.
 */
export async function newAppSecret(id: string, developerId: string): Promise<string | null> {
	const secret = newToken(32);
	const hash = hashPassword(secret);
	const changed = await exec(
		`UPDATE catalogue_app SET secret_hash = $3, updated_at = now()
		 WHERE id = $1 AND developer_id = $2 AND client_type = 'secret'`,
		[id, developerId, hash]
	);
	if (!changed) return null;
	await exec(
		`UPDATE oauth_client c SET secret_hash = $2
		 FROM catalogue_install i
		 WHERE i.catalogue_id = $1 AND c.tenant_id = i.tenant_id AND c.client_id = i.client_id
		   AND c.type = 'confidential' AND c.jwks IS NULL AND c.jwks_uri IS NULL`,
		[id, hash]
	);
	return secret;
}

/** A secret for an app set to use one that has none yet. Null when there is nothing to do. */
export async function firstAppSecret(id: string, developerId: string): Promise<string | null> {
	const app = await getCatalogueApp(id);
	return app?.client_type === 'secret' && !app.secret_hash ? newAppSecret(id, developerId) : null;
}

/**
 * Deletes an app, from the catalogue and from every practice that has it.
 *
 * Reaches across organisations like a withdrawal does, and further: the clients go too,
 * so it leaves nothing behind that could be switched back on. The security log keeps
 * what the app did. The caller logs the deletion in each practice this returns.
 */
export async function deleteApp(id: string, developerId: string): Promise<{ name: string; installs: { tenant_id: string; client_id: string }[] } | null> {
	return transaction(async () => {
		const app = await one<{ name: string }>('SELECT name FROM catalogue_app WHERE id = $1 AND developer_id = $2', [id, developerId]);
		if (!app) return null;
		const installs = await query<{ tenant_id: string; client_id: string }>(
			'SELECT tenant_id, client_id FROM catalogue_install WHERE catalogue_id = $1',
			[id]
		);
		for (const { tenant_id, client_id } of installs) {
			for (const table of ['oauth_token', 'oauth_authorization_code', 'smart_launch', 'oauth_consent', 'oauth_client']) {
				await exec(`DELETE FROM ${table} WHERE client_id = $1 AND tenant_id = $2`, [client_id, tenant_id]);
			}
		}
		await exec('DELETE FROM catalogue_app WHERE id = $1', [id]);
		return { name: app.name, installs };
	});
}

export const deletePlatformApp = (id: string) => deleteApp(id, PLATFORM_DEVELOPER);

/** What was approved is what runs. Where and how a practice shows the app stays its own. */
async function copyToInstalled(id: string): Promise<void> {
	await exec(
		`UPDATE oauth_client c
		 SET name = a.name, redirect_uris = a.redirect_uris, allowed_scopes = a.scopes,
			 launch_url = REPLACE(a.launch_url, '{client_id}', c.client_id),
			 type = CASE a.client_type WHEN 'public' THEN 'public' ELSE 'confidential' END,
			 require_pkce = a.client_type = 'public',
			 secret_hash = CASE a.client_type WHEN 'secret' THEN a.secret_hash END,
			 jwks = CASE a.client_type WHEN 'keys' THEN a.jwks END,
			 jwks_uri = CASE a.client_type WHEN 'keys' THEN a.jwks_uri END
		 FROM catalogue_install i
		 JOIN catalogue_app a ON a.id = i.catalogue_id
		 WHERE i.catalogue_id = $1 AND c.tenant_id = i.tenant_id AND c.client_id = i.client_id`,
		[id]
	);
	await exec('UPDATE catalogue_install SET approved_copy = true WHERE catalogue_id = $1', [id]);
}

export async function platformApps(): Promise<CatalogueApp[]> {
	return query<CatalogueApp>(`SELECT ${FIELD} FROM catalogue_app WHERE is_platform_app ORDER BY name`);
}

/** Adds or changes a platform app. The platform is its own reviewer, so it applies at once. */
export async function savePlatformApp(id: string | null, inValue: AppInput, savedBy: string | null): Promise<{ id: string; secret: string | null }> {
	return transaction(async () => {
		await exec(
			`INSERT INTO developer (id, email, name, organisation, status)
			 VALUES ($1, 'plattform@epj.invalid', 'APUS Roland AS', 'APUS Roland AS', 'sperret')
			 ON CONFLICT (id) DO NOTHING`,
			[PLATFORM_DEVELOPER]
		);
		const appId = id ?? (await createApp(PLATFORM_DEVELOPER, inValue));
		if (id) await updateApp(id, PLATFORM_DEVELOPER, inValue);
		await exec(
			`UPDATE catalogue_app
			 SET is_platform_app = true, replaces_tab = $2, status = 'godkjent', reviewed_at = now(), reviewed_by = $3
			 WHERE id = $1 AND developer_id = $4`,
			[appId, inValue.replacesTab ?? null, savedBy, PLATFORM_DEVELOPER]
		);
		const secret = await firstAppSecret(appId, PLATFORM_DEVELOPER);
		await copyToInstalled(appId);
		return { id: appId, secret };
	});
}

export async function submitApp(id: string, developerId: string): Promise<void> {
	await exec(
		"UPDATE catalogue_app SET status = 'til-vurdering', updated_at = now() WHERE id = $1 AND developer_id = $2 AND status IN ('utkast','avvist')",
		[id, developerId]
	);
}

/**
 * Records the platform's decision.
 *
 * Withdrawing an approval reaches every practice that installed the app: the
 * installed clients are blocked and their tokens revoked, across
 * organisations. That is the point of a platform review - an app found to
 * misbehave has to stop everywhere at once, not practice by practice as each
 * administrator hears of it. The install rows stay, so a practice can see
 * what happened and why.
 */
export async function reviewApp(id: string, approved: boolean, note: string, reviewer: string | null): Promise<void> {
	await transaction(async () => {
		await exec(
			`UPDATE catalogue_app
			 SET status = $2, review_note = $3, reviewed_at = now(), reviewed_by = $4, updated_at = now()
			 WHERE id = $1`,
			[id, approved ? 'godkjent' : 'avvist', note, reviewer]
		);
		if (approved) {
			// A practice may have installed this before the review, and the developer
			// may have edited it since.
			await copyToInstalled(id);
		} else {
			// Deliberately across organisations: the platform is the one caller
			// that may reach into every practice's client register for this.
			await exec(
				`UPDATE oauth_client SET status = 'sperret'
				 WHERE (tenant_id, client_id) IN (SELECT tenant_id, client_id FROM catalogue_install WHERE catalogue_id = $1)`,
				[id]
			);
			await exec(
				`UPDATE oauth_token SET revoked = true, revoked_reason = 'appen trukket tilbake av plattformen'
				 WHERE revoked = false
				   AND (tenant_id, client_id) IN (SELECT tenant_id, client_id FROM catalogue_install WHERE catalogue_id = $1)`,
				[id]
			);
		}
	});
}

/** How many practices have each app installed, for the platform's review page. */
export async function installCounts(): Promise<Map<string, number>> {
	const rows = await query<{ catalogue_id: string; n: string }>(
		'SELECT catalogue_id, count(*)::text AS n FROM catalogue_install GROUP BY catalogue_id'
	);
	return new Map(rows.map((r) => [r.catalogue_id, Number(r.n)]));
}

/**
 * What the practice's gallery shows: every approved app, every app waiting for
 * review, plus any app this practice installed that has since lost its approval.
 * The last has already been blocked; it stays listed so the administrator learns
 * why, instead of finding the app gone and the users asking.
 */
export async function installableApps(): Promise<CatalogueApp[]> {
	return query<CatalogueApp>(
		`SELECT ${FIELD} FROM catalogue_app
		 WHERE status IN ('godkjent', 'til-vurdering')
		    OR id IN (SELECT catalogue_id FROM catalogue_install WHERE tenant_id = $1)
		 ORDER BY name`,
		[requireTenant().id]
	);
}

/**
 * Who made the apps this practice installed from the catalogue, by client id. An
 * app registered directly by the practice has no developer on record.
 */
export async function publishersForTenant(): Promise<Map<string, { publisher: string | null; contactEmail: string | null }>> {
	const rows = await query<{ client_id: string; organisation: string; name: string; contact_email: string }>(
		`SELECT i.client_id, d.organisation, d.name, a.contact_email
		 FROM catalogue_install i
		 JOIN catalogue_app a ON a.id = i.catalogue_id
		 JOIN developer d ON d.id = a.developer_id
		 WHERE i.tenant_id = $1`,
		[requireTenant().id]
	);
	return new Map(
		rows.map((row) => [
			row.client_id,
			{ publisher: row.organisation || row.name || null, contactEmail: row.contact_email || null }
		])
	);
}

/**
 * The apps in this practice the platform owner has not approved.
 *
 * Asked rather than stored, so the marking goes away by itself the moment the
 * platform owner approves an app.
 */
export async function unapprovedClients(): Promise<Set<string>> {
	const rows = await query<{ client_id: string }>(
		`SELECT c.client_id
		 FROM oauth_client c
		 LEFT JOIN catalogue_install i ON i.tenant_id = c.tenant_id AND i.client_id = c.client_id
		 WHERE c.tenant_id = $1 AND i.approved_copy IS NOT TRUE`,
		[requireTenant().id]
	);
	return new Set(rows.map((row) => row.client_id));
}

/**
 * Whether a practice may switch this app back on.
 *
 * An app the platform withdrew has to stay off, and so does one removed from the
 * practice: its client stays behind for the log's sake, and switching that on would
 * bring the app back outside the catalogue.
 */
export async function mayBeActivated(clientId: string): Promise<boolean> {
	const row = await one<{ ok: boolean }>(
		`SELECT a.status IN ('godkjent', 'til-vurdering') AS ok
		 FROM catalogue_install i
		 JOIN catalogue_app a ON a.id = i.catalogue_id
		 WHERE i.client_id = $1 AND i.tenant_id = $2`,
		[clientId, requireTenant().id]
	);
	return row?.ok === true;
}

/**
 * Whether a practice may delete this app from its register: one it added itself, or
 * one it has removed. An installed app is removed through the gallery first, so the
 * installation and the platform's view of it stay in step.
 */
export async function mayBeDeleted(clientId: string): Promise<boolean> {
	const installed = await one<{ id: string }>('SELECT id FROM catalogue_install WHERE client_id = $1 AND tenant_id = $2', [
		clientId,
		requireTenant().id
	]);
	return !installed;
}

export interface Install {
	catalogue_id: string;
	client_id: string;
	installed_at: string;
	approved_copy: boolean;
}

export async function installsForTenant(): Promise<Install[]> {
	return query<Install>('SELECT catalogue_id, client_id, installed_at, approved_copy FROM catalogue_install WHERE tenant_id = $1', [
		requireTenant().id
	]);
}

/**
 * Installs a catalogue app into the practice.
 *
 * The client is the practice's own: its own consent, its own placement. What
 * the catalogue supplies is the id, the description and the addresses the platform
 * approved - and the scopes, which the practice cannot widen beyond what was reviewed.
 *
 * An earlier removal left a blocked client under this id. Installing again is a new
 * decision, so it goes, with the consents and the revoked tokens that belonged to it.
 */
export async function installApp(
	app: CatalogueApp,
	installedBy: string | null
): Promise<{ clientId: string }> {
	const tenantId = requireTenant().id;
	return transaction(async () => {
		if ((await getClient(app.client_id))?.status === 'sperret') await deleteClient(app.client_id);
		const { client } = await registerClient({
			clientId: app.client_id,
			name: app.name,
			type: app.client_type === 'public' ? 'public' : 'confidential',
			category: 'smart-ehr',
			redirectUris: app.redirect_uris,
			scopes: app.scopes,
			launchUrl: app.launch_url,
			databehandleravtale: app.databehandleravtale,
			jwks: app.client_type === 'keys' ? (app.jwks as never) ?? undefined : undefined,
			jwksUri: app.client_type === 'keys' ? app.jwks_uri ?? undefined : undefined,
			createdOf: installedBy ?? undefined
		});
		// The secret is the app's, held by its developer, not a new one for this practice.
		if (app.client_type === 'secret') {
			await exec('UPDATE oauth_client SET secret_hash = $2 WHERE client_id = $1 AND tenant_id = $3', [
				client.client_id,
				app.secret_hash,
				tenantId
			]);
		}
		// The launch URL carries the client id when the app expects it, the way
		// the first-party apps do: one static app, several record systems.
		if (app.launch_url.includes('{client_id}')) {
			await exec('UPDATE oauth_client SET launch_url = $2 WHERE client_id = $1 AND tenant_id = $3', [
				client.client_id,
				app.launch_url.replace('{client_id}', client.client_id),
				tenantId
			]);
		}
		if (app.placement !== 'ingen') await setPlacement(client.client_id, app.placement as Placement);
		// A newly installed app asks each user, until the practice decides
		// otherwise. Installing is the practice's decision that the app may be
		// offered - not that everyone has agreed to it.
		// A platform app in a fixed place opens on every patient, where a dialog on
		// every patient is not a decision anyone makes.
		await setRequireConsent(client.client_id, !app.is_platform_app || (app.placement === 'ingen' && !app.replaces_tab));
		await setReplacesTab(client.client_id, app.is_platform_app ? app.replaces_tab : null);

		await exec(
			'INSERT INTO catalogue_install (id, catalogue_id, tenant_id, client_id, installed_by, approved_copy) VALUES ($1,$2,$3,$4,$5,$6)',
			[newId(), app.id, tenantId, client.client_id, installedBy, app.status === 'godkjent']
		);
		return { clientId: client.client_id };
	});
}

/**
 * Removes the app from the practice.
 *
 * The client it installed is blocked and its tokens revoked, not deleted: the
 * security log refers to it by id, and an id that no longer resolves to
 * anything makes those entries unreadable. What the app did while installed
 * stays on record; what it can do from now on is nothing.
 */
export async function uninstallApp(catalogueId: string): Promise<void> {
	const tenantId = requireTenant().id;
	await transaction(async () => {
		const install = await one<{ client_id: string }>(
			'SELECT client_id FROM catalogue_install WHERE catalogue_id = $1 AND tenant_id = $2',
			[catalogueId, tenantId]
		);
		if (install) await setKlientstatus(install.client_id, 'sperret');
		await exec('DELETE FROM catalogue_install WHERE catalogue_id = $1 AND tenant_id = $2', [catalogueId, tenantId]);
	});
}
