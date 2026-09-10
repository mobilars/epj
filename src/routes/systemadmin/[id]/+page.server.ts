import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hentTenant, oppdaterTenant } from '$srv/tenant/tenant';
import { listPartisjoner } from '$srv/tenant/partisjon';
import { aktorFraKontekst } from '$srv/audit';
import { query } from '$srv/db';
import { PLATTFORM_TENANT, fhirBaseFor, utstederFor } from '$srv/tenant/kontekst';

/** Detaljer om én virksomhet, med de tallene som trengs for å drifte den. */
export const load: PageServerLoad = async (event) => {
	const tenant = await hentTenant(event.params.id);
	if (!tenant) error(404, 'Ukjent virksomhet.');

	const [brukere, partisjoner] = await Promise.all([
		query<{ rolle: string; n: number }>(
			`SELECT r.rolle, count(DISTINCT u.id)::int AS n
			 FROM user_account u
			 JOIN role_assignment r ON r.user_id = u.id AND r.gyldig_til IS NULL
			 WHERE u.tenant_id = $1 AND u.status = 'aktiv'
			 GROUP BY r.rolle ORDER BY r.rolle`,
			[tenant.id]
		),
		listPartisjoner()
	]);

	const tall = await query<{ hva: string; n: number }>(
		`SELECT 'Brukere' AS hva, count(*)::int AS n FROM user_account WHERE tenant_id = $1
		 UNION ALL SELECT 'SMART-apper', count(*)::int FROM oauth_client WHERE tenant_id = $1
		 UNION ALL SELECT 'Aktive tokens', count(*)::int FROM oauth_token
			WHERE tenant_id = $1 AND kind = 'access' AND tilbakekalt = false AND utloper > now()
		 UNION ALL SELECT 'Loggeinnslag', count(*)::int FROM audit_event WHERE tenant_id = $1`,
		[tenant.id]
	);

	return {
		virksomhet: {
			id: tenant.id,
			navn: tenant.navn,
			organisasjonsnummer: tenant.organisasjonsnummer,
			herId: tenant.her_id,
			kommunenummer: tenant.kommunenummer,
			vertsnavn: tenant.vertsnavn,
			baseUrl: tenant.base_url,
			partisjonId: tenant.partisjon_id,
			status: tenant.status,
			merknad: tenant.merknad,
			opprettet: new Date(tenant.opprettet).toLocaleString('nb-NO')
		},
		erPlattform: tenant.id === PLATTFORM_TENANT,
		fhirBaseUrl: fhirBaseFor(tenant),
		issuer: utstederFor(tenant),
		wellKnown: `${utstederFor(tenant)}/.well-known/smart-configuration`,
		partisjonFinnes: partisjoner.ok
			? partisjoner.partisjoner.some((p) => p.navn === tenant.id)
			: null,
		partisjonsfeil: partisjoner.ok ? null : partisjoner.feil,
		roller: brukere,
		tall
	};
};

export const actions: Actions = {
	lagre: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.rettigheter.has('plattform:administrer')) return fail(403, { feil: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const tekst = (n: string) => String(form.get(n) ?? '').trim();

		const baseUrl = tekst('baseUrl');
		if (baseUrl) {
			try {
				new URL(baseUrl);
			} catch {
				return fail(400, { feil: 'Ugyldig adresse (base_url).' });
			}
		}

		const resultat = await oppdaterTenant(
			event.params.id,
			{
				navn: tekst('navn') || undefined,
				vertsnavn: tekst('vertsnavn').toLowerCase() || null,
				baseUrl: baseUrl || undefined,
				herId: tekst('herId') || null,
				kommunenummer: tekst('kommunenummer') || null,
				merknad: tekst('merknad') || null
			},
			aktorFraKontekst(ctx)
		);
		if (!resultat.ok) return fail(400, { feil: resultat.feil });
		return { lagret: true };
	}
};
