import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createHandshake, type SfmState } from '../src/apps/sfm/handshake';
import { ORGANISATION_SYSTEM, sfmAuthorizationDetails } from '../src/apps/sfm/server/authorization';
import {
	GATEWAY_PATH,
	createNonce,
	openSfm,
	parseTicket,
	patientPortal
} from '../src/apps/sfm/server/session-gateway';
import { validDateDel, validNorwegianNationalId } from '../src/platform/server/fhir/codesystems';

/**
 * SFM Full, as far as it can be proved without NHN: the protocol's own rules,
 * and the checks this record adds on top of NHN's sample.
 */
describe('SFM session gateway', () => {
	it('uses the v2 paths, which take DPoP', () => {
		for (const path of Object.values(GATEWAY_PATH)) expect(path).toMatch(/^\/api\/v2\//);
	});

	it('makes a nonce whose hash is the SHA-512 of its 64 bytes', () => {
		const { nonce, nonceHash } = createNonce();
		const bytes = Buffer.from(nonce, 'base64');
		expect(bytes.length).toBe(64);
		expect(nonceHash).toBe(createHash('sha512').update(bytes).digest('base64'));
		expect(createNonce().nonce).not.toBe(nonce);
	});

	it('reads the ticket in each form the gateway may answer with', () => {
		const ticket = '44300220-455f-4333-b6e8-1464a7f44608';
		expect(parseTicket(ticket)).toBe(ticket);
		expect(parseTicket(` ${ticket}\n`)).toBe(ticket);
		expect(parseTicket(JSON.stringify(ticket))).toBe(ticket);
		expect(parseTicket(JSON.stringify({ patientTicket: ticket }))).toBe(ticket);
	});

	it('refuses an answer that is not a ticket', () => {
		expect(parseTicket('')).toBeNull();
		expect(parseTicket('{not json')).toBeNull();
		expect(parseTicket('{"other":"x"}')).toBeNull();
		expect(parseTicket('<html>error</html>')).toBeNull();
		expect(parseTicket('x'.repeat(201))).toBeNull();
	});

	it('only takes a patient portal over https', () => {
		expect(patientPortal({ patientportal: 'https://portal.test6.forskrivning.no/p' })).toBe('https://portal.test6.forskrivning.no/p');
		expect(patientPortal({ patientportal: 'http://portal.test6.forskrivning.no/p' })).toBeNull();
		expect(patientPortal({ patientportal: 'javascript:alert(1)' })).toBeNull();
		expect(patientPortal({ enterpriseportal: 'https://x/e' })).toBeNull();
		expect(patientPortal(undefined)).toBeNull();
	});

	it('sends nothing that identifies the patient to the browser', async () => {
		const pid = '13086510035';
		const launch = await openSfm('session', pid);
		expect(JSON.stringify(launch)).not.toContain(pid);
		expect(launch?.ticket).toBeTruthy();
	});
});

describe('what HelseID is told at sign-in', () => {
	const practice = { organisation_number: '999944582', sfm_journal_id: null, sfm_parent_organisation_number: null };

	it('sends nothing for a practice without a journal id', () => {
		expect(sfmAuthorizationDetails(practice)).toBeNull();
	});

	it('names parent and child for a sub-unit, in NHN documented form', () => {
		const details = sfmAuthorizationDetails({
			...practice,
			sfm_journal_id: '7fbfbcbd-6f08-4e95-9f7a-9d69c40f6a35',
			sfm_parent_organisation_number: '100100126'
		});
		expect(details).toEqual([
			{
				type: 'helseid_authorization',
				practitioner_role: {
					organization: {
						identifier: { system: ORGANISATION_SYSTEM, type: 'ENH', value: 'NO:ORGNR:100100126:999944582' }
					}
				}
			},
			{ type: 'nhn:sfm:journal-id', value: { journal_id: '7fbfbcbd-6f08-4e95-9f7a-9d69c40f6a35' } }
		]);
	});

	it('names only the parent for a practice that is its own top level', () => {
		const [role] = sfmAuthorizationDetails({ ...practice, sfm_journal_id: 'j' }) as { practitioner_role: { organization: { identifier: { value: string } } } }[];
		expect(role.practitioner_role.organization.identifier.value).toBe('NO:ORGNR:999944582');
	});
});

describe('the conversation with the frame', () => {
	const PORTAL = 'https://portal.test6.forskrivning.no';
	const login = { code: 'c', nonce: 'n', apiEndpoint: 'https://api', metadata: {} };

	function setup() {
		const sent: { message: Record<string, unknown>; target: string }[] = [];
		const states: SfmState[] = [];
		const handshake = createHandshake({
			portalOrigin: PORTAL,
			login,
			ticket: 't',
			post: (message, target) => sent.push({ message: message as Record<string, unknown>, target }),
			onState: (s) => states.push(s)
		});
		const fromSfm = (data: unknown) => handshake.receive({ origin: PORTAL, fromFrame: true, data });
		return { handshake, sent, states, fromSfm };
	}

	it('goes loaded, login, patient, ready, in that order', () => {
		const { sent, states, fromSfm } = setup();
		fromSfm({ clientLoaded: 'success' });
		expect(sent[0].message).toMatchObject({ action: 'login', code: 'c', nonce: 'n', apiEndpoint: 'https://api' });
		fromSfm({ login: 'success' });
		expect(sent[1].message).toMatchObject({ action: 'setPatient', ticket: 't', showAllergies: true });
		fromSfm({ setPatient: 'success' });
		expect(states).toEqual(['signing-in', 'opening', 'ready']);
	});

	it('sends the one-time code to the portal origin only, never to everyone', () => {
		const { sent, fromSfm } = setup();
		fromSfm({ clientLoaded: 'success' });
		fromSfm({ login: 'success' });
		for (const s of sent) expect(s.target).toBe(PORTAL);
	});

	it('ignores another origin, and another frame at the right origin', () => {
		const { handshake, sent } = setup();
		const data = { clientLoaded: 'success' };
		expect(handshake.receive({ origin: 'https://evil.example', fromFrame: true, data })).toBe(false);
		expect(handshake.receive({ origin: PORTAL, fromFrame: false, data })).toBe(false);
		expect(sent).toEqual([]);
		expect(handshake.state).toBe('loading');
	});

	it('does not open a patient on a success that comes out of order', () => {
		const { sent, fromSfm, handshake } = setup();
		expect(fromSfm({ login: 'success' })).toBe(false);
		expect(fromSfm({ setPatient: 'success' })).toBe(false);
		expect(sent).toEqual([]);
		expect(handshake.state).toBe('loading');
	});

	it('fails on a refused login, and never sends the ticket', () => {
		const { sent, states, fromSfm } = setup();
		fromSfm({ clientLoaded: 'success' });
		fromSfm({ login: 'failed' });
		expect(states.at(-1)).toBe('failed');
		expect(sent.some((s) => s.message.action === 'setPatient')).toBe(false);
	});

	it('ignores messages that are not objects', () => {
		const { fromSfm } = setup();
		for (const data of ['clientLoaded', null, 42, undefined]) expect(fromSfm(data)).toBe(false);
	});
});

/** Built here so the check digits are right: only the month offset is under test. */
function withCheckDigits(first: string): string | null {
	const w1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
	const w2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
	const digit = (s: string, w: number[]) => (11 - (w.reduce((n, v, i) => n + v * Number(s[i]), 0) % 11)) % 11;
	const k1 = digit(first, w1);
	if (k1 === 10) return null;
	const k2 = digit(first + k1, w2);
	return k2 === 10 ? null : `${first}${k1}${k2}`;
}

function synthetic(month: number): string {
	for (let individual = 100; individual < 400; individual++) {
		const n = withCheckDigits(`15${String(month).padStart(2, '0')}85${individual}`);
		if (n) return n;
	}
	throw new Error('no number');
}

describe('synthetic identity numbers', () => {
	function withSetting(value: string | undefined, run: () => void) {
		const before = process.env.EPJ_ALLOW_SYNTHETIC_IDS;
		if (value === undefined) delete process.env.EPJ_ALLOW_SYNTHETIC_IDS;
		else process.env.EPJ_ALLOW_SYNTHETIC_IDS = value;
		try {
			run();
		} finally {
			if (before === undefined) delete process.env.EPJ_ALLOW_SYNTHETIC_IDS;
			else process.env.EPJ_ALLOW_SYNTHETIC_IDS = before;
		}
	}

	it('accepts the SyntPop ranges when allowed, and reads the true birth date', () => {
		withSetting('true', () => {
			for (const month of [65 + 3, 80 + 3]) {
				const n = synthetic(month);
				expect(validNorwegianNationalId(n), n).toBe(true);
				expect(validDateDel(n)).toBe('1985-03-15');
			}
		});
	});

	it('refuses them when not allowed, as a clinical installation does', () => {
		withSetting('false', () => {
			for (const month of [65 + 3, 80 + 3]) expect(validNorwegianNationalId(synthetic(month))).toBe(false);
		});
	});

	it('refuses a month outside the ranges either way', () => {
		withSetting('true', () => {
			for (const month of [13, 78, 93]) expect(validDateDel(synthetic(month))).toBeNull();
		});
	});

	it('leaves ordinary numbers as they were', () => {
		withSetting('false', () => {
			expect(validNorwegianNationalId('13086510035')).toBe(true);
		});
	});
});
