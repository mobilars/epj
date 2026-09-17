import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HookCallerError, requireHookCaller } from '$srv/cds/signing';
import { log } from '$srv/audit';

/**
 * CDS Hooks feedback, for the record's own services.
 *
 * A caller tells the service what became of a card: taken, or set aside, and
 * why. Ours have nothing to learn from it yet - they have no model to tune -
 * but they accept it, because a record that speaks CDS Hooks 2.0 should be
 * able to send feedback to any service, its own included, and find the door
 * open. It is written to the security log, which is where a practice would
 * look to see how its decision support is being received.
 *
 * Signed like every call to a service: feedback about a card is a statement
 * about a patient's care, and it should not be possible to make it up.
 */

const OUR_SERVICES = new Set(['kritisk-informasjon', 'manglende-maalinger', 'interaksjonssjekk', 'kalkulatorer']);

export const POST: RequestHandler = async (event) => {
	if (!OUR_SERVICES.has(event.params.service)) {
		return json({ error: 'Ukjent tjeneste' }, { status: 404 });
	}
	let caller;
	try {
		caller = await requireHookCaller(event);
	} catch (err) {
		if (err instanceof HookCallerError) return json({ error: err.message }, { status: err.status });
		throw err;
	}

	const body = (await event.request.json().catch(() => ({}))) as {
		feedback?: { card?: string; outcome?: string; acceptedSuggestions?: { id: string }[]; overrideReason?: { reason?: { code?: string } } }[];
	};
	const items = Array.isArray(body.feedback) ? body.feedback : [];

	for (const item of items) {
		await log(
			{
				type: 'cds',
				subtype: 'feedback',
				action: 'E',
				outcome: '0',
				entityRef: `cds/${event.params.service}`,
				details: {
					card: item.card ?? null,
					outcome: item.outcome ?? null,
					accepted: (item.acceptedSuggestions ?? []).map((s) => s.id).join(' ') || null,
					reason: item.overrideReason?.reason?.code ?? null,
					caller: caller.iss
				}
			},
			{ userId: null, actorRef: 'Device/cds', name: 'beslutningsstøtte', role: null, clientId: null, ip: event.locals.clientIp, requestId: event.locals.requestId }
		);
	}

	return json({ received: items.length });
};

/** Anything but POST is a mistake about what this endpoint is. */
export const GET: RequestHandler = () => json({ error: 'Tilbakemelding sendes med POST' }, { status: 405 });
