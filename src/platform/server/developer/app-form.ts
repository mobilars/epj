import type { Placement } from '../auth/clients';
import type { AppInput, ClientType } from './catalogue';

/** The form behind `AppForm.svelte`, read and checked, for developers and for the platform alike. */
export function readAppForm(form: FormData): { value?: AppInput; error?: string } {
	const text = (name: string) => String(form.get(name) ?? '').trim();
	const lines = (name: string) =>
		text(name)
			.split(/[\s,]+/)
			.filter(Boolean);

	const name = text('navn');
	const launchUrl = text('launchUrl');
	if (!name) return { error: 'Appen må ha et navn.' };
	if (!launchUrl) return { error: 'Appen må ha en launch-URL.' };

	const jwksUri = text('jwksUri');

	// https only, and no fragments: these become redirect URIs and launch
	// addresses in a record system, where an address that can be read over the
	// wire is not one anybody should be sending a patient context to.
	for (const [label, value] of [
		['Launch-URL', launchUrl],
		...lines('redirectUris').map((u) => ['Redirect-URI', u] as [string, string]),
		...(jwksUri ? [['jwks_uri', jwksUri] as [string, string]] : [])
	] as [string, string][]) {
		let url: URL;
		try {
			// The placeholder is filled in on installing, and is not valid in a URL's host.
			url = new URL(value.replace('{client_id}', 'x'));
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

	const clientType = (text('klienttype') || 'public') as ClientType;
	if (!['public', 'secret', 'keys'].includes(clientType)) return { error: 'Ukjent klientautentisering.' };

	let jwks: { keys: unknown[] } | null = null;
	if (clientType === 'keys') {
		if (text('jwks')) {
			try {
				jwks = JSON.parse(text('jwks'));
			} catch {
				return { error: 'JWKS er ikke gyldig JSON.' };
			}
			if (!Array.isArray(jwks?.keys) || jwks.keys.length === 0) return { error: 'JWKS må ha minst én nøkkel under «keys».' };
			if (jwks.keys.some((key) => typeof key === 'object' && key !== null && 'd' in key)) {
				return { error: 'JWKS inneholder en privat nøkkel. Lim inn bare den offentlige delen.' };
			}
		}
		if (!jwks && !jwksUri) return { error: 'Klientautentisering med nøkler trenger jwks_uri eller JWKS.' };
	}

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
			databehandleravtale: text('databehandleravtale'),
			clientType,
			jwks: clientType === 'keys' ? jwks : null,
			jwksUri: clientType === 'keys' ? jwksUri || null : null,
			replacesTab: text('erstatterFane') || null
		}
	};
}
