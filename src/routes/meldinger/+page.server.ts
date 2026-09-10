import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { actorFromContext } from '$srv/audit';
import { listMessages, markerProcessed, sendQueue, pendingKvitteringer } from '$srv/integrations/nhn/message-queue';

/** Meldingsinnboks for hele kontoret. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (!ctx.permissions.has('melding:les')) redirect(303, '/');

	const filter = event.url.searchParams.get('filter') ?? 'inn';
	const withoutReceipt = filter === 'uten-kvittering' ? await pendingKvitteringer(60) : [];

	const messages =
		filter === 'uten-kvittering'
			? withoutReceipt
			: await listMessages({ direction: filter === 'ut' ? 'ut' : 'inn', limit: 200 });

	return {
		filter,
		canSende: ctx.permissions.has('melding:send'),
		messages: messages.map((m) => ({
			id: m.id,
			type: m.message_type,
			direction: m.direction,
			part: m.recipient_name ?? m.sender_her_id ?? '',
			patientId: m.patient_id,
			status: m.status,
			apprec: m.apprec_status,
			detalj: m.status_detail,
			attempts: m.attempts,
			created_at: new Date(m.created_at).toLocaleString('nb-NO')
		}))
	};
};

export const actions: Actions = {
	processed: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx) redirect(303, '/logg-inn');
		if (!ctx.permissions.has('melding:les')) return fail(403, { error: 'Ingen tilgang.' });
		const form = await event.request.formData();
		await markerProcessed(String(form.get('id') ?? ''), actorFromContext(ctx));
		redirect(303, '/meldinger');
	},

	sendQueue: async (event) => {
		const ctx = event.locals.auth;
		if (!ctx?.permissions.has('melding:send')) return fail(403, { error: 'Ingen tilgang.' });
		const result = await sendQueue();
		return { ok: true, ...result };
	}
};
