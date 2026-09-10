import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { resources, searchResources } from '$srv/fhir/internal';
import { toPatientDisplay } from '$srv/fhir/display';
import { listMessages, pendingKvitteringer } from '$srv/integrations/nhn/message-queue';
import { listCard } from '$srv/integrations/helfo/billing';
import { query } from '$srv/db';
import { requireTenant } from '$srv/tenant/context';

/** Arbeidsflaten: dagens timer, uleste meldinger og oppgjør som venter. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (ctx.roles.length === 0) redirect(303, '/ingen-tilgang');
	// Plattformadministratorer har ingen klinisk arbeidsflate å komme til.
	if (ctx.permissions.has('plattform:administrer') && !ctx.permissions.has('journal:les')) {
		redirect(303, '/systemadmin');
	}

	const today = new Date().toISOString().slice(0, 10);
	const canLese = ctx.permissions.has('journal:les');
	const canMessage = ctx.permissions.has('melding:les');
	const canSettlement = ctx.permissions.has('oppgjor:registrer') || ctx.permissions.has('oppgjor:send');

	const [appointments, messages, card, emergencyAccess, outsideReceipt] = await Promise.all([
		canLese
			? searchResources(ctx, 'Appointment', { date: `ge${today}`, _count: 25, _sort: 'date' }).catch(() => null)
			: Promise.resolve(null),
		canMessage ? listMessages({ direction: 'inn', status: 'mottatt', limit: 15 }) : Promise.resolve([]),
		canSettlement ? listCard({ status: 'klar', limit: 500 }) : Promise.resolve([]),
		query<{ patient_id: string; expires_at: string; justification: string }>(
			'SELECT patient_id, expires_at, justification FROM break_glass WHERE user_id = $1 AND tenant_id = $2 AND expires_at > now() ORDER BY expires_at',
			[ctx.userId, requireTenant().id]
		),
		canMessage ? pendingKvitteringer(60) : Promise.resolve([])
	]);

	const patientIder = [
		...new Set(
			(appointments ? resources(appointments) : [])
				.flatMap((a) => (a.participant as { actor?: { reference?: string } }[] | undefined) ?? [])
				.map((p) => p.actor?.reference)
				.filter((r): r is string => Boolean(r?.startsWith('Patient/')))
				.map((r) => r.slice('Patient/'.length))
		)
	];

	const patients = patientIder.length
		? resources(await searchResources(ctx, 'Patient', { _id: patientIder.join(','), _count: 50 })).map(toPatientDisplay)
		: [];
	const patientKart = Object.fromEntries(patients.map((p) => [p.id, p]));

	return {
		appointments: (appointments ? resources(appointments) : []).map((a) => {
			const deltaker = ((a.participant as { actor?: { reference?: string; display?: string } }[] | undefined) ?? [])
				.map((p) => p.actor?.reference)
				.find((r) => r?.startsWith('Patient/'));
			const pid = deltaker?.slice('Patient/'.length);
			return {
				id: a.id as string,
				start: a.start as string | undefined,
				status: a.status as string,
				description: (a.description as string) ?? '',
				patient: pid ? (patientKart[pid] ?? null) : null
			};
		}),
		messages: messages.map((m) => ({
			id: m.id,
			type: m.message_type,
			sender: m.recipient_name ?? m.sender_her_id ?? 'Ukjent',
			created_at: m.created_at,
			patientId: m.patient_id
		})),
		settlement: {
			countKlare: card.length,
			sumReimbursementOre: card.reduce((s, k) => s + k.reimbursement_ore, 0)
		},
		emergencyAccess: emergencyAccess.map((n) => ({ patientId: n.patient_id, expires_at: n.expires_at, justification: n.justification })),
		outsideReceipt: outsideReceipt.length
	};
};
