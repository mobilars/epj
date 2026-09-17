import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clientAtPlacement, listClients } from '$srv/auth/clients';
import { SETTING, clearSetting, getSetting, setSetting } from '$srv/auth/settings';
import { CARDS, layoutFromForm, resolveLayout, saveUserLayout, type Surface } from '$srv/workspace/layout';

const SURFACES: Surface[] = ['arbeidsflate', 'pasientoversikt'];
const asSurface = (v: unknown): Surface | null => (SURFACES.includes(v as Surface) ? (v as Surface) : null);

/**
 * What the user has chosen for themselves.
 *
 * Only the side panel so far. The practice decides which app is there by
 * default; this is where someone who wants a different one - or the record's
 * own note editor back - says so, without it affecting anyone else.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.userId) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);

	const [apps, standard, chosen, arbeidsflate, pasientoversikt] = await Promise.all([
		listClients(),
		clientAtPlacement('side'),
		getSetting(ctx.userId, SETTING.SIDE_APP),
		resolveLayout('arbeidsflate', ctx.userId),
		resolveLayout('pasientoversikt', ctx.userId)
	]);

	return {
		// Which cards each surface shows, and where the arrangement came from.
		layouts: {
			arbeidsflate: { ...arbeidsflate, cards: CARDS.arbeidsflate, chosen: arbeidsflate.cards },
			pasientoversikt: { ...pasientoversikt, cards: CARDS.pasientoversikt, chosen: pasientoversikt.cards }
		},
		chosen: chosen ?? '',
		standard: standard ? { clientId: standard.client_id, name: standard.name } : null,
		apps: apps
			.filter((c) => c.status === 'aktiv' && c.launch_url && c.client_category !== 'backend')
			.map((c) => ({ clientId: c.client_id, name: c.name }))
	};
};

export const actions: Actions = {
	sidepanel: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		const form = await event.request.formData();
		const value = String(form.get('sidepanel') ?? '').trim();

		// An empty choice means "whatever the practice has decided", which is not
		// the same as choosing the record's own editor - that is `journal`.
		if (!value) await clearSetting(ctx.userId, SETTING.SIDE_APP);
		else await setSetting(ctx.userId, SETTING.SIDE_APP, value);

		redirect(303, '/innstillinger');
	},

	/** The person's own arrangement of a surface. */
	layout: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		const form = await event.request.formData();
		const surface = asSurface(form.get('flate'));
		if (!surface) return fail(400, { error: 'Ukjent flate.' });
		const cards = layoutFromForm(surface, form);
		if (!cards) return fail(400, { error: 'Minst ett kort må vises.' });
		await saveUserLayout(ctx.userId, surface, cards);
		redirect(303, '/innstillinger');
	},

	/** Back to the practice's default for that surface. */
	layoutReset: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		const form = await event.request.formData();
		const surface = asSurface(form.get('flate'));
		if (!surface) return fail(400, { error: 'Ukjent flate.' });
		await saveUserLayout(ctx.userId, surface, null);
		redirect(303, '/innstillinger');
	}
};
