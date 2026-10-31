import type { RequestEvent } from '@sveltejs/kit';
import { sign, verify } from '../auth/jws';
import { activeSigningKey, jwks } from '../auth/keys';
import { issuerFor, requireTenant } from '../tenant/context';
import { newId } from '../util/ids';

/**
 * Who is asking, when the record calls a CDS service - and who is asking,
 * when something calls one of ours.
 *
 * CDS Hooks has the caller put a JWT in `Authorization`, signed with a key the
 * service can fetch from the caller's JWKS. Without it a service has no way to
 * know the request came from the record rather than from anyone who found the
 * URL. That mattered here more than it looked: the record's own services read
 * a patient's allergies and conditions straight out of the store for whatever
 * patient id was posted to them, and answered anyone at all.
 *
 * Same key as the tokens, so a service that trusts the record's JWKS trusts
 * these for free. Five minutes of life, a fresh jti each time, and `aud` set
 * to the service being called, so a token meant for one service cannot be
 * replayed at another.
 */

const LIFETIME_S = 5 * 60;

export async function signHookRequest(serviceBaseUrl: string): Promise<string> {
	const tenant = requireTenant();
	const key = await activeSigningKey();
	const now = Math.floor(Date.now() / 1000);
	const issuer = issuerFor(tenant);
	return sign(
		{
			iss: issuer,
			sub: issuer,
			aud: serviceBaseUrl,
			jti: newId(),
			iat: now,
			exp: now + LIFETIME_S,
			tenant: tenant.id
		},
		key.privatePem,
		key.kid,
		'JWT'
	);
}

/** Where a service fetches the caller's keys. In the header, as the specification has it. */
export function callerJwksUrl(): string {
	return `${issuerFor(requireTenant())}/oauth/jwks`;
}

export class HookCallerError extends Error {
	constructor(
		message: string,
		public readonly status: 401 | 403 = 401
	) {
		super(message);
	}
}

/**
 * Requires that a request to one of the record's own services was signed by
 * this record, for this service.
 *
 * The record calls its own services over the network like any other - that
 * is what makes them a demonstration of the protocol rather than a shortcut -
 * so they see the same JWT an outside service would. Verified against the
 * tenant's own keys, which the hostname has already chosen: a token signed by
 * one practice's key does not open another practice's service, even in the
 * same installation.
 */
export async function requireHookCaller(event: RequestEvent): Promise<{ iss: string; jti: string }> {
	const header = event.request.headers.get('authorization') ?? '';
	if (!header.toLowerCase().startsWith('bearer ')) {
		throw new HookCallerError('CDS-tjenesten krever et signert JWT i Authorization. Se docs/cds-hooks.md.');
	}
	const token = header.slice('bearer '.length).trim();

	const tenant = requireTenant();
	const issuer = issuerFor(tenant);
	let payload;
	try {
		payload = await verify(token, (await jwks()).keys, 'ES256');
	} catch (err) {
		throw new HookCallerError(`Signaturen kunne ikke bekreftes: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (payload.iss !== issuer) throw new HookCallerError('Tokenet er utstedt av noen andre enn denne journalen', 403);

	// The audience is the service's base, without the path to a particular
	// service - one token per call, but the same audience for the discovery
	// document and the service under it.
	const expected = event.url.origin;
	const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!aud.some((a) => typeof a === 'string' && a.replace(/\/$/, '') === expected)) {
		throw new HookCallerError(`Tokenet er ment for ${aud.join(', ')}, ikke for ${expected}`, 403);
	}
	if (typeof payload.jti !== 'string' || !payload.jti) throw new HookCallerError('Tokenet mangler jti');
	return { iss: payload.iss as string, jti: payload.jti };
}
