import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as oidc from 'openid-client';
import { helseIdConfiguration } from '../../auth/helseid';
import { config } from '../../config';
import { requireTenant } from '../../tenant/context';
import { sfmAccess, type SfmAccess } from './tokens';

/**
 * SFM's session gateway: what the record's server does so that SFM's own screen
 * can open in a frame, signed in as the clinician, on the right patient.
 *
 * Written from NHN's sequence diagrams and WebEPJSampleApp, on the v2 paths with
 * DPoP. Bearer is being withdrawn, so there is no reason to start on it. It has
 * not yet been run against NHN: see docs/sfm.md for what remains to be proved.
 *
 * The national identity number goes to the gateway and comes back as a ticket.
 * Only the ticket reaches the browser.
 */

export const GATEWAY_PATH = {
	createSession: '/api/v2/Session/create',
	refreshSession: '/api/v2/Session/refresh',
	endSession: '/api/v2/Session/end',
	patientTicket: '/api/v2/PatientTicket'
} as const;

/** The address of the local simulator, used in place of NHN in `mock` mode. */
export const SIMULATOR_PATH = '/sfm-simulator';

export class SfmGatewayError extends Error {
	constructor(
		readonly operation: string,
		readonly status: number
	) {
		super(`SFM session gateway refused ${operation}: ${status}`);
	}
}

/** What the page needs to open the frame. Holds no patient identity. */
export interface SfmLaunch {
	portalUrl: string;
	login: { code: string; nonce: string; apiEndpoint: string; metadata: Record<string, string> };
	ticket: string;
}

/**
 * A fresh nonce in its two forms. The hash goes to the gateway from the server,
 * the plain value reaches SFM through the browser, and SFM compares them: that
 * is what proves the two halves of the login belong together.
 */
export function createNonce(): { nonce: string; nonceHash: string } {
	const bytes = randomBytes(64);
	return {
		nonce: bytes.toString('base64'),
		nonceHash: createHash('sha512').update(bytes).digest('base64')
	};
}

/**
 * The ticket out of the gateway's answer. It comes as a bare value or, depending
 * on the `Accept` header, as JSON; NHN's documentation and sample each show a
 * different one, so all of them are read. Null when it is none of these.
 */
export function parseTicket(body: string): string | null {
	const text = body.trim();
	let value: unknown = text;
	if (text.startsWith('{') || text.startsWith('"')) {
		try {
			const parsed = JSON.parse(text) as unknown;
			value = typeof parsed === 'object' && parsed ? (parsed as { patientTicket?: unknown }).patientTicket : parsed;
		} catch {
			return null;
		}
	}
	return typeof value === 'string' && /^[\w-]{1,200}$/.test(value) ? value : null;
}

/** The portal that takes a patient. An address that is not https is refused. */
export function patientPortal(metadata: Record<string, string> | undefined): string | null {
	const address = metadata?.patientportal;
	if (!address) return null;
	try {
		return new URL(address).protocol === 'https:' ? address : null;
	} catch {
		return null;
	}
}

function requestHeaders(): Record<string, string> {
	return {
		'content-type': 'application/json',
		accept: 'application/json',
		'user-agent': 'EPJ/0.1.0 (+https://epj.apps.apus.no/kildekode)',
		// The lowest organisational unit care is given at.
		'x-point-of-care': requireTenant().organisation_number
	};
}

async function post(operation: string, path: string, body: unknown, access: SfmAccess): Promise<Response> {
	const base = config.integrations.sfm.sessionGatewayUrl.replace(/\/$/, '');
	if (!base) throw new Error('SFM session gateway is not configured (EPJ_SFM_SESSION_URL)');
	const response = await oidc.fetchProtectedResource(
		await helseIdConfiguration(),
		access.accessToken,
		new URL(`${base}${path}`),
		'POST',
		body === undefined ? undefined : JSON.stringify(body),
		new Headers(requestHeaders()),
		{ DPoP: access.dpop }
	);
	if (!response.ok) throw new SfmGatewayError(operation, response.status);
	return response;
}

const simulated = () => config.integrations.mode === 'mock';

/**
 * Creates a session and a ticket for one patient. Null when the session has no
 * token to do it with, which the page explains as a need to sign in again.
 */
export async function openSfm(sessionId: string, patientPid: string): Promise<SfmLaunch | null> {
	const { nonce, nonceHash } = createNonce();

	if (simulated()) {
		return {
			portalUrl: SIMULATOR_PATH,
			login: { code: randomUUID(), nonce, apiEndpoint: SIMULATOR_PATH, metadata: { patientportal: SIMULATOR_PATH } },
			ticket: randomUUID()
		};
	}

	const access = await sfmAccess(sessionId);
	if (!access) return null;

	const session = (await (await post('session', GATEWAY_PATH.createSession, { nonce: nonceHash }, access)).json()) as {
		code?: string;
		apiAddress?: string;
		metadata?: Record<string, string>;
	};
	const portalUrl = patientPortal(session.metadata);
	if (!session.code || !session.apiAddress || !portalUrl) throw new SfmGatewayError('session', 502);

	const answer = await post('ticket', GATEWAY_PATH.patientTicket, { patientPid }, access);
	const ticket = parseTicket(await answer.text());
	if (!ticket) throw new SfmGatewayError('ticket', 502);

	return {
		portalUrl,
		login: { code: session.code, nonce, apiEndpoint: session.apiAddress, metadata: session.metadata ?? {} },
		ticket
	};
}

/** Keeps SFM's session alive: renews the token, and tells SFM when it changed. */
export async function refreshSfm(sessionId: string): Promise<boolean> {
	if (simulated()) return true;
	const access = await sfmAccess(sessionId);
	if (!access) return false;
	if (access.renewed) await post('refresh', GATEWAY_PATH.refreshSession, undefined, access);
	return true;
}

/** Ends SFM's session on sign-out. NHN requires it. A failure must not stop the sign-out. */
export async function endSfm(sessionId: string): Promise<void> {
	if (simulated()) return;
	try {
		const access = await sfmAccess(sessionId);
		if (access) await post('end', GATEWAY_PATH.endSession, undefined, access);
	} catch (err) {
		console.error('[sfm] could not end the session', (err as Error).message);
	}
}
