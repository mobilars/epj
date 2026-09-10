import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
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

/** ICPC-2 codes where the demo data expects regular follow-up. */
const FOLLOW_UP: Record<string, { loinc: string; name: string }> = {
	K86: { loinc: '8480-6', name: 'blodtrykk' },
	K87: { loinc: '8480-6', name: 'blodtrykk' },
	T90: { loinc: '4548-4', name: 'HbA1c' }
};

const entries = (bundle: { entry?: { resource?: FhirResource }[] } | null): FhirResource[] =>
	(bundle?.entry ?? []).map((e) => e.resource as FhirResource).filter(Boolean);

export const POST: RequestHandler = async (event) => {
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

	const wanted = new Map<string, string>();
	for (const condition of entries(conditions)) {
		const codings = (condition.code as { coding?: { code?: string }[] })?.coding ?? [];
		for (const coding of codings) {
			const rule = coding.code ? FOLLOW_UP[coding.code] : undefined;
			if (rule) wanted.set(rule.loinc, rule.name);
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
		.map(([loinc, name]) => ({
			summary: `Ingen ${name} registrert siste året`,
			detail: latest.get(loinc)
				? `Siste måling: ${new Date(latest.get(loinc) as number).toLocaleDateString('nb-NO')}.`
				: 'Ingen måling er registrert i det hele tatt.',
			indicator: 'info' as const,
			source: { label: `${tenant.name} · oppfølging` }
		}));

	return json({ cards }, { headers: { 'cache-control': 'no-store' } });
};
