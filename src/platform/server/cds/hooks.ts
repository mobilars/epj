import { exec, one, query } from '../db';
import { requireTenant, issuerFor, fhirBaseFor } from '../tenant/context';
import { newId } from '../util/ids';
import { fetchOutbound } from '../util/outbound';
import type { AuthContext } from '../authz/context';
import type { FhirResource } from '../fhir/types';
import { signHookRequest, callerJwksUrl } from './signing';

/**
 * CDS Hooks: asking a service for advice at a defined moment.
 *
 * The record calls out when a patient's record is opened, when a
 * prescription is being written, and when one is signed, and the service
 * answers with cards - a warning, a suggestion, a link to an app. What comes
 * back is advice: a card cannot write to the record, cannot change what is on
 * screen, and cannot stop anyone doing anything. The clinician decides; the
 * service only gets to say something.
 *
 * A suggestion is advice with a shape. A card may carry one or more, each a
 * set of FHIR resources the service proposes creating; the clinician sees
 * them as buttons and presses one or none. What happens then is a write by
 * the clinician, through the same door as any other, judged by the same
 * rules - see acceptedActions() below. The service never writes.
 *
 * Two properties matter more than the protocol here:
 *
 * Nothing about a patient leaves the record unasked. The request carries the
 * patient's id and the FHIR endpoint, not their data - a service that wants
 * more has to ask for it with a token of its own, through the same door as
 * any app. That keeps the record's list of who has seen what honest.
 *
 * A service that is slow or down is skipped. Advice is not worth a record
 * that will not open, so every call has a short timeout and a failure shows
 * as a quiet note rather than an error page.
 *
 * Every call is signed, so a service can tell it was the record asking and
 * not anyone who found the URL - see signing.ts.
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

export interface SuggestionAction {
	type: 'create' | 'update' | 'delete';
	description?: string;
	resource?: FhirResource;
	resourceId?: string;
}

export interface Suggestion {
	label: string;
	uuid?: string;
	isRecommended?: boolean;
	actions?: SuggestionAction[];
}

export interface Card {
	uuid?: string;
	summary: string;
	detail?: string;
	indicator: 'info' | 'warning' | 'critical';
	source?: { label?: string; url?: string; icon?: string };
	links?: { label: string; url: string; type?: string; appContext?: string }[];
	suggestions?: Suggestion[];
	selectionBehavior?: 'at-most-one' | 'any';
	overrideReasons?: { code: string; display?: string; system?: string }[];
	/** Which service answered, so the interface can say where advice came from. */
	serviceTitle?: string;
	/** Enough to send feedback about the card later. */
	serviceId?: string;
	serviceBase?: string;
	hookInstance?: string;
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
	const base = baseUrl.replace(/\/$/, '').replace(/\/cds-services$/, '');
	const url = `${base}/cds-services`;

	const response = await fetchOutbound(url, {
		timeoutMs: TIMEOUT_MS,
		headers: { authorization: `Bearer ${await signHookRequest(base)}` }
	});
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
			[newId(), tenantId, base, service.id, service.hook, service.title ?? null, service.description ?? null, createdBy]
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
			const hookInstance = newId();
			try {
				const body = JSON.stringify({
					hookInstance,
					hook,
					// The endpoint, not the data. A service that wants more asks for it
					// with a token of its own, and that request is logged like any other.
					fhirServer: fhirBaseFor(tenant),
					context: { userId: ctx.actorRef, ...context }
				});
				const text = await fetchOutbound(`${service.discovery_url}/cds-services/${service.service_id}`, {
					method: 'POST',
					body,
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${await signHookRequest(service.discovery_url)}`
					},
					timeoutMs: TIMEOUT_MS
				});
				const parsed = JSON.parse(text) as { cards?: Card[] };
				return {
					cards: (parsed.cards ?? []).map((c) => ({
						...c,
						serviceTitle: service.title ?? service.service_id,
						serviceId: service.service_id,
						serviceBase: service.discovery_url,
						hookInstance
					})),
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

/**
 * Tells a service what became of its card.
 *
 * CDS Hooks 2.0 lets a service learn whether its advice was taken, so it can
 * get better or quieter. Best effort: a service that has no feedback endpoint,
 * or is down, must not turn a pressed button into an error.
 */
export async function sendFeedback(
	card: Pick<Card, 'uuid' | 'serviceId' | 'serviceBase' | 'hookInstance'>,
	outcome: 'accepted' | 'overridden',
	extra: { acceptedSuggestions?: { id: string }[]; overrideReason?: { code: string; display?: string }; note?: string } = {}
): Promise<boolean> {
	if (!card.uuid || !card.serviceId || !card.serviceBase) return false;
	try {
		await fetchOutbound(`${card.serviceBase}/cds-services/${card.serviceId}/feedback`, {
			method: 'POST',
			body: JSON.stringify({
				feedback: [
					{
						card: card.uuid,
						outcome,
						outcomeTimestamp: new Date().toISOString(),
						...(card.hookInstance ? { hookInstance: card.hookInstance } : {}),
						...(extra.acceptedSuggestions ? { acceptedSuggestions: extra.acceptedSuggestions } : {}),
						...(extra.overrideReason ? { overrideReason: { reason: extra.overrideReason, ...(extra.note ? { userComment: extra.note } : {}) } } : {})
					}
				]
			}),
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${await signHookRequest(card.serviceBase)}`
			},
			timeoutMs: TIMEOUT_MS
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * What a suggestion is allowed to do when the clinician presses it.
 *
 * Only creating, and only resources about the patient the card was about. A
 * service that proposes editing or deleting something existing, or writing
 * about another patient, gets nothing done and a reason why - the write is
 * still judged by scope, role and relationship afterwards, but this is where
 * a suggestion that should never have been made is stopped before it costs a
 * round trip. Anything that passes is written as the clinician, not as the
 * service.
 */
export function acceptedActions(
	suggestion: Suggestion,
	patientId: string
): { resources: FhirResource[]; refused: string[] } {
	const resources: FhirResource[] = [];
	const refused: string[] = [];
	for (const action of suggestion.actions ?? []) {
		if (action.type !== 'create') {
			refused.push(`${action.type} støttes ikke - et forslag kan bare opprette noe nytt`);
			continue;
		}
		const r = action.resource;
		if (!r || typeof r.resourceType !== 'string') {
			refused.push('forslaget mangler en ressurs');
			continue;
		}
		const subject = (r.subject ?? r.patient) as { reference?: string } | undefined;
		if (subject?.reference !== `Patient/${patientId}`) {
			refused.push(`${r.resourceType} gjelder ikke denne pasienten`);
			continue;
		}
		if (r.id) {
			refused.push(`${r.resourceType} har en id, og kan derfor ikke opprettes som ny`);
			continue;
		}
		resources.push(r);
	}
	return { resources, refused };
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

/** Where a service verifies the record's signature. */
export { callerJwksUrl };
