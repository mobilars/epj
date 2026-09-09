import type { ScopeSett } from './scopes';
import type { Rettighet, Rolle } from './roles';

export type Autentiseringsmate = 'session' | 'smart-app' | 'backend-service';

export interface LaunchKontekst {
	patientId?: string | null;
	encounterId?: string | null;
	intent?: string | null;
	/** Referanse til brukeren slik SMART-appen ser den, f.eks. `Practitioner/42`. */
	fhirUser?: string | null;
	needPatientBanner?: boolean;
}

export interface AuthContext {
	mate: Autentiseringsmate;
	userId: string | null;
	/** `Practitioner/<id>` for helsepersonell, `Patient/<id>` for innbyggere. */
	actorRef: string;
	navn: string;
	roller: Rolle[];
	rettigheter: Set<Rettighet>;
	scopes: ScopeSett;
	clientId: string | null;
	clientNavn: string | null;
	launch: LaunchKontekst;
	sessionId: string | null;
	tokenId: string | null;
	/** Autentiseringsmetode: pwd, pwd+otp, helseid. */
	amr: string;
	/** Tidspunkt reautentisering er gyldig til (ISO), for handlinger som krever step-up. */
	elevertTil: string | null;
	ip: string;
	requestId: string;
}

export function harRettighet(ctx: AuthContext, rettighet: Rettighet): boolean {
	return ctx.rettigheter.has(rettighet);
}

export function erElevert(ctx: AuthContext): boolean {
	return ctx.elevertTil !== null && new Date(ctx.elevertTil).getTime() > Date.now();
}

export function erPasient(ctx: AuthContext): boolean {
	return ctx.roller.includes('pasient');
}

/** Pasient-id for en innbyggerbruker, ellers null. */
export function egenPasientId(ctx: AuthContext): string | null {
	if (!erPasient(ctx)) return null;
	return ctx.actorRef.startsWith('Patient/') ? ctx.actorRef.slice('Patient/'.length) : null;
}
