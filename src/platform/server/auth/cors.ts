import { listClients } from './clients';
import { issuerFor, requireTenant } from '../tenant/context';

/**
 * The origins allowed to call the record from a browser.
 *
 * Derived from the redirect URIs of the apps this organisation has registered:
 * an app the practice approved is one whose pages may talk to the record, and
 * nothing else is. The cache is per organisation - an app approved at one
 * practice must not gain access at another.
 *
 * Both the FHIR endpoint and the token endpoint need this. A public client
 * runs in the browser, so its token exchange is a cross-origin request like
 * any other; without the header the launch fails one step after consent.
 */
const cache = new Map<string, { value: string[]; to: number }>();

export async function allowedOpphav(): Promise<string[]> {
	const tenantId = requireTenant().id;
	const cached = cache.get(tenantId);
	if (cached && Date.now() < cached.to) return cached.value;

	const opphav = new Set<string>([new URL(issuerFor(requireTenant())).origin]);
	for (const client of await listClients()) {
		if (client.status !== 'aktiv') continue;
		for (const uri of client.redirect_uris) {
			try {
				opphav.add(new URL(uri).origin);
			} catch {
				/* skip invalid URIs */
			}
		}
	}
	const value = [...opphav];
	cache.set(tenantId, { value, to: Date.now() + 60_000 });
	return value;
}

export function clearOpphavsCache(): void {
	cache.clear();
}
