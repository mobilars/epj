import type { ScopeSet } from './scopes';
import type { Permission, Role } from './roles';

export type Autentiseringsmate = 'session' | 'smart-app' | 'backend-service';

export interface LaunchContext {
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
	name: string;
	roles: Role[];
	permissions: Set<Permission>;
	scopes: ScopeSet;
	clientId: string | null;
	clientName: string | null;
	launch: LaunchContext;
	sessionId: string | null;
	tokenId: string | null;
	/** Autentiseringsmetode: pwd, pwd+otp, helseid. */
	amr: string;
	/** Tidspunkt reautentisering er gyldig til (ISO), for handlinger som krever step-up. */
	elevatedTo: string | null;
	ip: string;
	requestId: string;
}

export function hasPermission(ctx: AuthContext, permission: Permission): boolean {
	return ctx.permissions.has(permission);
}

export function isElevated(ctx: AuthContext): boolean {
	return ctx.elevatedTo !== null && new Date(ctx.elevatedTo).getTime() > Date.now();
}

export function isPatient(ctx: AuthContext): boolean {
	return ctx.roles.includes('pasient');
}

/** Pasient-id for en innbyggerbruker, ellers null. */
export function ownPatientId(ctx: AuthContext): string | null {
	if (!isPatient(ctx)) return null;
	return ctx.actorRef.startsWith('Patient/') ? ctx.actorRef.slice('Patient/'.length) : null;
}
