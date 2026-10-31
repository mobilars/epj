import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { developerFromSession, updateDeveloper } from '$srv/developer/developer';
import { appsForDeveloper, createApp, firstAppSecret, newAppSecret, submitApp, updateApp } from '$srv/developer/catalogue';
import { readAppForm } from '$srv/developer/app-form';
import { describeScope } from '$srv/authz/scopes';

/**
 * A developer's own apps.
 *
 * Everything about an app is on one page: what it is, where it launches, what
 * it asks for, and where it is in review. An app is described once and
 * submitted; the platform approves or refuses with a reason the developer can
 * act on.
 */

const STATUS_TEXT: Record<string, string> = {
	utkast: 'Utkast',
	'til-vurdering': 'Til vurdering',
	godkjent: 'Godkjent',
	avvist: 'Avvist'
};

export const load: PageServerLoad = async (event) => {
	const developer = await developerFromSession(event.cookies);
	if (!developer) redirect(303, '/utvikler/logg-inn');

	const apps = await appsForDeveloper(developer.id);
	return {
		profile: { name: developer.name, organisation: developer.organisation, email: developer.email },
		apps: apps.map((a) => ({
			id: a.id,
			name: a.name,
			summary: a.summary,
			description: a.description,
			launchUrl: a.launch_url,
			redirectUris: a.redirect_uris,
			scopes: a.scopes.map((s) => ({ scope: s, description: describeScope(s) })),
			scopeText: a.scopes.join(' '),
			placement: a.placement,
			contactEmail: a.contact_email,
			privacyUrl: a.privacy_url,
			databehandleravtale: a.databehandleravtale,
			clientType: a.client_type,
			hasSecret: Boolean(a.secret_hash),
			jwksUri: a.jwks_uri ?? '',
			jwksText: a.jwks ? JSON.stringify(a.jwks, null, 1) : '',
			status: a.status,
			statusText: STATUS_TEXT[a.status] ?? a.status,
			reviewNote: a.review_note,
			canSubmit: a.status === 'utkast' || a.status === 'avvist'
		}))
	};
};

export const actions: Actions = {
	profil: async (event) => {
		const developer = await developerFromSession(event.cookies);
		if (!developer) redirect(303, '/utvikler/logg-inn');
		const form = await event.request.formData();
		await updateDeveloper(developer.id, String(form.get('navn') ?? '').trim(), String(form.get('virksomhet') ?? '').trim());
		redirect(303, '/utvikler');
	},

	nyApp: async (event) => {
		const developer = await developerFromSession(event.cookies);
		if (!developer) redirect(303, '/utvikler/logg-inn');
		const form = await event.request.formData();
		const parsed = readAppForm(form);
		if (!parsed.value) return fail(400, { error: parsed.error });
		const id = await createApp(developer.id, parsed.value);
		const secret = await firstAppSecret(id, developer.id);
		if (secret) return { secret, secretFor: parsed.value.name };
		redirect(303, '/utvikler');
	},

	lagre: async (event) => {
		const developer = await developerFromSession(event.cookies);
		if (!developer) redirect(303, '/utvikler/logg-inn');
		const form = await event.request.formData();
		const parsed = readAppForm(form);
		if (!parsed.value) return fail(400, { error: parsed.error });
		const id = String(form.get('id') ?? '');
		await updateApp(id, developer.id, parsed.value);
		const secret = await firstAppSecret(id, developer.id);
		if (secret) return { secret, secretFor: parsed.value.name };
		redirect(303, '/utvikler');
	},

	nyHemmelighet: async (event) => {
		const developer = await developerFromSession(event.cookies);
		if (!developer) redirect(303, '/utvikler/logg-inn');
		const form = await event.request.formData();
		const secret = await newAppSecret(String(form.get('id') ?? ''), developer.id);
		if (!secret) return fail(400, { error: 'Appen bruker ikke klienthemmelighet.' });
		return { secret, secretFor: String(form.get('navn') ?? '') };
	},

	send: async (event) => {
		const developer = await developerFromSession(event.cookies);
		if (!developer) redirect(303, '/utvikler/logg-inn');
		const form = await event.request.formData();
		await submitApp(String(form.get('id') ?? ''), developer.id);
		redirect(303, '/utvikler');
	}
};
