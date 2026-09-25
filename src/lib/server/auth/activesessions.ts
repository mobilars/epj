import { config } from '../config';
import { one, query } from '../db';
import { requireTenant } from '../tenant/context';

/**
 * Who is signed in to the practice right now.
 *
 * "Now" means what the session check itself would accept: not ended, not past
 * its expiry, and used within the idle timeout. A session that would be
 * refused on its next request is not someone who is signed in, and listing it
 * would make the page disagree with the record about who has access.
 */

export interface ActiveSession {
	id: string;
	user_id: string;
	name: string;
	username: string;
	created_at: string;
	last_active: string;
	amr: string | null;
	ip: string | null;
	user_agent: string | null;
	elevated_until: string | null;
}

export async function listActiveSessions(): Promise<ActiveSession[]> {
	return query<ActiveSession>(
		`SELECT s.id, s.user_id, u.name, u.username, s.created_at, s.last_active, s.amr, s.ip, s.user_agent, s.elevated_until
		 FROM user_session s
		 JOIN user_account u ON u.id = s.user_id
		 WHERE u.tenant_id = $1
		   AND s.ended = false
		   AND s.expires_at > now()
		   AND s.last_active > now() - make_interval(secs => $2)
		 ORDER BY s.last_active DESC`,
		[requireTenant().id, config.session.idleSeconds]
	);
}

/**
 * Ends one session in this practice. The next request on it is refused and the
 * user is sent to sign in again.
 *
 * Scoped through the user's practice, so a session id from another practice
 * ends nothing.
 */
export async function endSessionById(id: string): Promise<{ userId: string; name: string } | null> {
	const row = await one<{ user_id: string; name: string }>(
		`UPDATE user_session s SET ended = true
		 FROM user_account u
		 WHERE s.id = $1 AND s.ended = false AND u.id = s.user_id AND u.tenant_id = $2
		 RETURNING u.id AS user_id, u.name`,
		[id, requireTenant().id]
	);
	return row ? { userId: row.user_id, name: row.name } : null;
}

/**
 * A browser and operating system in a few words, from the user agent.
 *
 * Enough for an administrator to notice that a session is on a device it
 * should not be on. Not a fingerprint and not meant to be one: user agents are
 * whatever the browser says, and the order of the checks matters because Edge
 * and Chrome both say "Chrome", and Chrome also says "Safari".
 */
export function describeDevice(userAgent: string | null): string {
	if (!userAgent) return 'Ukjent';
	const ua = userAgent;
	const browser = /Edg\//.test(ua)
		? 'Edge'
		: /Firefox\//.test(ua)
			? 'Firefox'
			: /Chrome\//.test(ua)
				? 'Chrome'
				: /Safari\//.test(ua)
					? 'Safari'
					: 'Annen nettleser';
	const system = /Windows/.test(ua)
		? 'Windows'
		: /iPhone|iPad/.test(ua)
			? 'iOS'
			: /Mac OS X|Macintosh/.test(ua)
				? 'macOS'
				: /Android/.test(ua)
					? 'Android'
					: /Linux/.test(ua)
						? 'Linux'
						: 'ukjent system';
	return `${browser} på ${system}`;
}

/** The sign-in method as a user reads it. Norwegian: interface text. */
export function describeMethod(amr: string | null): string {
	if (amr === 'helseid') return 'HelseID';
	if (amr === 'epost') return 'E-postkode';
	if (amr === 'pwd+otp') return 'Passord og engangskode';
	if (amr === 'pwd') return 'Passord';
	return amr ?? 'Ukjent';
}
