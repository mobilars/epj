import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { developerFromSession, updateDeveloper } from '$srv/developer/developer';
import { appsForDeveloper, createApp, submitApp, updateApp, type AppInput } from '$srv/developer/catalogue';
import { describeScope } from '$srv/authz/scopes';
import type { Placement } from '$srv/auth/clients';

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

function readApp(form: FormData): { value?: AppInput; error?: string } {
	const text = (name: string) => String(form.get(name) ?? '').trim();
	const lines = (name: string) =>
		text(name)
			.split(/[\s,]+/)
			.filter(Boolean);

	const name = text('navn');
	const launchUrl = text('launchUrl');
	if (!name) return { error: 'Appen må ha et navn.' };
	if (!launchUrl) return { error: 'Appen må ha en launch-URL.' };

	// https only, and no fragments: these become redirect URIs and launch
	// addresses in a record system, where an address that can be read over the
	// wire is not one anybody should be sending a patient context to.
	for (const [label, value] of [
		['Launch-URL', launchUrl],
		...lines('redirectUris').map((u) => ['Redirect-URI', u] as [string, string])
	] as [string, string][]) {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return { error: `${label} er ikke en gyldig adresse: ${value}` };
		}
		if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
			return { error: `${label} må bruke https (unntatt localhost): ${value}` };
		}
		if (url.hash) return { error: `${label} kan ikke ha fragment: ${value}` };
	}

	const placement = text('plassering') as Placement;
	if (!['ingen', 'hoved', 'side'].includes(placement)) return { error: 'Ukjent plassering.' };

	return {
		value: {
			name,
			summary: text('kortbeskrivelse'),
			description: text('beskrivelse'),
			launchUrl,
			redirectUris: lines('redirectUris'),
			scopes: lines('scopes'),
			placement,
			contactEmail: text('kontaktEpost'),
			privacyUrl: text('personvernUrl'),
			databehandleravtale: text('databehandleravtale')
		}
	};
}

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
		const parsed = readApp(form);
		if (!parsed.value) return fail(400, { error: parsed.error });
		await createApp(developer.id, parsed.value);
		redirect(303, '/utvikler');
	},

	lagre: async (event) => {
		const developer = await developerFromSession(event.cookies);
		if (!developer) redirect(303, '/utvikler/logg-inn');
		const form = await event.request.formData();
		const parsed = readApp(form);
		if (!parsed.value) return fail(400, { error: parsed.error });
		await updateApp(String(form.get('id') ?? ''), developer.id, parsed.value);
		redirect(303, '/utvikler');
	},

	send: async (event) => {
		const developer = await developerFromSession(event.cookies);
		if (!developer) redirect(303, '/utvikler/logg-inn');
		const form = await event.request.formData();
		await submitApp(String(form.get('id') ?? ''), developer.id);
		redirect(303, '/utvikler');
	}
};
