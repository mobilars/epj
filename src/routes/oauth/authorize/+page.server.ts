import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hentKlient } from '$srv/auth/klienter';
import { feilOmdirigering, forbrukLaunch, opprettAutorisasjonskode, validerAutorisasjonsforesporsel } from '$srv/auth/oauth';
import { beskrivScope, snevreInn } from '$srv/authz/scopes';
import { scopesForRoller } from '$srv/authz/roles';
import { logg } from '$srv/audit';
import { fhirKlient } from '$srv/fhir/client';
import type { FhirResource } from '$srv/fhir/types';

/**
 * Autorisasjonsendepunktet med samtykkedialog.
 *
 * Brukeren må være innlogget i journalen. Deretter vises nøyaktig hva appen ber
 * om tilgang til, oversatt til norsk, og hvilken pasient tilgangen gjelder.
 * Det brukeren godkjenner kan aldri overstige det rollen tillater.
 */

function pasientnavn(p: FhirResource | null): string | null {
	if (!p) return null;
	const navn = (p.name as { given?: string[]; family?: string }[] | undefined)?.[0];
	if (!navn) return null;
	return [navn.given?.join(' '), navn.family].filter(Boolean).join(' ');
}

export const load: PageServerLoad = async (event) => {
	const sok = event.url.searchParams;
	const klient = sok.get('client_id') ? await hentKlient(sok.get('client_id') as string) : null;
	const validering = validerAutorisasjonsforesporsel(sok, klient);

	if (!validering.ok) {
		await logg(
			{ type: 'login', subtype: 'authorize', handling: 'E', utfall: '4', utfallBeskrivelse: validering.beskrivelse, detaljer: { client_id: sok.get('client_id') } },
			{ userId: event.locals.auth?.userId ?? null, actorRef: 'Device/oauth', navn: 'autorisasjonsendepunkt', rolle: null, clientId: sok.get('client_id'), ip: event.locals.clientIp, requestId: event.locals.requestId }
		);
		if (validering.kanOmdirigere && validering.redirectUri) {
			redirect(303, feilOmdirigering(validering.redirectUri, validering.feil, validering.beskrivelse, validering.state));
		}
		error(400, { message: `${validering.feil}: ${validering.beskrivelse}`, code: validering.feil });
	}

	// Krever innlogget bruker i journalen.
	if (!event.locals.auth || event.locals.auth.mate !== 'session') {
		const retur = `${event.url.pathname}${event.url.search}`;
		redirect(303, `/logg-inn?retur=${encodeURIComponent(retur)}`);
	}
	const ctx = event.locals.auth;

	// Launch-kontekst fra journalen (EHR launch).
	let launch = { patientId: null as string | null, encounterId: null as string | null, intent: null as string | null };
	if (validering.foresporsel.launch) {
		const forbrukt = await forbrukLaunch(validering.foresporsel.launch, validering.klient.client_id, ctx.userId as string);
		if (!forbrukt) {
			redirect(303, feilOmdirigering(validering.foresporsel.redirect_uri, 'invalid_request', 'Ugyldig eller utløpt launch-kontekst', validering.foresporsel.state));
		}
		launch = { patientId: forbrukt.patientId ?? null, encounterId: forbrukt.encounterId ?? null, intent: forbrukt.intent ?? null };
	}

	// Standalone launch der appen ber om pasientkontekst uten EHR-launch:
	// pasienten velges i neste steg av brukeren selv.
	const scopeListe = validering.foresporsel.scope.split(/\s+/).filter(Boolean);
	const innsnevret = snevreInn(validering.foresporsel.scope, validering.klient.tillatte_scopes, scopesForRoller(ctx.roller));
	const avvist = scopeListe.filter((s) => !innsnevret.split(/\s+/).includes(s));

	let pasient: FhirResource | null = null;
	if (launch.patientId) {
		pasient = await fhirKlient.les('Patient', launch.patientId, { requestId: event.locals.requestId }).catch(() => null);
	}

	return {
		klient: {
			navn: validering.klient.navn,
			clientId: validering.klient.client_id,
			logoUrl: validering.klient.logo_url,
			kategori: validering.klient.klient_kategori,
			databehandleravtale: validering.klient.databehandleravtale
		},
		bruker: { navn: ctx.navn, roller: ctx.roller },
		scopes: innsnevret.split(/\s+/).filter(Boolean).map((s) => ({ scope: s, beskrivelse: beskrivScope(s) })),
		avvisteScopes: avvist.map((s) => ({ scope: s, beskrivelse: beskrivScope(s) })),
		innsnevret,
		launch: {
			patientId: launch.patientId,
			encounterId: launch.encounterId,
			pasientNavn: pasientnavn(pasient)
		},
		foresporsel: {
			redirect_uri: validering.foresporsel.redirect_uri,
			state: validering.foresporsel.state,
			code_challenge: validering.foresporsel.code_challenge,
			code_challenge_method: validering.foresporsel.code_challenge_method,
			nonce: validering.foresporsel.nonce ?? null,
			client_id: validering.klient.client_id
		}
	};
};

export const actions: Actions = {
	godkjenn: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx || ctx.mate !== 'session' || !ctx.userId) error(401, 'Ikke innlogget');

		const form = await event.request.formData();
		const clientId = String(form.get('client_id') ?? '');
		const redirectUri = String(form.get('redirect_uri') ?? '');
		const state = String(form.get('state') ?? '');
		const scope = String(form.get('scope') ?? '');
		const codeChallenge = String(form.get('code_challenge') ?? '');
		const codeChallengeMethod = String(form.get('code_challenge_method') ?? 'S256');
		const nonce = form.get('nonce') ? String(form.get('nonce')) : null;
		const patientId = form.get('patient_id') ? String(form.get('patient_id')) : null;
		const encounterId = form.get('encounter_id') ? String(form.get('encounter_id')) : null;

		const klient = await hentKlient(clientId);
		if (!klient || !klient.redirect_uris.includes(redirectUri)) {
			return fail(400, { feil: 'Ugyldig klient eller redirect_uri' });
		}

		// Snevres inn på nytt på serversiden: skjemaet er ikke å stole på.
		const tillatt = snevreInn(scope, klient.tillatte_scopes, scopesForRoller(ctx.roller));
		if (!tillatt) return fail(400, { feil: 'Ingen av de forespurte tilgangene er tillatt for din rolle' });

		const kode = await opprettAutorisasjonskode({
			clientId,
			userId: ctx.userId,
			redirectUri,
			scope: tillatt,
			codeChallenge,
			codeChallengeMethod,
			nonce,
			launch: { patientId, encounterId }
		});

		await logg(
			{ type: 'login', subtype: 'authorize', handling: 'E', utfall: '0', patientId, detaljer: { client_id: clientId, scope: tillatt } },
			{ userId: ctx.userId, actorRef: ctx.actorRef, navn: ctx.navn, rolle: ctx.roller[0] ?? null, clientId, ip: event.locals.clientIp, requestId: event.locals.requestId }
		);

		const url = new URL(redirectUri);
		url.searchParams.set('code', kode);
		url.searchParams.set('state', state);
		redirect(303, url.toString());
	},

	avslaa: async (event) => {
		const form = await event.request.formData();
		const redirectUri = String(form.get('redirect_uri') ?? '');
		const state = String(form.get('state') ?? '');
		const clientId = String(form.get('client_id') ?? '');
		const klient = await hentKlient(clientId);
		if (!klient || !klient.redirect_uris.includes(redirectUri)) error(400, 'Ugyldig redirect_uri');
		await logg(
			{ type: 'login', subtype: 'authorize', handling: 'E', utfall: '4', utfallBeskrivelse: 'Brukeren avslo tilgang', detaljer: { client_id: clientId } },
			{ userId: event.locals.auth?.userId ?? null, actorRef: event.locals.auth?.actorRef ?? 'Device/oauth', navn: event.locals.auth?.navn ?? 'ukjent', rolle: null, clientId, ip: event.locals.clientIp, requestId: event.locals.requestId }
		);
		redirect(303, feilOmdirigering(redirectUri, 'access_denied', 'Brukeren avslo tilgang', state));
	}
};
