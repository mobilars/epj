import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HookCallerError, requireHookCaller } from '$srv/cds/signing';
import { newId } from '$srv/util/ids';
import { requireTenant } from '$srv/tenant/context';
import { fhirClient } from '$srv/fhir/client';
import type { FhirResource } from '$srv/fhir/types';

/**
 * Kritisk informasjon, as a CDS Hooks service.
 *
 * Answers `patient-view` with one card per thing that must be known before
 * anything else: a severe allergy, a condition marked severe. Nothing when
 * there is nothing - a service that always returns a card teaches people to
 * ignore cards.
 *
 * The record calling this is the record the data is in, so the reading is done
 * directly rather than through a token. That is only defensible because the
 * caller is the same installation; a service run by somebody else would have
 * to ask for a token and be logged like any other app.
 */

interface Card {
	/** Names the card, so feedback about it can say which one. */
	uuid?: string;
	summary: string;
	detail?: string;
	indicator: 'info' | 'warning' | 'critical';
	source: { label: string };
}

export const POST: RequestHandler = async (event) => {
	// Only the record itself may ask. Without this, anyone who found the URL
	// could post a patient id and be told what the record knows about them.
	try {
		await requireHookCaller(event);
	} catch (err) {
		if (err instanceof HookCallerError) return json({ error: err.message }, { status: err.status });
		throw err;
	}
	const body = (await event.request.json().catch(() => ({}))) as {
		context?: { patientId?: string; patient?: string };
	};
	const patientId = body.context?.patientId ?? body.context?.patient;
	if (!patientId) return json({ cards: [] });

	const tenant = requireTenant();
	const [allergies, conditions] = await Promise.all([
		fhirClient
			.search('AllergyIntolerance', new URLSearchParams({ patient: patientId, _count: '30' }))
			.catch(() => null),
		fhirClient.search('Condition', new URLSearchParams({ patient: patientId, _count: '60' })).catch(() => null)
	]);

	const entries = (bundle: { entry?: { resource?: FhirResource }[] } | null): FhirResource[] =>
		(bundle?.entry ?? []).map((e) => e.resource as FhirResource).filter(Boolean);

	const cards: Card[] = [];

	for (const a of entries(allergies)) {
		const clinical = (a.clinicalStatus as { coding?: { code?: string }[] })?.coding?.[0]?.code ?? 'active';
		if (clinical !== 'active') continue;
		const name =
			(a.code as { text?: string; coding?: { display?: string }[] })?.text ??
			(a.code as { coding?: { display?: string }[] })?.coding?.[0]?.display ??
			'Ukjent allergen';
		const high = a.criticality === 'high';
		const reactions = ((a.reaction as { manifestation?: { concept?: { text?: string } }[] }[]) ?? [])
			.flatMap((r) => (r.manifestation ?? []).map((m) => m.concept?.text))
			.filter(Boolean)
			.join(', ');
		cards.push({
			uuid: newId(),
			summary: `Allergi: ${name}`,
			detail: [high ? 'Registrert med høy risiko.' : null, reactions ? `Reaksjon: ${reactions}.` : null]
				.filter(Boolean)
				.join(' '),
			indicator: high ? 'critical' : 'warning',
			source: { label: tenant.name }
		});
	}

	for (const c of entries(conditions)) {
		const severity = (c.severity as { coding?: { code?: string }[] })?.coding?.[0]?.code;
		if (severity !== 'severe') continue;
		const name =
			(c.code as { text?: string; coding?: { display?: string }[] })?.text ??
			(c.code as { coding?: { display?: string }[] })?.coding?.[0]?.display ??
			'Alvorlig tilstand';
		cards.push({
			uuid: newId(),
			summary: `Alvorlig tilstand: ${name}`,
			indicator: 'warning',
			source: { label: tenant.name }
		});
	}

	return json({ cards }, { headers: { 'cache-control': 'no-store' } });
};
