import { exec, one, query, transaction } from '../db';
import { newId } from '../util/ids';
import { registerClient, setPlacement, setReplacesTab, setRequireConsent, type Placement } from '../auth/clients';
import { requireTenant } from '../tenant/context';

/**
 * The catalogue: apps as their developers describe them, before any practice
 * has them.
 *
 * An entry here is a description, not an installation. A practice that
 * installs one gets an ordinary client in its own register, with its own
 * client id and its own secret if it needs one - so two practices running the
 * same app share nothing, and revoking it at one leaves the other alone. That
 * is also what keeps the blast radius of a bad app to the practices that chose
 * it.
 *
 * The status of an entry moves:
 *
 *   utkast        the developer is still working on it
 *   til-vurdering submitted, waiting for the platform
 *   godkjent      installable
 *   avvist        refused, with a reason the developer can read
 *
 * Editing an approved entry sends it back for review. What was approved was a
 * particular set of scopes and addresses, and an app that can change those
 * afterwards has not really been reviewed at all.
 */

export type CatalogueStatus = 'utkast' | 'til-vurdering' | 'godkjent' | 'avvist';

export interface CatalogueApp {
	id: string;
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
}

const FIELD = `id, developer_id, name, summary, description, launch_url, redirect_uris, scopes, placement,
	contact_email, privacy_url, databehandleravtale, status, review_note, reviewed_at, created_at, updated_at`;

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
			placement, contact_email, privacy_url, databehandleravtale)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		[
			id, developerId, inValue.name, inValue.summary, inValue.description, inValue.launchUrl,
			JSON.stringify(inValue.redirectUris), JSON.stringify(inValue.scopes), inValue.placement,
			inValue.contactEmail, inValue.privacyUrl, inValue.databehandleravtale
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
			 status = CASE status WHEN 'godkjent' THEN 'til-vurdering' WHEN 'avvist' THEN 'utkast' ELSE status END,
			 updated_at = now()
		 WHERE id = $1 AND developer_id = $2`,
		[
			id, developerId, inValue.name, inValue.summary, inValue.description, inValue.launchUrl,
			JSON.stringify(inValue.redirectUris), JSON.stringify(inValue.scopes), inValue.placement,
			inValue.contactEmail, inValue.privacyUrl, inValue.databehandleravtale
		]
	);
}

export async function submitApp(id: string, developerId: string): Promise<void> {
	await exec(
		"UPDATE catalogue_app SET status = 'til-vurdering', updated_at = now() WHERE id = $1 AND developer_id = $2 AND status IN ('utkast','avvist')",
		[id, developerId]
	);
}

export async function reviewApp(id: string, approved: boolean, note: string, reviewer: string | null): Promise<void> {
	await exec(
		`UPDATE catalogue_app
		 SET status = $2, review_note = $3, reviewed_at = now(), reviewed_by = $4, updated_at = now()
		 WHERE id = $1`,
		[id, approved ? 'godkjent' : 'avvist', note, reviewer]
	);
}

/** Approved apps, for a practice to choose from. */
export async function installableApps(): Promise<CatalogueApp[]> {
	return query<CatalogueApp>(`SELECT ${FIELD} FROM catalogue_app WHERE status = 'godkjent' ORDER BY name`);
}

export interface Install {
	catalogue_id: string;
	client_id: string;
	installed_at: string;
}

export async function installsForTenant(): Promise<Install[]> {
	return query<Install>('SELECT catalogue_id, client_id, installed_at FROM catalogue_install WHERE tenant_id = $1', [
		requireTenant().id
	]);
}

/**
 * Installs a catalogue app into the practice.
 *
 * The client is the practice's own: its own id, its own consent, its own
 * placement. What the catalogue supplies is the description and the addresses
 * the platform approved - and the scopes, which the practice cannot widen
 * beyond what was reviewed.
 */
export async function installApp(
	app: CatalogueApp,
	installedBy: string | null
): Promise<{ clientId: string; secret?: string }> {
	const tenantId = requireTenant().id;
	return transaction(async () => {
		const { client, secret } = await registerClient({
			name: app.name,
			type: 'public',
			category: 'smart-ehr',
			redirectUris: app.redirect_uris,
			scopes: app.scopes,
			launchUrl: app.launch_url,
			databehandleravtale: app.databehandleravtale,
			createdOf: installedBy ?? undefined
		});
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
		await setRequireConsent(client.client_id, true);
		await setReplacesTab(client.client_id, null);

		await exec(
			'INSERT INTO catalogue_install (id, catalogue_id, tenant_id, client_id, installed_by) VALUES ($1,$2,$3,$4,$5)',
			[newId(), app.id, tenantId, client.client_id, installedBy]
		);
		return { clientId: client.client_id, secret };
	});
}

export async function uninstallApp(catalogueId: string): Promise<void> {
	await exec('DELETE FROM catalogue_install WHERE catalogue_id = $1 AND tenant_id = $2', [
		catalogueId,
		requireTenant().id
	]);
}
