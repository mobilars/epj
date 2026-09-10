import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { actorFromContext } from '$srv/audit';
import { forhandsvis, generateSettlement, listSettlement, sendSettlement } from '$srv/integrations/helfo/settlement';
import { listCard } from '$srv/integrations/helfo/billing';
import { oreToKroner } from '$srv/integrations/helfo/tariffs';

/** Settlement towards Helfo: preview, generation and submission. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (!ctx.permissions.has('oppgjor:registrer') && !ctx.permissions.has('oppgjor:send')) redirect(303, '/');

	const today = new Date();
	const firstIManeden = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
	const from = event.url.searchParams.get('fra') ?? firstIManeden;
	const to = event.url.searchParams.get('til') ?? today.toISOString().slice(0, 10);

	const [forhand, settlement, avviste] = await Promise.all([
		forhandsvis(from, to),
		listSettlement(20),
		listCard({ status: 'avvist', limit: 50 })
	]);

	return {
		from,
		to,
		canSende: ctx.permissions.has('oppgjor:send'),
		forhand: {
			countCard: forhand.countCard,
			sumReimbursement: oreToKroner(forhand.sumReimbursementOre),
			sumCopayment: oreToKroner(forhand.sumCopaymentOre),
			warnings: forhand.warnings
		},
		avviste: avviste.map((k) => ({ id: k.id, date: k.date, patientId: k.patient_id, arsak: k.rejection ?? '', reimbursement: oreToKroner(k.reimbursement_ore) })),
		settlement: settlement.map((o) => ({
			id: o.id,
			period: `${o.period_from} – ${o.period_to}`,
			count: o.card_count,
			sumReimbursement: oreToKroner(o.sum_reimbursement_ore),
			status: o.status,
			created_at: new Date(o.created_at).toLocaleString('nb-NO'),
			sent_at: o.sent_at ? new Date(o.sent_at).toLocaleString('nb-NO') : null
		}))
	};
};

export const actions: Actions = {
	generate: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('oppgjor:send')) return fail(403, { error: 'Rollen din kan ikke generere oppgjør.' });
		const form = await event.request.formData();
		const response = await generateSettlement(String(form.get('fra')), String(form.get('til')), actorFromContext(ctx));
		if (!response.ok) return fail(400, { error: response.error });
		return { ok: true, message: 'Oppgjøret er generert og klart for innsending.' };
	},

	send: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('oppgjor:send')) return fail(403, { error: 'Rollen din kan ikke sende oppgjør.' });
		const form = await event.request.formData();
		const response = await sendSettlement(String(form.get('id')), actorFromContext(ctx));
		if (!response.ok) return fail(400, { error: response.error });
		return { ok: true, message: 'Oppgjøret er sendt til Helfo.' };
	}
};
