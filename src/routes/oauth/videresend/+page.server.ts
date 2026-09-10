import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listClients, validRedirectUri } from '$srv/auth/clients';

/**
 * The hop back to the app after consent.
 *
 * The consent dialog is a form, and the app's redirect URI is by definition on
 * another origin. Chrome enforces `form-action` against the *target of a
 * redirect*, not only the address posted to, so redirecting the submission
 * straight to the app was blocked by `form-action 'self'` - and an embedded
 * app never got its authorization code.
 *
 * Widening the policy to permit posting anywhere would have fixed it and given
 * up the protection at the same time. Instead the submission stays on this
 * origin, and the browser leaves for the app by an ordinary navigation, which
 * `form-action` does not govern.
 *
 * The address is checked against the registered redirect URIs before the page
 * will point anywhere - otherwise this would be an open redirector, which is
 * precisely what the OAuth rules on exact redirect matching exist to prevent.
 */
export const load: PageServerLoad = async (event) => {
	const target = event.url.searchParams.get('til') ?? '';
	if (!target) error(400, 'Mangler adresse.');

	const clients = await listClients();
	const permitted = clients.some((c) => c.status === 'aktiv' && validRedirectUri(c, target.split('?')[0]));
	if (!permitted) error(400, 'Adressen er ikke registrert på noen app.');

	return { target };
};
