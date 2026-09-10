import { describe, expect, it } from 'vitest';
import { sjekkUtgaendeUrl, UtgaendeFeil } from '../src/lib/server/util/utgaende';

/**
 * `jwks_uri` på en registrert app er en adresse journalen henter på vegne av
 * den som fylte ut skjemaet. Uten kontroll er det SSRF: en app registrert med
 * `jwks_uri` mot 169.254.169.254 eller mot HAPI ville fått journalen til å
 * hente adresser bare den selv kan nå (OWASP A10).
 */
describe('kontroll av utgående adresser', () => {
	const avvises = async (url: string): Promise<string> => {
		try {
			await sjekkUtgaendeUrl(url);
			return 'SLAPP GJENNOM';
		} catch (err) {
			return err instanceof UtgaendeFeil ? err.message : String(err);
		}
	};

	it('avviser http', async () => {
		expect(await avvises('http://example.com/jwks')).toMatch(/https/);
	});

	it('avviser loopback', async () => {
		expect(await avvises('https://127.0.0.1/jwks')).toMatch(/internt nett/);
		expect(await avvises('https://[::1]/jwks')).toMatch(/internt nett/);
	});

	it('avviser skyens metadatatjeneste', async () => {
		expect(await avvises('https://169.254.169.254/latest/meta-data/')).toMatch(/internt nett/);
	});

	it('avviser private adresseområder', async () => {
		for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1', '100.64.0.1']) {
			expect(await avvises(`https://${ip}/jwks`), ip).toMatch(/internt nett/);
		}
	});

	it('avviser IPv4-mappet IPv6 mot loopback', async () => {
		expect(await avvises('https://[::ffff:127.0.0.1]/jwks')).toMatch(/internt nett/);
	});

	it('avviser legitimasjon i adressen', async () => {
		expect(await avvises('https://bruker:hemmelig@example.com/jwks')).toMatch(/legitimasjon/);
	});

	it('avviser noe som ikke er en URL', async () => {
		expect(await avvises('ikke en url')).toMatch(/gyldig URL/);
	});

	it('avviser et navn som ikke kan slås opp', async () => {
		expect(await avvises('https://finnes-ikke.invalid/jwks')).toMatch(/slås opp/);
	});

	it('slipper gjennom en offentlig adresse', async () => {
		await expect(sjekkUtgaendeUrl('https://8.8.8.8/jwks')).resolves.toBeInstanceOf(URL);
	});
});
