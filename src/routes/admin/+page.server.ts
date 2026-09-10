import type { PageServerLoad } from './$types';
import { one } from '$srv/db';
import { verifyLogChain, unreviewedEmergencyAccess } from '$srv/audit';
import { fhirClient } from '$srv/fhir/client';
import { currentVersion } from '$srv/db/migrate';
import { config } from '$srv/config';
import { requireTenant } from '$srv/tenant/context';
import { pendingKvitteringer } from '$srv/integrations/nhn/message-queue';

/** Driftsoversikt: tilstand på avhengigheter, loggintegritet og saker til oppfølging. */
export const load: PageServerLoad = async () => {
	const tenant = requireTenant();
	const tenantId = tenant.id;
	const [countUsers, countApper, chain, emergencyAccess, fhirOppe, kvitteringer] = await Promise.all([
		one<{ n: number }>("SELECT count(*)::int AS n FROM user_account WHERE status = 'aktiv' AND tenant_id = $1", [tenantId]),
		one<{ n: number }>("SELECT count(*)::int AS n FROM oauth_client WHERE status = 'aktiv' AND tenant_id = $1", [tenantId]),
		verifyLogChain().catch(() => ({ valid: false, checked: 0 })),
		unreviewedEmergencyAccess().catch(() => []),
		fhirClient.isTilgjengelig(),
		pendingKvitteringer(60).catch(() => [])
	]);

	return {
		organisation: { id: tenant.id, name: tenant.name, organisation_number: tenant.organisation_number },
		countUsers: countUsers?.n ?? 0,
		countApper: countApper?.n ?? 0,
		logChain: chain,
		emergencyAccess: emergencyAccess.map((n) => ({
			seq: n.seq,
			timestamp: new Date(n.recorded).toLocaleString('nb-NO'),
			hvem: n.actor_name ?? '',
			patientId: n.patient_id ?? ''
		})),
		fhirOppe,
		pendingKvitteringer: kvitteringer.length,
		schemaVersion: await currentVersion().catch(() => 0),
		miljo: {
			integrations: config.integrations.modus,
			healthId: config.integrations.healthId.enabled,
			testLogin: config.testLogin.aktivert,
			mfa: config.security.requireMfa
		}
	};
};
