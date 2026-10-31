import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { resources, searchResources } from '$srv/fhir/internal';
import { toPatientDisplay } from '$srv/fhir/display';
import { workspaceCardLoaders, workspaceNotices } from '$apps/registry.server';
import { query } from '$srv/db';
import { requireTenant } from '$srv/tenant/context';
import { resolveLayout } from '$srv/workspace/layout';

/** The work surface: today's appointments, unread messages and settlements waiting. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (ctx.roles.length === 0) redirect(303, '/ingen-tilgang');
	// Platform administrators have no clinical work surface to arrive at.
	if (ctx.permissions.has('plattform:administrer') && !ctx.permissions.has('journal:les')) {
		redirect(303, '/systemadmin');
	}

	const today = new Date().toISOString().slice(0, 10);
	// Which cards, in what order: the person's own arrangement, else the
	// practice's, else all of them.
	const layout = await resolveLayout('arbeidsflate', ctx.userId);
	const canLese = ctx.permissions.has('journal:les');

	// Each app fills its own card, and only for the cards this person shows.
	const loading = layout.cards.filter((id) => workspaceCardLoaders[id]);

	const [appointments, cardData, emergencyAccess, notices] = await Promise.all([
		canLese
			? searchResources(ctx, 'Appointment', { date: `ge${today}`, _count: 25, _sort: 'date' }).catch(() => null)
			: Promise.resolve(null),
		Promise.all(loading.map(async (id) => [id, await workspaceCardLoaders[id](ctx)] as const)).then((pairs) =>
			Object.fromEntries(pairs)
		),
		query<{ patient_id: string; expires_at: string; justification: string }>(
			'SELECT patient_id, expires_at, justification FROM break_glass WHERE user_id = $1 AND tenant_id = $2 AND expires_at > now() ORDER BY expires_at',
			[ctx.userId, requireTenant().id]
		),
		workspaceNotices(ctx)
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
		layout: layout.cards,
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
		cardData,
		emergencyAccess: emergencyAccess.map((n) => ({ patientId: n.patient_id, expires_at: n.expires_at, justification: n.justification })),
		notices
	};
};
