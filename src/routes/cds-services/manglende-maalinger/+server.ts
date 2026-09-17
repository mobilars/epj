import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HookCallerError, requireHookCaller } from '$srv/cds/signing';
import { newId } from '$srv/util/ids';
import { fhirClient } from '$srv/fhir/client';
import { requireTenant } from '$srv/tenant/context';
import type { FhirResource } from '$srv/fhir/types';

/**
 * A sample service: measurements that are due.
 *
 * Answers `patient-view` with a suggestion when a patient with hypertension or
 * diabetes has no blood pressure or HbA1c recorded in the last twelve months.
 * Written to show what a card is good for - a quiet reminder about something
 * the clinician would otherwise have to carry in their head - rather than to
 * be a real clinical rule. The interval is a round number, not a guideline.
 */

const YEAR_MS = 365 * 24 * 3600 * 1000;

/**
 * ICPC-2 codes where the demo data expects regular follow-up, and what to
 * order when it is missing. A blood pressure is taken in the room; an HbA1c
 * is a lab order, so the suggestion is a ServiceRequest the clinician can
 * file with one press - the service proposes, the clinician signs.
 */
const FOLLOW_UP: Record<string, { loinc: string; name: string; orderable: boolean; display: string }> = {
	K86: { loinc: '8480-6', name: 'blodtrykk', orderable: false, display: 'Blodtrykk' },
	K87: { loinc: '8480-6', name: 'blodtrykk', orderable: false, display: 'Blodtrykk' },
	T90: { loinc: '4548-4', name: 'HbA1c', orderable: true, display: 'Hemoglobin A1c' }
};

const entries = (bundle: { entry?: { resource?: FhirResource }[] } | null): FhirResource[] =>
	(bundle?.entry ?? []).map((e) => e.resource as FhirResource).filter(Boolean);

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

	const [conditions, observations] = await Promise.all([
		fhirClient.search('Condition', new URLSearchParams({ patient: patientId, _count: '60' })).catch(() => null),
		fhirClient
			.search('Observation', new URLSearchParams({ patient: patientId, _count: '100', _sort: '-date' }))
			.catch(() => null)
	]);

	const wanted = new Map<string, (typeof FOLLOW_UP)[string]>();
	for (const condition of entries(conditions)) {
		const codings = (condition.code as { coding?: { code?: string }[] })?.coding ?? [];
		for (const coding of codings) {
			const rule = coding.code ? FOLLOW_UP[coding.code] : undefined;
			if (rule) wanted.set(rule.loinc, rule);
		}
	}
	if (!wanted.size) return json({ cards: [] });

	const latest = new Map<string, number>();
	for (const observation of entries(observations)) {
		const code = ((observation.code as { coding?: { code?: string }[] })?.coding ?? [])[0]?.code;
		const when = Date.parse((observation.effectiveDateTime as string) ?? '');
		if (!code || Number.isNaN(when)) continue;
		latest.set(code, Math.max(latest.get(code) ?? 0, when));
	}

	const tenant = requireTenant();
	const cards = [...wanted]
		.filter(([loinc]) => Date.now() - (latest.get(loinc) ?? 0) > YEAR_MS)
		.map(([loinc, rule]) => ({
			uuid: newId(),
			summary: `Ingen ${rule.name} registrert siste året`,
			detail: latest.get(loinc)
				? `Siste måling: ${new Date(latest.get(loinc) as number).toLocaleDateString('nb-NO')}.`
				: 'Ingen måling er registrert i det hele tatt.',
			indicator: 'info' as const,
			source: { label: `${tenant.name} · oppfølging` },
			...(rule.orderable
				? {
						selectionBehavior: 'at-most-one' as const,
						suggestions: [
							{
								label: `Rekvirer ${rule.display}`,
								uuid: newId(),
								isRecommended: true,
								actions: [
									{
										type: 'create' as const,
										description: `Oppretter en rekvisisjon (ServiceRequest) for ${rule.display}.`,
										resource: {
											resourceType: 'ServiceRequest',
											status: 'active',
											intent: 'order',
											priority: 'routine',
											category: [{ coding: [{ system: 'http://snomed.info/sct', code: '108252007', display: 'Laboratory procedure' }] }],
											code: { concept: { coding: [{ system: 'http://loinc.org', code: loinc, display: rule.display }], text: rule.display } },
											subject: { reference: `Patient/${patientId}` },
											authoredOn: new Date().toISOString(),
											reasonCode: [{ text: `Oppfølging: ingen ${rule.name} registrert siste året` }]
										}
									}
								]
							}
						]
					}
				: {})
		}));

	return json({ cards }, { headers: { 'cache-control': 'no-store' } });
};
