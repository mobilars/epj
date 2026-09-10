/**
 * The SMART on FHIR launch, shared by the apps in this directory.
 *
 * Small on purpose. It does the EHR launch sequence - discovery, PKCE, the
 * token exchange - and hands back a client for reading and writing FHIR. There
 * is no build step and no dependency: an app here is one HTML file and this,
 * which is what makes writing a new one a five-minute job rather than a
 * project.
 *
 * Every app is a public client. All of this runs in the browser, so there is
 * nowhere to keep a secret; PKCE is what protects the authorisation code.
 */

const NS = 'smart';

const store = {
	set: (k, v) => sessionStorage.setItem(`${NS}:${location.pathname.split('/')[1] || 'app'}:${k}`, v),
	get: (k) => sessionStorage.getItem(`${NS}:${location.pathname.split('/')[1] || 'app'}:${k}`),
	clear: () =>
		Object.keys(sessionStorage)
			.filter((k) => k.startsWith(`${NS}:`))
			.forEach((k) => sessionStorage.removeItem(k))
};

async function pkce() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const b64 = (buffer) =>
		btoa(String.fromCharCode(...new Uint8Array(buffer)))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	const verifier = b64(bytes);
	const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
	return { verifier, challenge };
}

export class SmartError extends Error {
	constructor(message, detail) {
		super(message);
		this.detail = detail;
	}
}

/**
 * Runs the launch, or picks up the session a previous one left.
 *
 * Returns `null` while the browser is on its way somewhere - the caller should
 * render nothing and let the redirect happen.
 */
export async function connect({ scope, redirectPath = '/callback', launchPath = '/launch' }) {
	if (location.pathname === launchPath) {
		const q = new URLSearchParams(location.search);
		const iss = q.get('iss');
		const clientId = q.get('client_id');
		if (!iss) throw new SmartError('Mangler iss', 'Appen må åpnes av journalen, med iss og launch.');
		if (!clientId) throw new SmartError('Mangler client_id', 'Legg klient-id-en på launch-URL-en: ?client_id=…');

		const wellKnown = `${iss.replace(/\/$/, '')}/.well-known/smart-configuration`;
		let conf;
		try {
			const response = await fetch(wellKnown, { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			conf = await response.json();
		} catch (err) {
			throw new SmartError('Fant ikke smart-configuration', `${wellKnown}\n${err.message}`);
		}

		const { verifier, challenge } = await pkce();
		const state = crypto.randomUUID();
		store.set('verifier', verifier);
		store.set('state', state);
		store.set('iss', iss);
		store.set('token_endpoint', conf.token_endpoint);
		store.set('client_id', clientId);

		const url = new URL(conf.authorization_endpoint);
		for (const [k, v] of Object.entries({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: `${location.origin}${redirectPath}`,
			scope,
			state,
			aud: iss,
			launch: q.get('launch') ?? '',
			code_challenge: challenge,
			code_challenge_method: 'S256'
		}))
			url.searchParams.set(k, v);
		location.assign(url.toString());
		return null;
	}

	if (location.pathname === redirectPath) {
		const q = new URLSearchParams(location.search);
		if (q.get('error')) throw new SmartError('Journalen avviste autorisasjonen', `${q.get('error')}: ${q.get('error_description') ?? ''}`);
		if (q.get('state') !== store.get('state')) throw new SmartError('Feil state', 'Svaret hører ikke til denne økten.');

		const response = await fetch(store.get('token_endpoint'), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code: q.get('code') ?? '',
				redirect_uri: `${location.origin}${redirectPath}`,
				client_id: store.get('client_id'),
				code_verifier: store.get('verifier')
			})
		});
		const text = await response.text();
		if (!response.ok) throw new SmartError('Token-endepunktet svarte med feil', `${response.status}\n${text}`);
		store.set('tokens', text);
		history.replaceState(null, '', '/');
		return client(JSON.parse(text));
	}

	const saved = store.get('tokens');
	return saved ? client(JSON.parse(saved)) : null;
}

function client(tokens) {
	const base = store.get('iss').replace(/\/$/, '');
	const request = async (path, init = {}) => {
		const response = await fetch(`${base}/${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${tokens.access_token}`,
				accept: 'application/fhir+json',
				...(init.body ? { 'content-type': 'application/fhir+json' } : {}),
				...(init.headers ?? {})
			}
		});
		const text = await response.text();
		return { ok: response.ok, status: response.status, body: text ? JSON.parse(text) : null };
	};

	return {
		tokens,
		patientId: tokens.patient ?? null,
		scopes: (tokens.scope ?? '').split(/\s+/).filter(Boolean),
		read: (path) => request(path),
		create: (resource) => request(resource.resourceType, { method: 'POST', body: JSON.stringify(resource) }),
		/** Replaces a resource that exists. The id has to be on it. */
		update: (resource) =>
			request(`${resource.resourceType}/${resource.id}`, { method: 'PUT', body: JSON.stringify(resource) }),
		/** Resources out of a search bundle, or an empty list. */
		entries: (result) => (result?.body?.entry ?? []).map((e) => e.resource),
		signOut: () => {
			store.clear();
			location.assign('/');
		}
	};
}

export const escapeHtml = (value) =>
	String(value ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
