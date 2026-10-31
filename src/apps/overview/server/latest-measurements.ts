import { codeText, codeValue } from '$srv/fhir/display';
import type { FhirResource } from '$srv/fhir/types';

/** When it was measured, which is not when it was written down. */
const measuredAt = (o: FhirResource) => String(o.effectiveDateTime ?? o.issued ?? o.meta?.lastUpdated ?? '');

/**
 * The newest value of each kind of measurement, newest first.
 *
 * A card of the patient's latest measurements answers what they are now, so a third
 * blood pressure from last year does not get a line of its own. A measurement marked
 * as a mistake is still in the record's history, but it is not one of these.
 */
export function latestMeasurements(observations: FhirResource[], limit = 12): FhirResource[] {
	const newestFirst = observations
		.filter((o) => o.status !== 'entered-in-error')
		.sort((a, b) => measuredAt(b).localeCompare(measuredAt(a)));
	const seen = new Set<string>();
	return newestFirst
		.filter((o) => {
			const kind = codeValue(o.code).code ?? codeText(o.code);
			if (seen.has(kind)) return false;
			seen.add(kind);
			return true;
		})
		.slice(0, limit);
}
