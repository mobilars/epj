import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { actorFromContext, log } from '$srv/audit';
import { CARDS, LAYOUT_KEY, defaultLayout, getTenantSetting, layoutFromForm, parseLayout, saveTenantLayout, type Surface } from '$srv/workspace/layout';

/**
 * The practice's default arrangement of the work surface and the patient
 * overview.
 *
 * What everyone sees until they arrange their own. A system administrator's
 * job, like the apps: it decides what the practice's clinicians meet first,
 * and it is logged as an administrative act.
 */

const SURFACES: Surface[] = ['arbeidsflate', 'pasientoversikt'];
const asSurface = (v: unknown): Surface | null => (SURFACES.includes(v as Surface) ? (v as Surface) : null);

export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.permissions.has('admin:system')) error(403, 'Ingen tilgang.');

	const layouts = Object.fromEntries(
		await Promise.all(
			SURFACES.map(async (surface) => {
				const stored = parseLayout(surface, await getTenantSetting(LAYOUT_KEY(surface)));
				return [
					surface,
					{
						cards: CARDS[surface],
						chosen: stored ?? defaultLayout(surface),
						source: stored ? ('virksomhet' as const) : ('standard' as const)
					}
				];
			})
		)
	) as Record<Surface, { cards: (typeof CARDS)[Surface]; chosen: string[]; source: 'virksomhet' | 'standard' }>;

	return { layouts };
};

export const actions: Actions = {
	layout: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:system')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const surface = asSurface(form.get('flate'));
		if (!surface) return fail(400, { error: 'Ukjent flate.' });
		const cards = layoutFromForm(surface, form);
		if (!cards) return fail(400, { error: 'Minst ett kort må vises.' });
		await saveTenantLayout(surface, cards, ctx.userId);
		await log(
			{ type: 'admin', subtype: 'arbeidsflate:oppsett', action: 'U', outcome: '0', entityRef: `layout/${surface}`, details: { surface, cards: cards.join(' ') } },
			actorFromContext(ctx)
		);
		redirect(303, '/admin/arbeidsflate');
	},

	layoutReset: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:system')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const surface = asSurface(form.get('flate'));
		if (!surface) return fail(400, { error: 'Ukjent flate.' });
		await saveTenantLayout(surface, null, ctx.userId);
		await log(
			{ type: 'admin', subtype: 'arbeidsflate:oppsett', action: 'D', outcome: '0', entityRef: `layout/${surface}`, details: { surface, cards: null } },
			actorFromContext(ctx)
		);
		redirect(303, '/admin/arbeidsflate');
	}
};
