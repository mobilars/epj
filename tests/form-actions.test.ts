import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every `action="?/name"` in a page must name an action the page's server file
 * actually exports.
 *
 * In SvelteKit the action name is the URL. A form posting to an action that no
 * longer exists answers 404, and nothing else complains: the page renders, the
 * button looks fine, and the failure only appears when someone presses it.
 *
 * This is not hypothetical. Renaming the server actions to English left
 * fourteen forms across nine pages pointing at the Norwegian names - registering
 * an app, creating a user, assigning roles, prescribing, discontinuing,
 * referrals, notes, settlements and creating an organisation were all dead. The
 * unit tests never touch a form action, and the end-to-end tests that do are a
 * separate command, so the whole suite stayed green.
 */

function pagesWithForms(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) pagesWithForms(full, found);
		else if (entry.name.endsWith('.svelte')) found.push(full);
	}
	return found;
}

describe('skjemahandlinger', () => {
	const routesDir = path.join('src', 'platform', 'routes');
	const appRoutes = fs.readdirSync(path.join('src', 'apps'), { withFileTypes: true })
		.filter((e) => e.isDirectory())
		// An app's components hold forms too, such as the note in the record's side panel.
		.flatMap((e) => [path.join('src', 'apps', e.name, 'routes'), path.join('src', 'apps', e.name, 'components')])
		.filter((dir) => fs.existsSync(dir));
	const pages = [routesDir, ...appRoutes].flatMap((dir) => pagesWithForms(dir));

	/** A route in the platform's tree may only mount an app: read the app's own file. */
	function serverSource(file: string): string {
		const text = fs.readFileSync(file, 'utf8');
		const mounted = text.startsWith('// Mounts') ? /from '\$apps\/([^']+)'/.exec(text) : null;
		return mounted ? fs.readFileSync(path.join('src', 'apps', `${mounted[1]}.ts`), 'utf8') : text;
	}

	it('finner sider å kontrollere', () => {
		expect(pages.length).toBeGreaterThan(10);
	});

	it('peker på en handling som finnes i +page.server.ts', () => {
		const broken: string[] = [];

		for (const page of pages) {
			const markup = fs.readFileSync(page, 'utf8');
			// Same-page forms post to `?/name`; a layout posts to another route's
			// action with a full path, `/pasienter/{id}/nodrett?/name`. The first
			// version of this test only read the former, and the emergency-access
			// forms - reachable from every tab in the record - stayed dead.
			const used: { route: string; name: string }[] = [];
			for (const m of markup.matchAll(/action="([^"]*)\?\/([^"]+)"/g)) {
				const target = m[1];
				const route = target
					? path.join(routesDir, ...target.replace(/\{[^}]*\}/g, '[id]').split('/').filter(Boolean))
					: path.dirname(page);
				used.push({ route, name: m[2] });
			}
			if (!used.length) continue;

			for (const { route, name } of used) {
				const server = path.join(route, '+page.server.ts');
				if (!fs.existsSync(server)) {
					broken.push(`${page}: bruker ?/${name} mot ${route}, som ikke har +page.server.ts`);
					continue;
				}
				const source = serverSource(server);
				const defined = new Set([...source.matchAll(/^\t([A-Za-z_$][\w$]*)\s*:\s*async/gm)].map((m) => m[1]));
				// A single unnamed action is posted to without a name at all.
				if (/^\tdefault\s*:/m.test(source)) defined.add('default');
				if (!defined.has(name)) {
					broken.push(`${page}: ?/${name} finnes ikke i ${server} (der er: ${[...defined].join(', ') || 'ingen'})`);
				}
			}
		}

		expect(broken).toEqual([]);
	});
});
