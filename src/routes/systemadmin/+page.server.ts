import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { opprettTenant, settTenantstatus, tenantOversikt } from '$srv/tenant/tenant';
import { partisjoneringVirker } from '$srv/tenant/partisjon';
import { aktorFraKontekst } from '$srv/audit';
import { config } from '$srv/config';
import { PLATTFORM_TENANT } from '$srv/tenant/kontekst';

/**
 * Virksomhetsregisteret sett fra plattformen.
 *
 * Oversikten teller brukere og loggeinnslag per virksomhet, og krysser av mot
 * partisjonene HAPI faktisk har. Avvik mellom de to registrene er en driftsfeil
 * som må synes, ikke skjules.
 */
export const load: PageServerLoad = async () => {
	const [oversikt, partisjonering] = await Promise.all([
		tenantOversikt(),
		partisjoneringVirker()
	]);

	return {
		partisjonering,
		multitenant: config.fhirServer.multitenant,
		standardTenant: config.tenant.standard,
		virksomheter: oversikt.map((t) => ({
			id: t.id,
			navn: t.navn,
			organisasjonsnummer: t.organisasjonsnummer,
			herId: t.her_id,
			vertsnavn: t.vertsnavn,
			baseUrl: t.base_url,
			partisjonId: t.partisjon_id,
			status: t.status,
			merknad: t.merknad,
			erPlattform: t.id === PLATTFORM_TENANT,
			antallBrukere: t.antallBrukere,
			antallAuditInnslag: t.antallAuditInnslag,
			sisteAktivitet: t.sisteAktivitet ? new Date(t.sisteAktivitet).toLocaleString('nb-NO') : null,
			partisjonFinnes: t.partisjonFinnes,
			opprettet: new Date(t.opprettet).toLocaleDateString('nb-NO')
		}))
	};
};

export const actions: Actions = {
	opprett: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('plattform:administrer')) return fail(403, { feil: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const tekst = (n: string) => String(form.get(n) ?? '').trim();

		const resultat = await opprettTenant(
			{
				id: tekst('id').toLowerCase(),
				navn: tekst('navn'),
				organisasjonsnummer: tekst('organisasjonsnummer').replace(/\s/g, ''),
				herId: tekst('herId') || undefined,
				kommunenummer: tekst('kommunenummer') || undefined,
				vertsnavn: tekst('vertsnavn').toLowerCase() || undefined,
				baseUrl: tekst('baseUrl').replace(/\/$/, ''),
				merknad: tekst('merknad') || undefined,
				adminBrukernavn: tekst('adminBrukernavn') || undefined,
				adminNavn: tekst('adminNavn') || undefined
			},
			aktorFraKontekst(ctx)
		);

		if (!resultat.ok) return fail(400, { feil: resultat.feil });
		return {
			opprettet: resultat.tenant.id,
			adminBrukernavn: resultat.adminBrukernavn,
			midlertidigPassord: resultat.midlertidigPassord
		};
	},

	status: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('plattform:administrer')) return fail(403, { feil: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const id = String(form.get('id') ?? '');
		const status = String(form.get('status') ?? '');

		if (id === PLATTFORM_TENANT) {
			return fail(400, { feil: 'Plattformvirksomheten kan ikke suspenderes - da stenges dette grensesnittet ute.' });
		}
		if (status !== 'aktiv' && status !== 'suspendert' && status !== 'avviklet') {
			return fail(400, { feil: 'Ukjent status.' });
		}

		await settTenantstatus(id, status, aktorFraKontekst(ctx));
		return { statusSatt: `${id}: ${status}` };
	}
};
