import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listKlienter } from '$srv/auth/klienter';
import { opprettLaunch } from '$srv/auth/oauth';
import { beskrivScope } from '$srv/authz/scopes';
import { config } from '$srv/config';
import { logg, aktorFraKontekst } from '$srv/audit';
import { fhirBaseFor, krevTenant } from '$srv/tenant/kontekst';

/**
 * SMART-apper startet fra journalen (EHR launch).
 *
 * Klinikeren velger app, journalen oppretter en kortlivet launch-kontekst med
 * pasienten, og sender brukeren til appens launch-URL med `iss` og `launch`.
 * Appen henter selv oppsettet fra /.well-known/smart-configuration og starter
 * autorisasjonsflyten.
 */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	const forelder = await event.parent();
	if (!ctx || !forelder.pasient) return { apper: [] };

	return {
		apper: (await listKlienter())
			.filter((k) => k.status === 'aktiv' && k.klient_kategori === 'smart-ehr' && k.launch_url)
			.map((k) => ({
				clientId: k.client_id,
				navn: k.navn,
				launchUrl: k.launch_url as string,
				databehandleravtale: k.databehandleravtale,
				scopes: k.tillatte_scopes.filter((s) => s.includes('/')).map((s) => beskrivScope(s))
			}))
	};
};

export const actions: Actions = {
	start: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		const form = await event.request.formData();
		const clientId = String(form.get('clientId') ?? '');

		const klient = (await listKlienter()).find((k) => k.client_id === clientId && k.status === 'aktiv');
		if (!klient?.launch_url) return fail(400, { feil: 'Appen finnes ikke, eller mangler launch-URL.' });

		const launchId = await opprettLaunch({
			clientId,
			userId: ctx.userId,
			patientId: event.params.id,
			encounterId: String(form.get('encounterId') ?? '') || null
		});

		await logg(
			{
				type: 'rest', subtype: 'smart:launch', handling: 'E', utfall: '0',
				patientId: event.params.id, entityRef: `Device/${clientId}`,
				detaljer: { app: klient.navn }
			},
			aktorFraKontekst(ctx)
		);

		const url = new URL(klient.launch_url);
		// `iss` er virksomhetens eget FHIR-endepunkt. Appen henter oppsettet
		// derfra, og sender det tilbake som `aud` i autorisasjonen.
		url.searchParams.set('iss', fhirBaseFor(krevTenant()));
		url.searchParams.set('launch', launchId);
		return { ok: true, url: url.toString(), launchId, appNavn: klient.navn };
	}
};
