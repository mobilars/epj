import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTenant, updateTenant } from '$srv/tenant/tenant';
import { listPartitions } from '$srv/tenant/partition';
import { actorFromContext } from '$srv/audit';
import { LEVEL_TEXT, LOGIN_LEVELS, isLoginLevel } from '$srv/auth/login-level';
import { query } from '$srv/db';
import { PLATFORM_TENANT, fhirBaseFor, issuerFor } from '$srv/tenant/context';

/** Details of one organisation, with the numbers needed to operate it. */
export const load: PageServerLoad = async (event) => {
	const tenant = await getTenant(event.params.id);
	if (!tenant) error(404, 'Ukjent virksomhet.');

	const [users, partitions] = await Promise.all([
		query<{ role: string; n: number }>(
			`SELECT r.role, count(DISTINCT u.id)::int AS n
			 FROM user_account u
			 JOIN role_assignment r ON r.user_id = u.id AND r.valid_until IS NULL
			 WHERE u.tenant_id = $1 AND u.status = 'aktiv'
			 GROUP BY r.role ORDER BY r.role`,
			[tenant.id]
		),
		listPartitions()
	]);

	const number = await query<{ label: string; n: number }>(
		`SELECT 'Brukere' AS label, count(*)::int AS n FROM user_account WHERE tenant_id = $1
		 UNION ALL SELECT 'SMART-apper', count(*)::int FROM oauth_client WHERE tenant_id = $1
		 UNION ALL SELECT 'Aktive tokens', count(*)::int FROM oauth_token
			WHERE tenant_id = $1 AND kind = 'access' AND revoked = false AND expires_at > now()
		 UNION ALL SELECT 'Loggeinnslag', count(*)::int FROM audit_event WHERE tenant_id = $1`,
		[tenant.id]
	);

	return {
		loginLevels: LOGIN_LEVELS.map((level) => ({ code: level, ...LEVEL_TEXT[level] })),
		organisation: {
			loginLevel: tenant.login_level,
			id: tenant.id,
			name: tenant.name,
			organisation_number: tenant.organisation_number,
			herId: tenant.her_id,
			municipality_code: tenant.municipality_code,
			hostname: tenant.hostname,
			baseUrl: tenant.base_url,
			partitionId: tenant.partition_id,
			status: tenant.status,
			note: tenant.note,
			created_at: new Date(tenant.created_at).toLocaleString('nb-NO')
		},
		isPlatform: tenant.id === PLATFORM_TENANT,
		fhirBaseUrl: fhirBaseFor(tenant),
		issuer: issuerFor(tenant),
		wellKnown: `${issuerFor(tenant)}/.well-known/smart-configuration`,
		partitionExists:
			tenant.partition_id === null
				? null
				: partitions.ok
					? partitions.partitions.some((p) => p.name === tenant.id)
					: null,
		partisjonsfeil: partitions.ok ? null : partitions.error,
		roles: users,
		number
	};
};

export const actions: Actions = {
	store: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('plattform:administrer')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		const text = (n: string) => String(form.get(n) ?? '').trim();

		const baseUrl = text('baseUrl');
		if (baseUrl) {
			try {
				new URL(baseUrl);
			} catch {
				return fail(400, { error: 'Ugyldig adresse (base_url).' });
			}
		}

		const result = await updateTenant(
			event.params.id,
			{
				name: text('navn') || undefined,
				hostname: text('vertsnavn').toLowerCase() || null,
				baseUrl: baseUrl || undefined,
				herId: text('herId') || null,
				municipality_code: text('kommunenummer') || null,
				loginLevel: isLoginLevel(text('innloggingsniva')) ? text('innloggingsniva') : undefined,
				note: text('merknad') || null
			},
			actorFromContext(ctx)
		);
		if (!result.ok) return fail(400, { error: result.error });
		return { stored: true };
	}
};
