import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { avsluttFlyt, fullforPalogging } from '$srv/auth/helseid';
import { opprettSesjon } from '$srv/auth/session';
import { logg } from '$srv/audit';

/** Tilbakekall fra HelseID etter autentisering. */
export const GET: RequestHandler = async (event) => {
	const aktor = {
		userId: null,
		actorRef: 'Person/ukjent',
		navn: 'HelseID',
		rolle: null,
		clientId: null,
		ip: event.locals.clientIp,
		requestId: event.locals.requestId
	};

	const feilKode = event.url.searchParams.get('error');
	if (feilKode) {
		avsluttFlyt(event.cookies);
		await logg({ type: 'login', subtype: 'helseid', handling: 'E', utfall: '4', utfallBeskrivelse: feilKode }, aktor);
		redirect(303, `/logg-inn?feil=${encodeURIComponent('HelseID avbrøt påloggingen')}`);
	}

	const kode = event.url.searchParams.get('code');
	const state = event.url.searchParams.get('state');
	if (!kode || !state) redirect(303, '/logg-inn?feil=Mangler%20kode%20fra%20HelseID');

	const resultat = await fullforPalogging(event.cookies, kode, state);
	if (!resultat.ok) {
		await logg({ type: 'login', subtype: 'helseid', handling: 'E', utfall: '4', utfallBeskrivelse: resultat.feil }, aktor);
		redirect(303, `/logg-inn?feil=${encodeURIComponent(resultat.feil)}`);
	}

	if (resultat.bruker.status !== 'aktiv') {
		await logg({ type: 'login', subtype: 'helseid', handling: 'E', utfall: '4', utfallBeskrivelse: 'Kontoen er ikke aktiv' }, { ...aktor, userId: resultat.bruker.id, navn: resultat.bruker.navn });
		redirect(303, '/logg-inn?feil=Kontoen%20er%20ikke%20aktiv');
	}

	await opprettSesjon(resultat.bruker.id, 'helseid', event.locals.clientIp, event.request.headers.get('user-agent'), event.cookies);
	await logg(
		{
			type: 'login', subtype: 'helseid', handling: 'E', utfall: '0',
			detaljer: {
				hpr: resultat.krav.hprNummer,
				sikkerhetsniva: resultat.krav.sikkerhetsniva,
				nyBruker: resultat.nyBruker,
				roller: resultat.roller.join(',')
			}
		},
		{
			...aktor,
			userId: resultat.bruker.id,
			actorRef: resultat.bruker.practitioner_id ? `Practitioner/${resultat.bruker.practitioner_id}` : `Person/${resultat.bruker.id}`,
			navn: resultat.bruker.navn,
			rolle: resultat.roller[0] ?? null
		}
	);

	// Ny bruker uten roller har ingen tilgang før systemansvarlig har tildelt rolle.
	redirect(303, resultat.roller.length === 0 ? '/ingen-tilgang' : resultat.retur);
};
