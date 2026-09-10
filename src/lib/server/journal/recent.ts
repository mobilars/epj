import { query } from '../db';
import { requireTenant } from '../tenant/context';
import type { AuthContext } from '../authz/context';
import { searchResources, resources } from '../fhir/internal';
import { toPatientDisplay } from '../fhir/display';

/**
 * The patients a user has had open lately.
 *
 * Taken from the audit log rather than from a list of its own. Every lookup is
 * written there anyway, and a second record of who looked at whom would be one
 * more place holding exactly the fact the log exists to protect. It also keeps
 * itself honest: a patient the user no longer has a relationship to drops off
 * as soon as the lookups stop, and the name lookup below goes through the same
 * guard as everything else - so one they may not see does not appear at all.
 */
export async function recentPatients(
	ctx: AuthContext,
	limit = 8
): Promise<{ id: string; name: string; age: number | null }[]> {
	const rows = await query<{ patient_id: string }>(
		`SELECT patient_id FROM audit_event
		 WHERE tenant_id = $1 AND actor_user_id = $2 AND patient_id IS NOT NULL
		   AND recorded > now() - interval '30 days'
		 GROUP BY patient_id
		 ORDER BY max(recorded) DESC
		 LIMIT $3`,
		[requireTenant().id, ctx.userId, limit]
	);
	if (!rows.length) return [];

	const bundle = await searchResources(ctx, 'Patient', {
		_id: rows.map((r) => r.patient_id).join(','),
		_count: limit
	}).catch(() => null);
	if (!bundle) return [];

	const byId = new Map(resources(bundle).map((p) => [p.id as string, toPatientDisplay(p)]));
	// Keep the order the log gave: most recently opened first.
	return rows
		.map((r) => byId.get(r.patient_id))
		.filter((p): p is NonNullable<typeof p> => Boolean(p))
		.map((p) => ({ id: p.id, name: p.name, age: p.age }));
}
