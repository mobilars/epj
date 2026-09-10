import { exec, one, query } from '../db';
import { requireTenant, issuerFor, fhirBaseFor } from '../tenant/context';
import { newId } from '../util/ids';
import { fetchOutbound } from '../util/outbound';
import type { AuthContext } from '../authz/context';

/**
 * CDS Hooks: asking a service for advice at a defined moment.
 *
 * The record calls out when a patient's record is opened, and the service
 * answers with cards - a warning, a suggestion, a link to an app. What comes
 * back is advice and nothing more: a card cannot write to the record, cannot
 * change what is on screen, and cannot stop anyone doing anything. The
 * clinician decides; the service only gets to say something.
 *
 * Two properties matter more than the protocol here:
 *
 * Nothing about a patient leaves the record. The request carries the patient's
 * id and the FHIR endpoint, not their data - a service that wants more has to
 * ask for it with a token of its own, through the same door as any app. That
 * keeps the record's list of who has seen what honest.
 *
 * A service that is slow or down is skipped. Advice is not worth a record that
 * will not open, so every call has a short timeout and a failure shows as a
 * quiet note rather than an error page.
 */

export interface CdsService {
	id: string;
	discovery_url: string;
	service_id: string;
	hook: string;
	title: string | null;
	description: string | null;
	enabled: boolean;
}

export interface Card {
	summary: string;
	detail?: string;
	indicator: 'info' | 'warning' | 'critical';
	source?: { label?: string; url?: string };
	links?: { label: string; url: string; type?: string }[];
	/** Which service answered, so the interface can say where advice came from. */
	serviceTitle?: string;
}

const TIMEOUT_MS = 3000;

export async function listServices(): Promise<CdsService[]> {
	return query<CdsService>(
		`SELECT id, discovery_url, service_id, hook, title, description, enabled
		 FROM cds_service WHERE tenant_id = $1 ORDER BY title, service_id`,
		[requireTenant().id]
	);
}

/**
 * Reads a service's discovery document and records what it offers.
 *
 * The URL points at the base; `/cds-services` is where the list lives, by the
 * specification. Everything registered comes from what the service itself
 * says, so a service that renames a hook is not silently called with the old
 * one.
 */
export async function registerFromDiscovery(baseUrl: string, createdBy: string | null): Promise<number> {
	const tenantId = requireTenant().id;
	const url = baseUrl.replace(/\/$/, '').replace(/\/cds-services$/, '') + '/cds-services';

	const response = await fetchOutbound(url, { timeoutMs: TIMEOUT_MS });
	const document = JSON.parse(response) as {
		services?: { hook: string; id: string; title?: string; description?: string }[];
	};
	const services = document.services ?? [];

	for (const service of services) {
		if (!service.hook || !service.id) continue;
		await exec(
			`INSERT INTO cds_service (id, tenant_id, discovery_url, service_id, hook, title, description, created_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			 ON CONFLICT (tenant_id, discovery_url, service_id)
			 DO UPDATE SET hook = EXCLUDED.hook, title = EXCLUDED.title, description = EXCLUDED.description`,
			[newId(), tenantId, url.replace(/\/cds-services$/, ''), service.id, service.hook, service.title ?? null, service.description ?? null, createdBy]
		);
	}
	return services.length;
}

export async function setServiceEnabled(id: string, enabled: boolean): Promise<void> {
	await exec('UPDATE cds_service SET enabled = $2 WHERE id = $1 AND tenant_id = $3', [id, enabled, requireTenant().id]);
}

export async function removeService(id: string): Promise<void> {
	await exec('DELETE FROM cds_service WHERE id = $1 AND tenant_id = $2', [id, requireTenant().id]);
}

/**
 * Asks every service registered for a hook, and gathers the cards.
 *
 * All at once, and never for longer than the timeout: a record that waits for
 * the slowest adviser is worse than one that opens without advice. A service
 * that fails is left out, and the failure is returned so the interface can say
 * so quietly rather than pretending there was nothing to say.
 */
export async function callHook(
	hook: string,
	ctx: AuthContext,
	context: Record<string, unknown>
): Promise<{ cards: Card[]; failed: string[] }> {
	const services = (await listServices()).filter((s) => s.enabled && s.hook === hook);
	if (!services.length) return { cards: [], failed: [] };

	const tenant = requireTenant();
	const results = await Promise.all(
		services.map(async (service) => {
			try {
				const body = JSON.stringify({
					hookInstance: newId(),
					hook,
					// The endpoint, not the data. A service that wants more asks for it
					// with a token of its own, and that request is logged like any other.
					fhirServer: fhirBaseFor(tenant),
					context: { userId: ctx.actorRef, ...context }
				});
				const text = await fetchOutbound(`${service.discovery_url}/cds-services/${service.service_id}`, {
					method: 'POST',
					body,
					headers: { 'content-type': 'application/json' },
					timeoutMs: TIMEOUT_MS
				});
				const parsed = JSON.parse(text) as { cards?: Card[] };
				return {
					cards: (parsed.cards ?? []).map((c) => ({ ...c, serviceTitle: service.title ?? service.service_id })),
					failed: null as string | null
				};
			} catch {
				return { cards: [] as Card[], failed: service.title ?? service.service_id };
			}
		})
	);

	return {
		cards: results.flatMap((r) => r.cards),
		failed: results.map((r) => r.failed).filter((f): f is string => Boolean(f))
	};
}

export async function getService(id: string): Promise<CdsService | null> {
	return one<CdsService>(
		`SELECT id, discovery_url, service_id, hook, title, description, enabled
		 FROM cds_service WHERE id = $1 AND tenant_id = $2`,
		[id, requireTenant().id]
	);
}

/** The issuer, for a service that wants to know which record is calling. */
export function callerIssuer(): string {
	return issuerFor(requireTenant());
}
