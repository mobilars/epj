import type { AuthContext } from '$srv/authz/context';
import type { Tenant } from '$srv/tenant/context';

declare global {
	namespace App {
		interface Locals {
			/** Authenticated context for the current request (null for anonymous calls). */
			auth: AuthContext | null;
			/** Correlation id following the request through the log and AuditEvent. */
			requestId: string;
			/** The client's IP as derived from trusted proxy headers. */
			clientIp: string;
			/** The organisation the request concerns, derived from the hostname. */
			tenant: Tenant;
			/** True when the request arrived on the platform's own hostname. */
			isPlatform: boolean;
		}
		interface Error {
			code?: string;
			requestId?: string;
		}
	}
}

export {};
