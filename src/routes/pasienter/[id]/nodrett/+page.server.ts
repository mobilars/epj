import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { exec } from '$srv/db';
import { nyId } from '$srv/util/ids';
import { logg, aktorFraKontekst } from '$srv/audit';
import { bekreftTotp } from '$srv/auth/brukere';
import { config } from '$srv/config';
import { kanNodrett } from '$srv/authz/roles';

/**
 * Nødrettstilgang ("break the glass").
 *
 * Egen rute fordi handlingene skal kunne utløses fra alle fanene i journalen.
 * Siden har ingen egen visning - den sender brukeren tilbake til journalen.
 */
export const load: PageServerLoad = async (event) => {
	redirect(303, `/pasienter/${event.params.id}`);
};

export const actions: Actions = {
	/**
	 * Nødrettstilgang. Krever begrunnelse, bekreftelse av identitet, og gir
	 * tidsbegrenset tilgang. Både forespørselen og selve tilgangen logges,
	 * og oppslaget legges i kø for gjennomgang.
	 */
	nodrett: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		if (!kanNodrett(ctx.roller)) return fail(403, { feil: 'Rollen din kan ikke bruke nødrettstilgang.' });


		const form = await event.request.formData();
		const begrunnelse = String(form.get('begrunnelse') ?? '').trim();
		const engangskode = String(form.get('engangskode') ?? '').trim();
		const patientId = event.params.id;

		const tilbake = (feil: string) =>
			redirect(303, `/pasienter/${patientId}?nodrettFeil=${encodeURIComponent(feil)}`);

		if (begrunnelse.length < 15) tilbake('Skriv en konkret begrunnelse på minst 15 tegn.');

		// Reautentisering før nødrett, når kontoen har totrinnsverifisering.
		if (config.security.requireMfa && ctx.amr !== 'helseid') {
			if (!engangskode || !(await bekreftTotp(ctx.userId, engangskode))) {
				tilbake('Feil eller manglende engangskode.');
			}
		}

		const varighetTimer = 4;
		await exec(
			`INSERT INTO break_glass (id, user_id, patient_id, begrunnelse, utloper)
			 VALUES ($1,$2,$3,$4, now() + ($5 || ' hours')::interval)`,
			[nyId(), ctx.userId, patientId, begrunnelse, String(varighetTimer)]
		);
		await logg(
			{
				type: 'emergency-override', subtype: 'break-glass', handling: 'E', utfall: '0',
				patientId, purposeOfUse: 'ETREAT', utfallBeskrivelse: begrunnelse,
				detaljer: { varighetTimer }
			},
			aktorFraKontekst(ctx)
		);
		redirect(303, `/pasienter/${patientId}`);
	},

	avsluttNodrett: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.userId) redirect(303, '/logg-inn');
		await exec('UPDATE break_glass SET utloper = now() WHERE user_id = $1 AND patient_id = $2 AND utloper > now()', [
			ctx.userId, event.params.id
		]);
		await logg(
			{ type: 'emergency-override', subtype: 'break-glass-avsluttet', handling: 'E', utfall: '0', patientId: event.params.id },
			aktorFraKontekst(ctx)
		);
		redirect(303, `/pasienter/${event.params.id}`);
	}
};
