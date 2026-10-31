import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appManifests } from '../src/apps/registry';

/**
 * The line between the platform and the apps.
 *
 * The platform is the frame: sign-in, access, menus, app management. Apps are what
 * could be replaced by an external one. Nothing in the language stops one
 * reaching into the other, and a shortcut taken once is copied, so the line is
 * held here. See docs/arkitektur.md.
 */

const APPS = path.join('src', 'apps');
const PLATFORM = path.join('src', 'platform');
const ROUTES = path.join(PLATFORM, 'routes');

function walk(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, found);
		else if (/\.(ts|svelte)$/.test(entry.name)) found.push(full);
	}
	return found;
}

const unix = (p: string) => p.split(path.sep).join('/');

/** Value imports only: an `import type` is gone before anything runs. */
function importsOf(file: string): string[] {
	const text = fs.readFileSync(file, 'utf8');
	const found: string[] = [];
	for (const m of text.matchAll(/^\s*(?:<script[^>]*>\s*)?(import|export)\s+(type\s+)?([\w*\s{},$]+?\s*from\s*)?['"]([^'"]+)['"]/gm)) {
		if (!m[2]) found.push(m[4]);
	}
	for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
	return found;
}

/** Where a relative import lands, written the way `$apps` is. */
function asAlias(file: string, spec: string): string {
	if (!spec.startsWith('.')) return spec;
	const target = unix(path.join(path.dirname(file), spec));
	return target.startsWith('src/apps/') ? target.replace('src/apps/', '$apps/') : spec;
}

const isMount = (file: string) => /^(<script lang="ts">\s*)?\s*\/\/ Mounts the [\w-]+ app\./.test(fs.readFileSync(file, 'utf8'));

const appNames = fs.readdirSync(APPS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

/** The files through which the platform is allowed to know of the apps. */
const COMPOSITION = ['$apps/registry', '$apps/registry.server', '$apps/slots'];

describe('platform and apps', () => {
	it('every app in src/apps is registered, under its own directory name', () => {
		expect(appManifests.map((m) => m.id).sort()).toEqual([...appNames].sort());
	});

	it('the platform reaches apps only through the registry and the mount files', () => {
		const files = [...walk(PLATFORM), 'src/hooks.server.ts'];
		const broken = files.flatMap((file) =>
			isMount(file)
				? []
				: importsOf(file)
						.map((spec) => asAlias(file, spec))
						.filter((spec) => spec.startsWith('$apps/') && !COMPOSITION.includes(spec))
						.map((spec) => `${unix(file)} imports ${spec}`)
		);
		expect(broken).toEqual([]);
	});

	it('a mount file does nothing but mount', () => {
		for (const file of walk(ROUTES).filter(isMount)) {
			const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
			expect(lines, unix(file)).toBeLessThanOrEqual(6);
		}
	});

	it('an app imports only itself, the platform, and apps it has declared', () => {
		const broken: string[] = [];
		for (const manifest of appManifests) {
			const allowed = new Set([manifest.id, ...(manifest.dependsOn ?? [])]);
			for (const file of walk(path.join(APPS, manifest.id))) {
				for (const spec of importsOf(file)) {
					const other = /^\$apps\/([^/]+)/.exec(spec)?.[1];
					if (other && !allowed.has(other)) broken.push(`${unix(file)} imports ${spec}`);
					// Reaching out of the app by relative path is the same thing.
					if (spec.startsWith('.')) {
						const target = unix(path.join(path.dirname(file), spec));
						if (!target.startsWith(`src/apps/${manifest.id}/`)) broken.push(`${unix(file)} imports ${spec}`);
					}
				}
			}
		}
		expect(broken).toEqual([]);
	});

	it('browser code in an app never imports server code', () => {
		// SvelteKit guards $lib/server. Nothing guards src/apps/*/server, so this does.
		const isServerSide = (file: string) => /[\\/]server[\\/]|\.server\.ts$|\+server\.ts$/.test(file);
		const broken: string[] = [];
		for (const file of walk(APPS).filter((f) => !isServerSide(f))) {
			for (const spec of importsOf(file)) {
				if (/(^|\/)server(\/|$)/.test(spec) || spec.startsWith('$srv')) broken.push(`${unix(file)} imports ${spec}`);
			}
		}
		expect(broken).toEqual([]);
	});

	it('every route an app has is mounted, and every mount points at something', () => {
		for (const app of appNames) {
			const dir = path.join(APPS, app, 'routes');
			if (!fs.existsSync(dir)) continue;
			for (const file of walk(dir)) {
				const mount = path.join(ROUTES, path.relative(dir, file));
				expect(fs.existsSync(mount), `${unix(file)} has no mount`).toBe(true);
			}
		}
		for (const file of walk(ROUTES).filter(isMount)) {
			const target = /'\$apps\/([^']+)'/.exec(fs.readFileSync(file, 'utf8'))?.[1];
			const real = path.join(APPS, target ?? '');
			expect(fs.existsSync(real) || fs.existsSync(`${real}.ts`), `${unix(file)} points at nothing`).toBe(true);
		}
	});

	it('apps do not claim the same tab, shortcut or card', () => {
		const once = (values: (string | undefined)[]) => {
			const present = values.filter(Boolean);
			expect(new Set(present).size).toBe(present.length);
		};
		once(appManifests.map((m) => m.patientTab?.segment));
		once(appManifests.map((m) => m.goKey?.key));
		once(appManifests.map((m) => m.patientGoKey?.key));
		once(appManifests.flatMap((m) => (m.workspaceCards ?? []).map((c) => c.id)));
		once(appManifests.flatMap((m) => (m.patientCards ?? []).map((c) => c.id)));
	});
});
