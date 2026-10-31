import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { callerIssuer, callerJwksUrl, listServices, registerFromDiscovery, removeService, setServiceEnabled } from '$srv/cds/hooks';
import { activeSigningKey } from '$srv/auth/keys';
import { actorFromContext, log } from '$srv/audit';

/**
 * CDS Hooks services the practice asks for advice.
 *
 * Registering one is an administrative act, like registering an app: the
 * record will call this address whenever a record is opened, and the address
 * comes from here rather than from anything a user can set. What comes back is
 * advice - a card cannot write to the record or stop anyone doing anything.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.permissions.has('admin:apper')) error(403, 'Ingen tilgang.');
	const key = await activeSigningKey();
	return {
		services: await listServices(),
		// What a service needs in order to check that it really was this record
		// asking: where the record's keys are, and which one signs today.
		signing: { issuer: callerIssuer(), jwksUrl: callerJwksUrl(), kid: key.kid },
		ownServicesUrl: `${callerIssuer()}/cds-services`
	};
};

export const actions: Actions = {
	registrer: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const url = String(form.get('url') ?? '').trim();
		if (!url) return fail(400, { error: 'Skriv inn adressen til tjenesten.' });

		try {
			const found = await registerFromDiscovery(url, ctx.userId);
			await log(
				{ type: 'admin', subtype: 'cds:registrert', action: 'C', outcome: '0', details: { url, tjenester: found } },
				actorFromContext(ctx)
			);
			if (found === 0) return fail(400, { error: 'Adressen svarte, men oppga ingen tjenester.' });
		} catch (err) {
			return fail(400, { error: `Klarte ikke å lese tjenestene: ${(err as Error).message}` });
		}
		redirect(303, '/admin/beslutningsstotte');
	},

	status: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		await setServiceEnabled(String(form.get('id') ?? ''), form.get('enabled') === 'ja');
		redirect(303, '/admin/beslutningsstotte');
	},

	fjern: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('admin:apper')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		await removeService(String(form.get('id') ?? ''));
		redirect(303, '/admin/beslutningsstotte');
	}
};
