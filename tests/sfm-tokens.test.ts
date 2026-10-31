import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec, one } from '../src/platform/server/db/index';
import { hasTestDatabase, createTestDatabase, emptyTables, setIn, type TestDatabase } from './fixtures/db';
import {
	forgetHelseIdTokens,
	hasHelseIdTokens,
	storeHelseIdTokens
} from '../src/platform/server/auth/helseid-session-tokens';
import { endSessionById } from '../src/platform/server/auth/activesessions';
import { newId } from '../src/platform/server/util/ids';

const describeIf = hasTestDatabase() ? describe : describe.skip;

const SECRET = 'very-secret-access-token';
const tokens = {
	accessToken: SECRET,
	refreshToken: 'very-secret-refresh-token',
	expiresIn: 300,
	dpop: { privateJwk: { kty: 'EC', d: 'very-secret-key' }, publicJwk: { kty: 'EC' } }
};

/**
 * The clinician's HelseID token, kept for SFM.
 *
 * It is worth a good deal to anyone who gets hold of it, so what is tested is
 * that it is unreadable at rest and that it does not outlive the session.
 */
describeIf('kept HelseID tokens', () => {
	let db: TestDatabase;
	let sessionId: string;

	beforeAll(async () => {
		db = await createTestDatabase('sfmtokens');
	});
	afterAll(() => db?.riv());

	beforeEach(async () => {
		await emptyTables();
		const userId = newId();
		await setIn('INSERT INTO user_account (id, username, name) VALUES ($1, $2, $3)', [userId, `u${userId}`, 'Test']);
		sessionId = newId();
		await exec(
			`INSERT INTO user_session (id, token_hash, user_id, expires_at, amr)
			 VALUES ($1, $2, $3, now() + interval '1 hour', 'helseid')`,
			[sessionId, newId(), userId]
		);
	});

	it('keeps them encrypted', async () => {
		await storeHelseIdTokens(sessionId, tokens);
		const row = await one<{ encrypted: string }>('SELECT encrypted FROM helseid_session_token WHERE session_id = $1', [sessionId]);
		expect(row?.encrypted).toBeTruthy();
		expect(row?.encrypted).not.toContain('secret');
		expect(await hasHelseIdTokens(sessionId)).toBe(true);
	});

	it('replaces what a session had, rather than keeping two', async () => {
		await storeHelseIdTokens(sessionId, tokens);
		await storeHelseIdTokens(sessionId, { ...tokens, accessToken: 'newer' });
		const row = await one<{ count: number }>('SELECT count(*)::int AS count FROM helseid_session_token WHERE session_id = $1', [sessionId]);
		expect(row?.count).toBe(1);
	});

	it('forgets them on request', async () => {
		await storeHelseIdTokens(sessionId, tokens);
		await forgetHelseIdTokens(sessionId);
		expect(await hasHelseIdTokens(sessionId)).toBe(false);
	});

	it('stops being readable the moment the session ends', async () => {
		await storeHelseIdTokens(sessionId, tokens);
		await exec('UPDATE user_session SET ended = true WHERE id = $1', [sessionId]);
		expect(await hasHelseIdTokens(sessionId)).toBe(false);
	});

	it('deletes them when an administrator ends the session', async () => {
		await storeHelseIdTokens(sessionId, tokens);
		await endSessionById(sessionId);
		const row = await one('SELECT session_id FROM helseid_session_token WHERE session_id = $1', [sessionId]);
		expect(row).toBeNull();
	});

	it('sweeps up the tokens of ended sessions at the next sign-in', async () => {
		await storeHelseIdTokens(sessionId, tokens);
		await exec('UPDATE user_session SET ended = true WHERE id = $1', [sessionId]);
		const other = newId();
		const user = await one<{ user_id: string }>('SELECT user_id FROM user_session WHERE id = $1', [sessionId]);
		await exec(
			`INSERT INTO user_session (id, token_hash, user_id, expires_at, amr)
			 VALUES ($1, $2, $3, now() + interval '1 hour', 'helseid')`,
			[other, newId(), user!.user_id]
		);
		await storeHelseIdTokens(other, tokens);
		const stale = await one('SELECT session_id FROM helseid_session_token WHERE session_id = $1', [sessionId]);
		expect(stale).toBeNull();
	});

	it('goes when the session row does', async () => {
		await storeHelseIdTokens(sessionId, tokens);
		await exec('DELETE FROM user_session WHERE id = $1', [sessionId]);
		const row = await one('SELECT session_id FROM helseid_session_token WHERE session_id = $1', [sessionId]);
		expect(row).toBeNull();
	});
});
