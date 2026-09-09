import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$srv/config';
import { loggInn } from '$srv/auth/brukere';
import { opprettSesjon } from '$srv/auth/session';
import { erKonfigurert as helseIdKonfigurert } from '$srv/auth/helseid';
import { logg } from '$srv/audit';
import { rateLimit } from '$srv/http';

/**
 * Pålogging.
 *
 * HelseID er hovedveien inn. Den lokale påloggingen med brukernavn, passord og
 * engangskode er en testmekanisme, og styres av `EPJ_TESTINNLOGGING`. I
 * produksjon med HelseID skal den være avslått.
 */

function trygtRetur(retur: string | null): string {
	// Kun interne stier, aldri absolutte URL-er: hindrer åpen omdirigering.
	if (!retur || !retur.startsWith('/') || retur.startsWith('//')) return '/';
	return retur;
}

export const load: PageServerLoad = async (event) => {
	if (event.locals.auth?.mate === 'session') {
		redirect(303, trygtRetur(event.url.searchParams.get('retur')));
	}
	return {
		helseId: helseIdKonfigurert(),
		testinnlogging: config.testinnlogging.aktivert,
		demobrukere: config.testinnlogging.visDemobrukere
			? [
					{ brukernavn: 'lege', navn: 'Dr. Ingrid Fastlege', rolle: 'Lege' },
					{ brukernavn: 'sykepleier', navn: 'Kari Sykepleier', rolle: 'Sykepleier' },
					{ brukernavn: 'sekretaer', navn: 'Ola Helsesekretær', rolle: 'Helsesekretær' },
					{ brukernavn: 'admin', navn: 'Systemansvarlig', rolle: 'Systemansvarlig' }
				]
			: [],
		retur: trygtRetur(event.url.searchParams.get('retur')),
		organisasjon: config.organisasjon.navn
	};
};

interface Skjemasvar {
	feil?: string;
	brukernavn?: string;
	krevErMfa?: boolean;
}

export const actions: Actions = {
	default: async (event) => {
		const svar = (status: number, data: Skjemasvar) => fail(status, data);

		if (!config.testinnlogging.aktivert) {
			return svar(403, { feil: 'Lokal pålogging er slått av. Bruk HelseID.' });
		}

		const form = await event.request.formData();
		const brukernavn = String(form.get('brukernavn') ?? '').trim();
		const passord = String(form.get('passord') ?? '');
		const engangskode = String(form.get('engangskode') ?? '').trim();
		const retur = trygtRetur(String(form.get('retur') ?? '/'));

		const aktor = {
			userId: null,
			actorRef: 'Person/ukjent',
			navn: brukernavn || 'ukjent',
			rolle: null,
			clientId: null,
			ip: event.locals.clientIp,
			requestId: event.locals.requestId
		};

		// Egen teller per brukernavn, i tillegg til IP-grensen i hooks.
		const grense = await rateLimit(
			`login:${brukernavn.toLowerCase()}`,
			config.security.rateLimit.paloggingPerBruker,
			config.security.rateLimit.paloggingVinduSekunder
		);
		if (!grense.tillatt) {
			await logg({ type: 'login', subtype: 'ratelimit', handling: 'E', utfall: '4', utfallBeskrivelse: 'For mange forsøk' }, aktor);
			return svar(429, { feil: 'For mange påloggingsforsøk. Vent noen minutter.' });
		}

		if (!brukernavn || !passord) {
			return svar(400, { feil: 'Fyll inn brukernavn og passord.', brukernavn });
		}

		const resultat = await loggInn(brukernavn, passord, engangskode || undefined);

		switch (resultat.utfall) {
			case 'krever-mfa':
				return svar(401, { krevErMfa: true, brukernavn, feil: 'Skriv inn engangskoden fra autentiseringsappen.' });
			case 'laast':
				await logg({ type: 'login', subtype: 'passord', handling: 'E', utfall: '4', utfallBeskrivelse: 'Kontoen er låst' }, aktor);
				return svar(423, { feil: 'Kontoen er midlertidig låst etter flere mislykkede forsøk.' });
			case 'sperret':
				await logg({ type: 'login', subtype: 'passord', handling: 'E', utfall: '4', utfallBeskrivelse: 'Kontoen er sperret' }, aktor);
				return svar(403, { feil: 'Kontoen er sperret. Kontakt systemansvarlig.' });
			case 'feil-passord':
			case 'ukjent-bruker':
				await logg({ type: 'login', subtype: 'passord', handling: 'E', utfall: '4', utfallBeskrivelse: 'Feil brukernavn eller passord' }, aktor);
				// Samme melding uansett årsak - vi avslører ikke om brukeren finnes.
				return svar(401, { feil: 'Feil brukernavn, passord eller engangskode.', brukernavn });
			case 'ok': {
				await opprettSesjon(
					resultat.bruker.id,
					resultat.amr,
					event.locals.clientIp,
					event.request.headers.get('user-agent'),
					event.cookies
				);
				await logg(
					{ type: 'login', subtype: 'passord', handling: 'E', utfall: '0', detaljer: { amr: resultat.amr, roller: resultat.roller.join(',') } },
					{ ...aktor, userId: resultat.bruker.id, actorRef: resultat.bruker.practitioner_id ? `Practitioner/${resultat.bruker.practitioner_id}` : `Person/${resultat.bruker.id}`, navn: resultat.bruker.navn, rolle: resultat.roller[0] ?? null }
				);
				redirect(303, retur);
			}
		}
	}
};
