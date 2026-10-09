import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { resources, searchResources } from '$srv/fhir/internal';
import { SYSTEM, validNorwegianNationalId } from '$srv/fhir/codesystems';
import { actorFromContext, log } from '$srv/audit';
import type { AuthContext } from '$srv/authz/context';
import { isConfigured as helseIdConfigured } from '$srv/auth/helseid';
import {
	identityInQuery,
	isIdentityNumberShape,
	isPatientId,
	needsConfirmation,
	openUrlForId,
	sourceLabel
} from '$srv/journal/openlink';

/**
 * Opens a patient's record from another program. See `openlink.ts` for the
 * rules and why they are what they are.
 *
 *   /apne/pasient?id=<record's patient id>[&kilde=<label>]
 *   /apne/pasient#fnr=<fødselsnummer>
 *
 * Nothing is resolved, and nothing about any patient is shown, until the
 * request is known to come from a session signed in with HelseID. What the user
 * then sees of the record is decided by the patient page this leads to, with
 * the same checks as if they had searched their way there.
 */

/** Where the request stands before any patient is looked at. */
type Gate =
	| { ok: true; ctx: AuthContext }
	| { ok: false; state: 'signed-out' | 'weak-login' | 'no-clinical-access' };

function gate(event: { locals: App.Locals }): Gate {
	const ctx = event.locals.auth;
	if (!ctx || ctx.mate !== 'session') return { ok: false, state: 'signed-out' };
	// A link must not ride on a weaker sign-in than the one the record trusts,
	// whatever this practice otherwise accepts.
	if (ctx.amr !== 'helseid') return { ok: false, state: 'weak-login' };
	if (!ctx.permissions.has('journal:les')) return { ok: false, state: 'no-clinical-access' };
	return { ok: true, ctx };
}

/**
 * Where to sign in. Straight to HelseID where it is set up, since that is the
 * only sign-in this page accepts; otherwise the ordinary sign-in page.
 */
function loginUrl(returnTo: string | null): string {
	const start = helseIdConfigured() ? '/logg-inn/helseid' : '/logg-inn';
	return returnTo ? `${start}?retur=${encodeURIComponent(returnTo)}` : start;
}

async function logOpening(ctx: AuthContext, patientId: string, by: 'id' | 'fødselsnummer', source: string | null) {
	// The read itself is logged by the patient page. This says how the user
	// came to be there, which the read alone cannot.
	await log(
		{
			type: 'rest',
			subtype: 'ekstern:åpne',
			action: 'E',
			outcome: '0',
			patientId,
			entityRef: `Patient/${patientId}`,
			details: { by, source: source ?? 'ukjent' }
		},
		actorFromContext(ctx)
	);
}

export const load: PageServerLoad = async (event) => {
	const params = event.url.searchParams;
	const source = sourceLabel(params.get('kilde'));

	// Refused even though the number has already been logged on its way here:
	// an address that works is an address that gets used.
	if (identityInQuery(params)) return { state: 'identity-in-query' as const };

	const id = params.get('id');
	const g = gate(event);
	if (!g.ok) {
		return {
			state: g.state,
			// Signing in may return to a link that names the patient by id. A
			// national number is not carried through sign-in: the fragment would
			// follow the redirects to the identity provider.
			loginUrl: loginUrl(isPatientId(id) ? openUrlForId(id, source) : null)
		};
	}

	if (id === null) return { state: 'fragment' as const, source };
	if (!isPatientId(id)) return { state: 'bad-id' as const };

	if (needsConfirmation(event.request.headers.get('sec-fetch-site'))) {
		return { state: 'confirm' as const, id, source };
	}

	await logOpening(g.ctx, id, 'id', source);
	redirect(303, `/pasienter/${id}`);
};

export const actions: Actions = {
	/** The user confirmed a link that came from another site. */
	open: async (event) => {
		const g = gate(event);
		if (!g.ok) return fail(403, { state: g.state });
		const form = await event.request.formData();
		const id = form.get('id');
		if (!isPatientId(id)) return fail(400, { state: 'bad-id' as const });
		await logOpening(g.ctx, id, 'id', sourceLabel(form.get('kilde')));
		redirect(303, `/pasienter/${id}`);
	},

	/**
	 * Finds the patient with a national identity number and opens the record.
	 *
	 * Posted by the page from the URL fragment. The search goes through the
	 * gateway like any other, so it is bounded by what the user may see and is
	 * logged; and because it is a form post, the record's same-origin check
	 * already refuses it from any other site.
	 */
	resolve: async (event) => {
		const g = gate(event);
		if (!g.ok) return fail(403, { state: g.state });
		const form = await event.request.formData();
		const number = form.get('fnr');
		const source = sourceLabel(form.get('kilde'));
		if (!isIdentityNumberShape(number) || !validNorwegianNationalId(number)) {
			return fail(400, { state: 'bad-number' as const });
		}

		// A fødselsnummer and a D-nummer are filed under different systems.
		let matches = resources(
			await searchResources(g.ctx, 'Patient', { identifier: `${SYSTEM.FNR}|${number}`, _count: 2 })
		);
		if (matches.length === 0) {
			matches = resources(
				await searchResources(g.ctx, 'Patient', { identifier: `${SYSTEM.DNR}|${number}`, _count: 2 })
			);
		}

		await log(
			{
				type: 'rest',
				subtype: 'pasientsøk',
				action: 'E',
				outcome: '0',
				details: { type: 'fødselsnummer', match: matches.length, source: source ?? 'ukjent' }
			},
			actorFromContext(g.ctx)
		);

		if (matches.length === 0) {
			return fail(404, { state: 'not-found' as const, canRegister: g.ctx.permissions.has('pasient:opprett') });
		}
		if (matches.length > 1) return fail(409, { state: 'not-unique' as const });

		const id = matches[0].id as string;
		if (!isPatientId(id)) error(500, 'Pasienten har en id journalen ikke kan lenke til.');
		await logOpening(g.ctx, id, 'fødselsnummer', source);
		redirect(303, `/pasienter/${id}`);
	}
};
