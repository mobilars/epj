import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listBrukere, opprettBruker, settPassord, settRoller, settStatus } from '$srv/auth/brukere';
import { avsluttAlleSesjoner } from '$srv/auth/session';
import { tilbakekallForBruker } from '$srv/auth/tokens';
import { erRolle, ROLLE_DEFINISJONER, ROLLER } from '$srv/authz/roles';
import { logg, aktorFraKontekst } from '$srv/audit';
import { nyToken } from '$srv/util/ids';

/** Brukeradministrasjon. Alle endringer i roller og status loggføres. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx?.rettigheter.has('admin:brukere')) error(403, 'Ingen tilgang.');
	return {
		brukere: (await listBrukere()).map((b) => ({
			id: b.id,
			brukernavn: b.brukernavn,
			navn: b.navn,
			hpr: b.hpr_nummer,
			roller: b.roller,
			status: b.status,
			mfa: b.mfa_aktivert,
			sisteInnlogging: b.siste_innlogging ? new Date(b.siste_innlogging).toLocaleString('nb-NO') : null,
			laast: b.laast_til ? new Date(b.laast_til) > new Date() : false
		})),
		roller: ROLLER.map((r) => ({ kode: r, navn: ROLLE_DEFINISJONER[r].navn, beskrivelse: ROLLE_DEFINISJONER[r].beskrivelse }))
	};
};

export const actions: Actions = {
	opprett: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('admin:brukere')) return fail(403, { feil: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const roller = form.getAll('roller').map(String).filter(erRolle);
		const brukernavn = String(form.get('brukernavn') ?? '').trim();
		if (!brukernavn) return fail(400, { feil: 'Brukernavn må fylles ut.' });

		const midlertidig = nyToken(9);
		const bruker = await opprettBruker({
			brukernavn,
			navn: String(form.get('navn') ?? '').trim() || brukernavn,
			epost: String(form.get('epost') ?? '').trim() || undefined,
			hprNummer: String(form.get('hpr') ?? '').trim() || undefined,
			practitionerId: String(form.get('practitionerId') ?? '').trim() || undefined,
			passord: midlertidig,
			roller,
			opprettetAv: ctx.userId ?? undefined
		});
		await logg(
			{ type: 'admin', subtype: 'bruker:opprettet', handling: 'C', utfall: '0', entityRef: `Person/${bruker.id}`, detaljer: { brukernavn, roller: roller.join(',') } },
			aktorFraKontekst(ctx)
		);
		return { ok: true, midlertidigPassord: midlertidig, brukernavn };
	},

	roller: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('admin:brukere')) return fail(403, { feil: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const userId = String(form.get('id') ?? '');
		const roller = form.getAll('roller').map(String).filter(erRolle);
		await settRoller(userId, roller, ctx.userId ?? 'ukjent');
		await logg(
			{ type: 'admin', subtype: 'bruker:roller', handling: 'U', utfall: '0', entityRef: `Person/${userId}`, detaljer: { roller: roller.join(',') } },
			aktorFraKontekst(ctx)
		);
		redirect(303, '/admin/brukere');
	},

	status: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('admin:brukere')) return fail(403, { feil: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const userId = String(form.get('id') ?? '');
		const status = String(form.get('status') ?? 'aktiv') as 'aktiv' | 'sperret' | 'avsluttet';
		await settStatus(userId, status);
		if (status !== 'aktiv') {
			await avsluttAlleSesjoner(userId);
			await tilbakekallForBruker(userId, `status satt til ${status}`);
		}
		await logg(
			{ type: 'admin', subtype: 'bruker:status', handling: 'U', utfall: '0', entityRef: `Person/${userId}`, detaljer: { status } },
			aktorFraKontekst(ctx)
		);
		redirect(303, '/admin/brukere');
	},

	nyttPassord: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('admin:brukere')) return fail(403, { feil: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const userId = String(form.get('id') ?? '');
		const midlertidig = nyToken(9);
		await settPassord(userId, midlertidig, true);
		await avsluttAlleSesjoner(userId);
		await logg(
			{ type: 'admin', subtype: 'bruker:passord', handling: 'U', utfall: '0', entityRef: `Person/${userId}` },
			aktorFraKontekst(ctx)
		);
		return { ok: true, midlertidigPassord: midlertidig };
	}
};
