import { exec, one } from '../db';
import { requireTenant } from '../tenant/context';
import { getSetting, setSetting, clearSetting } from '../auth/settings';

/**
 * Which cards a surface shows, and in what order.
 *
 * Two surfaces so far: the work surface a clinician lands on, and the
 * patient overview. Each has a fixed set of cards it knows how to draw; a
 * layout is the subset of them that is shown, in order. A card missing from
 * the layout is hidden, not gone - the data behind it is still a click away
 * on its own page.
 *
 * Three levels, the nearest wins: what the person has arranged for
 * themselves, else what the practice has set as its default, else every card
 * in the order below. A practice that wants the settlement card first for
 * everyone sets it once; a doctor who never touches settlements hides it for
 * themselves and nobody else notices.
 *
 * Stored as a JSON list of card ids, validated against the catalogue on the
 * way in and again on the way out, so a card that is later removed from the
 * code cannot leave a layout pointing at nothing.
 */

export type Surface = 'arbeidsflate' | 'pasientoversikt';

export interface CardDefinition {
	id: string;
	title: string;
	/** What the card is for, shown where the layout is arranged. */
	description: string;
}

export const CARDS: Record<Surface, CardDefinition[]> = {
	arbeidsflate: [
		{ id: 'timebok', title: 'Timeboken', description: 'Dagens og kommende timer.' },
		{ id: 'meldinger', title: 'Nye meldinger', description: 'Ubehandlede meldinger i innboksen.' },
		{ id: 'oppgjor', title: 'Oppgjør', description: 'Regningskort som er klare for innsending.' }
	],
	pasientoversikt: [
		{ id: 'diagnoser', title: 'Diagnoser og problemer', description: 'Aktive diagnoser med ICPC-2-kode.' },
		{ id: 'kritisk', title: 'Kritisk informasjon', description: 'Allergier og intoleranser.' },
		{ id: 'legemidler', title: 'Legemidler i bruk', description: 'Aktive resepter.' },
		{ id: 'maalinger', title: 'Siste målinger og prøvesvar', description: 'De nyeste observasjonene.' },
		{ id: 'notater', title: 'Siste journalnotater', description: 'De siste konsultasjonsnotatene.' },
		{ id: 'kontakter', title: 'Kontakter', description: 'Konsultasjoner og andre kontakter.' },
		{ id: 'vaksiner', title: 'Vaksiner', description: 'Registrerte vaksinasjoner, når det finnes noen.' }
	]
};

export const LAYOUT_KEY = (surface: Surface) => `layout:${surface}`;

/** The order the cards come in when nobody has said otherwise. */
export function defaultLayout(surface: Surface): string[] {
	return CARDS[surface].map((c) => c.id);
}

/**
 * Reads a layout out of whatever was stored or posted.
 *
 * Unknown ids are dropped, duplicates collapse to the first, and an empty
 * result is treated as "no layout" rather than "no cards" - a surface with
 * nothing on it is a mistake, not a preference.
 */
export function parseLayout(surface: Surface, raw: unknown): string[] | null {
	let list: unknown;
	if (typeof raw === 'string') {
		try {
			list = JSON.parse(raw);
		} catch {
			return null;
		}
	} else {
		list = raw;
	}
	if (!Array.isArray(list)) return null;
	const known = new Set(CARDS[surface].map((c) => c.id));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of list) {
		if (typeof id !== 'string' || !known.has(id) || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out.length ? out : null;
}

/**
 * A layout from a form: one `vis:<id>` checkbox and one `rekkefolge:<id>`
 * number per card. Cards left unchecked are hidden; the rest sort by their
 * number, ties by the catalogue order.
 */
export function layoutFromForm(surface: Surface, form: FormData): string[] | null {
	const order = CARDS[surface]
		.map((c, i) => ({ id: c.id, shown: form.get(`vis:${c.id}`) === 'ja', position: Number(form.get(`rekkefolge:${c.id}`)) || i + 1, i }))
		.filter((c) => c.shown)
		.sort((a, b) => a.position - b.position || a.i - b.i)
		.map((c) => c.id);
	return parseLayout(surface, order);
}

// --- the practice's default ------------------------------------------------

export async function getTenantSetting(key: string): Promise<string | null> {
	const row = await one<{ value: string }>('SELECT value FROM tenant_setting WHERE tenant_id = $1 AND key = $2', [
		requireTenant().id,
		key
	]);
	return row?.value ?? null;
}

export async function setTenantSetting(key: string, value: string, updatedBy: string | null): Promise<void> {
	await exec(
		`INSERT INTO tenant_setting (tenant_id, key, value, updated_by) VALUES ($1,$2,$3,$4)
		 ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
		[requireTenant().id, key, value, updatedBy]
	);
}

export async function clearTenantSetting(key: string): Promise<void> {
	await exec('DELETE FROM tenant_setting WHERE tenant_id = $1 AND key = $2', [requireTenant().id, key]);
}

// --- resolution --------------------------------------------------------------

export interface ResolvedLayout {
	cards: string[];
	/** Where the layout came from, so the settings page can say so. */
	source: 'bruker' | 'virksomhet' | 'standard';
}

export async function resolveLayout(surface: Surface, userId: string | null): Promise<ResolvedLayout> {
	const key = LAYOUT_KEY(surface);
	if (userId) {
		const own = parseLayout(surface, await getSetting(userId, key));
		if (own) return { cards: own, source: 'bruker' };
	}
	const practice = parseLayout(surface, await getTenantSetting(key));
	if (practice) return { cards: practice, source: 'virksomhet' };
	return { cards: defaultLayout(surface), source: 'standard' };
}

export async function saveUserLayout(userId: string, surface: Surface, cards: string[] | null): Promise<void> {
	if (cards) await setSetting(userId, LAYOUT_KEY(surface), JSON.stringify(cards));
	else await clearSetting(userId, LAYOUT_KEY(surface));
}

export async function saveTenantLayout(surface: Surface, cards: string[] | null, updatedBy: string | null): Promise<void> {
	if (cards) await setTenantSetting(LAYOUT_KEY(surface), JSON.stringify(cards), updatedBy);
	else await clearTenantSetting(LAYOUT_KEY(surface));
}
