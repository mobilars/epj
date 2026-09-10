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
	const pages = pagesWithForms(path.join('src', 'routes'));

	it('finner sider å kontrollere', () => {
		expect(pages.length).toBeGreaterThan(10);
	});

	it('peker på en handling som finnes i +page.server.ts', () => {
		const broken: string[] = [];

		for (const page of pages) {
			const markup = fs.readFileSync(page, 'utf8');
			const used = [...markup.matchAll(/action="\?\/([^"]+)"/g)].map((m) => m[1]);
			if (!used.length) continue;

			const server = path.join(path.dirname(page), '+page.server.ts');
			if (!fs.existsSync(server)) {
				broken.push(`${page}: bruker ?/${used.join(', ?/')} uten +page.server.ts`);
				continue;
			}
			const source = fs.readFileSync(server, 'utf8');
			const defined = new Set([...source.matchAll(/^\t([A-Za-z_$][\w$]*)\s*:\s*async/gm)].map((m) => m[1]));
			// A single unnamed action is posted to without a name at all.
			if (/^\tdefault\s*:/m.test(source)) defined.add('default');

			for (const name of used) {
				if (!defined.has(name)) {
					broken.push(`${page}: ?/${name} finnes ikke i ${server} (der er: ${[...defined].join(', ') || 'ingen'})`);
				}
			}
		}

		expect(broken).toEqual([]);
	});
});
