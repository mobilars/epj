/**
 * A small line chart, and reading measurements out of a search result.
 *
 * Shared by the apps here. SVG and no library, for the same reason as smart.js: an
 * app in this directory is one HTML file and these, with nothing to build.
 */
import { escapeHtml as esc } from '/smart.js';

const when = (o) => o.effectiveDateTime ?? o.effectivePeriod?.start ?? o.issued ?? null;
const hasCode = (o, codes) => (o.code?.coding ?? []).some((c) => codes.includes(c.code));

/**
 * The measurements carrying one of these LOINC codes, oldest first. A blood pressure
 * may be a value of its own or a component of a panel, so components are read as well.
 */
export function series(observations, codes) {
	const points = [];
	for (const o of observations) {
		const date = when(o);
		if (!date) continue;
		if (hasCode(o, codes) && typeof o.valueQuantity?.value === 'number') {
			points.push({ date, value: o.valueQuantity.value, unit: o.valueQuantity.unit ?? '' });
		}
		for (const part of o.component ?? []) {
			if (hasCode(part, codes) && typeof part.valueQuantity?.value === 'number') {
				points.push({ date, value: part.valueQuantity.value, unit: part.valueQuantity.unit ?? '' });
			}
		}
	}
	return points.sort((a, b) => new Date(a.date) - new Date(b.date));
}

export const latest = (points) => points[points.length - 1] ?? null;

export const dateText = (iso) => new Date(iso).toLocaleDateString('nb-NO', { day: '2-digit', month: '2-digit', year: 'numeric' });

/** Draws the points. One point is a dot and a number, and none is said in words. */
export function lineChart(points, { label }) {
	if (!points.length) return `<p class="svak liten">Ingen målinger av ${esc(label.toLowerCase())}.</p>`;

	const width = 520;
	const height = 150;
	const pad = { left: 44, right: 12, top: 12, bottom: 24 };
	const times = points.map((p) => new Date(p.date).getTime());
	const values = points.map((p) => p.value);
	const [t0, t1] = [Math.min(...times), Math.max(...times)];
	const span = Math.max(...values) - Math.min(...values);
	const margin = span ? span * 0.15 : Math.abs(values[0]) * 0.1 || 1;
	const [v0, v1] = [Math.min(...values) - margin, Math.max(...values) + margin];
	const x = (t) => (t1 === t0 ? (pad.left + width - pad.right) / 2 : pad.left + ((t - t0) / (t1 - t0)) * (width - pad.left - pad.right));
	const y = (v) => pad.top + (1 - (v - v0) / (v1 - v0)) * (height - pad.top - pad.bottom);
	const round = (v) => Math.round(v * 10) / 10;

	const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
	const dots = points
		.map((p, i) => `<circle cx="${x(times[i]).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3" fill="var(--primar)"><title>${esc(dateText(p.date))}: ${esc(p.value)} ${esc(p.unit)}</title></circle>`)
		.join('');
	const unit = points[points.length - 1].unit;

	return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}" style="width:100%;max-width:${width}px;height:auto">
		<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="var(--kant)" />
		<line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="var(--kant)" />
		<text x="${pad.left - 5}" y="${pad.top + 8}" text-anchor="end" font-size="10" fill="var(--svak)">${round(v1)}</text>
		<text x="${pad.left - 5}" y="${height - pad.bottom}" text-anchor="end" font-size="10" fill="var(--svak)">${round(v0)}</text>
		<text x="${pad.left}" y="${height - 8}" font-size="10" fill="var(--svak)">${esc(dateText(points[0].date))}</text>
		<text x="${width - pad.right}" y="${height - 8}" text-anchor="end" font-size="10" fill="var(--svak)">${esc(dateText(points[points.length - 1].date))}</text>
		${points.length > 1 ? `<path d="${line}" fill="none" stroke="var(--primar)" stroke-width="1.5" />` : ''}
		${dots}
	</svg>
	<div class="svak liten">Siste: <strong>${esc(points[points.length - 1].value)} ${esc(unit)}</strong>, ${esc(dateText(points[points.length - 1].date))}</div>`;
}
