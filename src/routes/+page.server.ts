import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { ressurser, sokRessurser } from '$srv/fhir/internt';
import { tilPasientVisning } from '$srv/fhir/visning';
import { listMeldinger, ventendeKvitteringer } from '$srv/integrasjoner/nhn/meldingsko';
import { listKort } from '$srv/integrasjoner/helfo/regningskort';
import { query } from '$srv/db';
import { krevTenant } from '$srv/tenant/kontekst';

/** Arbeidsflaten: dagens timer, uleste meldinger og oppgjør som venter. */
export const load: PageServerLoad = async (event) => {
	const ctx = event.locals.auth;
	if (!ctx) redirect(303, `/logg-inn?retur=${encodeURIComponent(event.url.pathname)}`);
	if (ctx.roller.length === 0) redirect(303, '/ingen-tilgang');
	// Plattformadministratorer har ingen klinisk arbeidsflate å komme til.
	if (ctx.rettigheter.has('plattform:administrer') && !ctx.rettigheter.has('journal:les')) {
		redirect(303, '/systemadmin');
	}

	const idag = new Date().toISOString().slice(0, 10);
	const kanLese = ctx.rettigheter.has('journal:les');
	const kanMelding = ctx.rettigheter.has('melding:les');
	const kanOppgjor = ctx.rettigheter.has('oppgjor:registrer') || ctx.rettigheter.has('oppgjor:send');

	const [timer, meldinger, kort, nodrett, uteKvittering] = await Promise.all([
		kanLese
			? sokRessurser(ctx, 'Appointment', { date: `ge${idag}`, _count: 25, _sort: 'date' }).catch(() => null)
			: Promise.resolve(null),
		kanMelding ? listMeldinger({ retning: 'inn', status: 'mottatt', grense: 15 }) : Promise.resolve([]),
		kanOppgjor ? listKort({ status: 'klar', grense: 500 }) : Promise.resolve([]),
		query<{ patient_id: string; utloper: string; begrunnelse: string }>(
			'SELECT patient_id, utloper, begrunnelse FROM break_glass WHERE user_id = $1 AND tenant_id = $2 AND utloper > now() ORDER BY utloper',
			[ctx.userId, krevTenant().id]
		),
		kanMelding ? ventendeKvitteringer(60) : Promise.resolve([])
	]);

	const pasientIder = [
		...new Set(
			(timer ? ressurser(timer) : [])
				.flatMap((a) => (a.participant as { actor?: { reference?: string } }[] | undefined) ?? [])
				.map((p) => p.actor?.reference)
				.filter((r): r is string => Boolean(r?.startsWith('Patient/')))
				.map((r) => r.slice('Patient/'.length))
		)
	];

	const pasienter = pasientIder.length
		? ressurser(await sokRessurser(ctx, 'Patient', { _id: pasientIder.join(','), _count: 50 })).map(tilPasientVisning)
		: [];
	const pasientKart = Object.fromEntries(pasienter.map((p) => [p.id, p]));

	return {
		timer: (timer ? ressurser(timer) : []).map((a) => {
			const deltaker = ((a.participant as { actor?: { reference?: string; display?: string } }[] | undefined) ?? [])
				.map((p) => p.actor?.reference)
				.find((r) => r?.startsWith('Patient/'));
			const pid = deltaker?.slice('Patient/'.length);
			return {
				id: a.id as string,
				start: a.start as string | undefined,
				status: a.status as string,
				beskrivelse: (a.description as string) ?? '',
				pasient: pid ? (pasientKart[pid] ?? null) : null
			};
		}),
		meldinger: meldinger.map((m) => ({
			id: m.id,
			type: m.meldingstype,
			avsender: m.mottaker_navn ?? m.avsender_her ?? 'Ukjent',
			opprettet: m.opprettet,
			patientId: m.patient_id
		})),
		oppgjor: {
			antallKlare: kort.length,
			sumRefusjonOre: kort.reduce((s, k) => s + k.refusjon_ore, 0)
		},
		nodrett: nodrett.map((n) => ({ patientId: n.patient_id, utloper: n.utloper, begrunnelse: n.begrunnelse })),
		uteKvittering: uteKvittering.length
	};
};
