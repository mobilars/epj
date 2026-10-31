import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getCatalogueApp, installApp, installableApps, installsForTenant, uninstallApp } from '$srv/developer/catalogue';
import { describeScope } from '$srv/authz/scopes';
import { actorFromContext, log } from '$srv/audit';

/**
 * The app gallery, as a practice sees it.
 *
 * Apps the platform has approved appear here, then those still waiting for review,
 * which a practice may install if it confirms it knows that. Any installed app whose
 * approval was later withdrawn is listed too - those are blocked already, and shown
 * with the platform's reason so the practice knows. Installing one creates a
 * client in this organisation's own register - its own id, its own consent -
 * so two practices running the same app share nothing, and blocking it at one
 * leaves the other alone.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.permissions.has('admin:apper')) error(403, 'Ingen tilgang.');

	const [apps, installs] = await Promise.all([installableApps(), installsForTenant()]);
	const installed = new Map(installs.map((i) => [i.catalogue_id, i]));

	return {
		// Approved first: an app nobody has vetted should not be the first thing offered.
		apps: [...apps].sort((a, b) => Number(a.status !== 'godkjent') - Number(b.status !== 'godkjent')).map((a) => ({
			id: a.id,
			name: a.name,
			summary: a.summary,
			description: a.description,
			placement: a.placement,
			contactEmail: a.contact_email,
			privacyUrl: a.privacy_url,
			databehandleravtale: a.databehandleravtale,
			scopes: a.scopes.map((s) => ({ scope: s, description: describeScope(s) })),
			installed: installed.has(a.id),
			clientId: installed.get(a.id)?.client_id ?? null,
			// What this practice runs, or for an app it does not have, what is on offer.
			unapproved: installed.has(a.id) ? !installed.get(a.id)?.approved_copy : a.status === 'til-vurdering',
			// An approved copy is running, and the developer has sent in a change.
			changePending: Boolean(installed.get(a.id)?.approved_copy) && a.status === 'til-vurdering',
			// Set when the platform withdrew its approval after this practice
			// installed the app. The client is already blocked.
			withdrawn: a.status !== 'godkjent' && a.status !== 'til-vurdering',
			reviewNote: a.status !== 'godkjent' && a.status !== 'til-vurdering' ? (a.review_note ?? '') : ''
		}))
	};
};

export const actions: Actions = {
	installer: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const app = await getCatalogueApp(String(form.get('id') ?? ''));
		if (!app || (app.status !== 'godkjent' && app.status !== 'til-vurdering')) {
			return fail(404, { error: 'Appen er ikke tilgjengelig.' });
		}
		const unapproved = app.status !== 'godkjent';
		if (unapproved && form.get('bekreftet') !== 'ja') {
			return fail(400, { error: `Du må bekrefte at du vil installere ${app.name} uten at plattformeier har godkjent den.` });
		}

		const { clientId, secret } = await installApp(app, ctx.userId);
		await log(
			{
				type: 'admin',
				subtype: 'app:installert',
				action: 'C',
				outcome: '0',
				entityRef: `Device/${clientId}`,
				details: { app: app.name, fraKatalog: app.id, ikkeGodkjent: unapproved }
			},
			actorFromContext(ctx)
		);
		return { ok: true, name: app.name, clientId, secret, unapproved };
	},

	avinstaller: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const id = String(form.get('id') ?? '');
		await uninstallApp(id);
		await log(
			{ type: 'admin', subtype: 'app:avinstallert', action: 'D', outcome: '0', details: { fraKatalog: id } },
			actorFromContext(ctx)
		);
		redirect(303, '/admin/apper/galleri');
	}
};
