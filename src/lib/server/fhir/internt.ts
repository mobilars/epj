import { error } from '@sveltejs/kit';
import { utfor } from './gateway';
import { FhirError } from './outcome';
import type { AuthContext } from '../authz/context';
import type { Bundle, FhirResource } from './types';

/**
 * Journalens eget grensesnitt snakker med FHIR gjennom nøyaktig samme vokter
 * som eksterne apper. Det er ingen bakvei utenom tilgangskontroll og logging -
 * en feil i UI-koden kan ikke gi mer innsyn enn API-et gir.
 */

export async function lesRessurs(ctx: AuthContext, resourceType: string, id: string): Promise<FhirResource> {
	try {
		const svar = await utfor({ ctx, metode: 'GET', sti: `${resourceType}/${id}`, sok: new URLSearchParams() });
		return svar.ressurs;
	} catch (err) {
		throw tilKitFeil(err);
	}
}

export async function lesRessursHvisFinnes(
	ctx: AuthContext,
	resourceType: string,
	id: string
): Promise<FhirResource | null> {
	try {
		const svar = await utfor({ ctx, metode: 'GET', sti: `${resourceType}/${id}`, sok: new URLSearchParams() });
		return svar.ressurs;
	} catch {
		return null;
	}
}

export async function sokRessurser(
	ctx: AuthContext,
	resourceType: string,
	sok: Record<string, string | number | undefined> | URLSearchParams
): Promise<Bundle> {
	const params = sok instanceof URLSearchParams ? sok : new URLSearchParams(
		Object.entries(sok)
			.filter(([, v]) => v !== undefined && v !== '')
			.map(([k, v]) => [k, String(v)])
	);
	try {
		const svar = await utfor({ ctx, metode: 'POST', sti: `${resourceType}/_search`, sok: new URLSearchParams(), kropp: params });
		return svar.ressurs as Bundle;
	} catch (err) {
		throw tilKitFeil(err);
	}
}

export async function skrivRessurs(
	ctx: AuthContext,
	ressurs: FhirResource,
	id?: string
): Promise<FhirResource> {
	try {
		const svar = id
			? await utfor({ ctx, metode: 'PUT', sti: `${ressurs.resourceType}/${id}`, sok: new URLSearchParams(), kropp: { ...ressurs, id } })
			: await utfor({ ctx, metode: 'POST', sti: ressurs.resourceType, sok: new URLSearchParams(), kropp: ressurs });
		return svar.ressurs;
	} catch (err) {
		throw tilKitFeil(err);
	}
}

export async function pasientJournal(ctx: AuthContext, patientId: string, count = 200): Promise<Bundle> {
	const svar = await utfor({
		ctx, metode: 'GET', sti: `Patient/${patientId}/$everything`,
		sok: new URLSearchParams({ _count: String(count) })
	});
	return svar.ressurs as Bundle;
}

/** Trekker ut ressursene fra en søke-Bundle. */
export function ressurser(bundle: Bundle): FhirResource[] {
	return (bundle.entry ?? []).map((e) => e.resource).filter(Boolean) as FhirResource[];
}

function tilKitFeil(err: unknown): never {
	if (err instanceof FhirError) {
		error(err.status === 401 ? 401 : err.status === 403 ? 403 : err.status === 404 ? 404 : 500, {
			message: err.issues[0]?.diagnostics ?? 'FHIR-feil',
			code: err.issues[0]?.code
		});
	}
	throw err;
}
