import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { appsWithStatus, deletePlatformApp, getCatalogueApp, installCounts, platformApps, reviewApp, savePlatformApp } from '$srv/developer/catalogue';
import { readAppForm } from '$srv/developer/app-form';
import { listDevelopers } from '$srv/developer/developer';
import { describeScope } from '$srv/authz/scopes';
import { actorFromContext, log } from '$srv/audit';
import { sendEmail } from '$srv/util/smtp';

/**
 * Reviewing apps submitted to the catalogue.
 *
 * What is being judged is not code quality - we cannot see the code - but the
 * claim: does the description match what the app asks for, are the addresses
 * the ones it really uses, and is the smallest set of scopes being requested
 * rather than the most convenient one. An app that asks for everything and
 * explains nothing is refused, and told why.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.permissions.has('plattform:administrer')) error(403, 'Ingen tilgang.');

	const [waiting, approved, refused, developers, installs, platform] = await Promise.all([
		appsWithStatus('til-vurdering'),
		appsWithStatus('godkjent'),
		appsWithStatus('avvist'),
		listDevelopers(),
		installCounts(),
		platformApps()
	]);
	const byId = new Map(developers.map((d) => [d.id, d]));
	const shape = (list: Awaited<ReturnType<typeof appsWithStatus>>) =>
		list.map((a) => ({
			id: a.id,
			clientId: a.client_id,
			name: a.name,
			summary: a.summary,
			description: a.description,
			launchUrl: a.launch_url,
			redirectUris: a.redirect_uris,
			scopes: a.scopes.map((s) => ({ scope: s, description: describeScope(s) })),
			scopeText: a.scopes.join(' '),
			clientType: a.client_type,
			hasSecret: Boolean(a.secret_hash),
			jwksUri: a.jwks_uri ?? '',
			jwksText: a.jwks ? JSON.stringify(a.jwks, null, 1) : '',
			replacesTab: a.replaces_tab ?? '',
			status: a.status,
			placement: a.placement,
			contactEmail: a.contact_email,
			privacyUrl: a.privacy_url,
			databehandleravtale: a.databehandleravtale,
			reviewNote: a.review_note,
			installs: installs.get(a.id) ?? 0,
			developer: byId.get(a.developer_id)?.email ?? 'ukjent',
			developerName: byId.get(a.developer_id)?.name ?? '',
			organisation: byId.get(a.developer_id)?.organisation ?? ''
		}));

	return {
		waiting: shape(waiting),
		// Platform apps have their own section, and are nobody else's to review.
		approved: shape(approved.filter((a) => !a.is_platform_app)),
		refused: shape(refused.filter((a) => !a.is_platform_app)),
		platform: shape(platform),
		developers: developers.filter((d) => d.id !== 'plattform-apus').map((d) => ({
			email: d.email,
			name: d.name,
			organisation: d.organisation,
			status: d.status,
			lastLogin: d.last_login ? new Date(d.last_login).toLocaleString('nb-NO') : null
		}))
	};
};

export const actions: Actions = {
	/** Adds or changes one of the platform's own apps. Reaches the practices at once. */
	plattformapp: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const parsed = readAppForm(form);
		if (!parsed.value) return fail(400, { error: parsed.error });
		const id = String(form.get('id') ?? '') || null;
		if (id && !(await getCatalogueApp(id))?.is_platform_app) return fail(404, { error: 'Ukjent plattformapp.' });
		const saved = await savePlatformApp(id, parsed.value, ctx.userId);
		await log(
			{
				type: 'admin',
				subtype: id ? 'katalog:plattformapp-endret' : 'katalog:plattformapp-ny',
				action: id ? 'U' : 'C',
				outcome: '0',
				entityRef: `Device/${saved.id}`,
				details: { app: parsed.value.name, scopes: parsed.value.scopes.join(' ') }
			},
			actorFromContext(ctx)
		);
		if (saved.secret) return { secret: saved.secret, secretFor: parsed.value.name };
		redirect(303, '/systemadmin/apper');
	},

	slettPlattformapp: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const deleted = await deletePlatformApp(String(form.get('id') ?? ''));
		if (!deleted) return fail(404, { error: 'Ukjent plattformapp.' });
		for (const tenantId of [undefined, ...deleted.installs.map((install) => install.tenant_id)]) {
			await log(
				{ type: 'admin', subtype: 'app:slettet-av-plattform', action: 'D', outcome: '0', details: { name: deleted.name } },
				actorFromContext(ctx),
				tenantId
			);
		}
		redirect(303, '/systemadmin/apper');
	},

	vurder: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const id = String(form.get('id') ?? '');
		const approved = form.get('utfall') === 'godkjent';
		const note = String(form.get('begrunnelse') ?? '').trim();

		// A refusal without a reason is not a decision the developer can act on.
		if (!approved && note.length < 5) {
			return fail(400, { error: 'Et avslag må ha en begrunnelse utvikleren kan gjøre noe med.' });
		}

		const app = await getCatalogueApp(id);
		if (!app) return fail(404, { error: 'Ukjent app.' });
		// Withdrawing an approval is a different act from refusing a submission:
		// it stops the app at every practice that has it, and is logged as such.
		const withdrawn = !approved && app.status === 'godkjent';
		const blocked = withdrawn ? ((await installCounts()).get(id) ?? 0) : 0;
		await reviewApp(id, approved, note, ctx.userId);

		await log(
			{
				type: 'admin',
				subtype: withdrawn ? 'katalog:trukket' : 'katalog:vurdert',
				action: 'U',
				outcome: '0',
				entityRef: `Device/${id}`,
				details: {
					app: app.name,
					utfall: approved ? 'godkjent' : 'avvist',
					...(withdrawn ? { sperredeInstallasjoner: blocked } : {})
				}
			},
			actorFromContext(ctx)
		);

		// Best effort: the decision stands whether or not the mail goes out.
		const developers = await listDevelopers();
		const developer = developers.find((d) => d.id === app.developer_id);
		if (developer && !app.is_platform_app) {
			await sendEmail({
				to: developer.email,
				subject: approved
					? `«${app.name}» er godkjent`
					: withdrawn
						? `Godkjenningen av «${app.name}» er trukket tilbake`
						: `«${app.name}» ble ikke godkjent`,
				text: approved
					? [`«${app.name}» er godkjent, og virksomheter kan nå installere den.`, '', note].join('\n')
					: withdrawn
						? [
								`Godkjenningen av «${app.name}» er trukket tilbake. Appen er sperret hos de ${blocked} virksomhetene som hadde installert den.`,
								'', note, '', 'Rett opp og send den inn på nytt.'
							].join('\n')
						: [`«${app.name}» ble ikke godkjent.`, '', note, '', 'Rett opp og send den inn på nytt.'].join('\n')
			}).catch(() => undefined);
		}
		redirect(303, '/systemadmin/apper');
	}
};
