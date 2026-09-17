import { describe, expect, it } from 'vitest';
import { checkSecurityLevel } from '../src/lib/server/auth/helseid';

/**
 * Security level 4, or no sign-in.
 *
 * Health personnel sign in at level 4, and the record asks HelseID to say
 * which level a token was issued at. The case that matters is the missing
 * claim: it used to pass, on the reading that no claim meant no problem.
 */
describe('HelseID sikkerhetsnivå', () => {
	const LEVEL = 'helseid://claims/identity/security_level';

	it('admits level 4', () => {
		expect(checkSecurityLevel({ [LEVEL]: '4' })).toEqual({ ok: true, level: '4' });
		// HelseID has sent the level as a number in some environments.
		expect(checkSecurityLevel({ [LEVEL]: 4 })).toEqual({ ok: true, level: '4' });
	});

	it('refuses a lower level, and says which it got', () => {
		const result = checkSecurityLevel({ [LEVEL]: '3' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/fikk 3/);
	});

	it('refuses a token that does not say its level, and names the scope to ask for', () => {
		const result = checkSecurityLevel({ sub: 'x', name: 'Dr. Test' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/security_level/);
	});
});
