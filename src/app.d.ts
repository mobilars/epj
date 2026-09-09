import type { AuthContext } from '$srv/authz/context';

declare global {
	namespace App {
		interface Locals {
			/** Autentisert kontekst for inneværende forespørsel (null for anonyme kall). */
			auth: AuthContext | null;
			/** Korrelasjons-ID som følger forespørselen gjennom logg og AuditEvent. */
			requestId: string;
			/** Klientens IP slik den er utledet fra betrodde proxy-headere. */
			clientIp: string;
		}
		interface Error {
			code?: string;
			requestId?: string;
		}
	}
}

export {};
