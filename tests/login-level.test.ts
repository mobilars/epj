import { describe, expect, it } from 'vitest';
import { LOGIN_LEVELS, allows, isLoginLevel, levelOfMethod, methodIsEnough } from '../src/lib/server/auth/login-level';

/**
 * Hvor sterkt en bruker må bevise hvem hen er, per virksomhet.
 *
 * Poenget med å ordne måtene er at en virksomhet som strammer inn, slipper å
 * tenke på hvilke måter som må slås av. Testene her er derfor mest om
 * ordningen: at sterkere alltid holder, at svakere aldri gjør det, og at en
 * ukjent eller manglende verdi lander på noe trygt i stedet for å slippe alt
 * gjennom.
 */
describe('innloggingsnivå', () => {
	it('kjenner måten en økt ble opprettet på', () => {
		expect(levelOfMethod('helseid')).toBe('helseid');
		expect(levelOfMethod('epost')).toBe('epost');
		expect(levelOfMethod('pwd+otp')).toBe('passord');
		expect(levelOfMethod('pwd')).toBe('passord');
	});

	it('godtar det som er sterkt nok, og ikke det som er svakere', () => {
		// Krever e-post: alt holder.
		expect(methodIsEnough('epost', 'epost')).toBe(true);
		expect(methodIsEnough('pwd+otp', 'epost')).toBe(true);
		expect(methodIsEnough('helseid', 'epost')).toBe(true);

		// Krever passord: e-postkode er ikke nok.
		expect(methodIsEnough('epost', 'passord')).toBe(false);
		expect(methodIsEnough('pwd+otp', 'passord')).toBe(true);
		expect(methodIsEnough('helseid', 'passord')).toBe(true);

		// Krever HelseID: bare HelseID.
		expect(methodIsEnough('epost', 'helseid')).toBe(false);
		expect(methodIsEnough('pwd+otp', 'helseid')).toBe(false);
		expect(methodIsEnough('helseid', 'helseid')).toBe(true);
	});

	it('faller tilbake på passordnivå når verdien er ukjent', () => {
		// En rad med noe uventet i skal ikke slippe alt gjennom. Passord er det
		// eksisterende virksomheter allerede bruker, og dermed det trygge svaret.
		expect(methodIsEnough('epost', 'noe-annet')).toBe(false);
		expect(methodIsEnough('pwd+otp', '')).toBe(true);
		expect(methodIsEnough('helseid', 'tull')).toBe(true);
	});

	it('behandler en ukjent innloggingsmåte som passord, ikke som HelseID', () => {
		// Om noen legger til en ny måte uten å oppdatere denne fila, skal den
		// ikke arve det sterkeste nivået bare fordi den er ukjent.
		expect(methodIsEnough('noe-nytt', 'helseid')).toBe(false);
		expect(methodIsEnough('noe-nytt', 'passord')).toBe(true);
	});

	it('er enig med seg selv om hva som tilbys', () => {
		// `allows` er det siden bruker for å velge hvilke skjemaer den viser.
		// Viser den et skjema som ikke kan lykkes, er det verre enn ingen skjema.
		for (const needed of LOGIN_LEVELS) {
			for (const method of LOGIN_LEVELS) {
				expect(allows(needed, method)).toBe(methodIsEnough(method, needed));
			}
		}
	});

	it('kjenner igjen gyldige nivåer', () => {
		expect(isLoginLevel('helseid')).toBe(true);
		expect(isLoginLevel('passord')).toBe(true);
		expect(isLoginLevel('epost')).toBe(true);
		expect(isLoginLevel('HelseID')).toBe(false);
		expect(isLoginLevel('')).toBe(false);
	});
});
