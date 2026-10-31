import { describe, expect, it } from 'vitest';
import { APP_REDIRECT_CSP, appRedirectPage } from '../src/platform/server/auth/app-redirect-page';

describe('the page between the record and an app', () => {
	it('moves on to the address, keeping the code and state', () => {
		const page = appRedirectPage('https://app.example/callback?code=abc&state=xyz');
		expect(page).toContain('content="0;url=https://app.example/callback?code=abc&amp;state=xyz"');
		expect(page).toContain('href="https://app.example/callback?code=abc&amp;state=xyz"');
	});

	it('cannot be broken out of by what is in the address', () => {
		const page = appRedirectPage(`https://app.example/callback?state="><script>alert(1)</script>'`);
		expect(page).not.toContain('<script');
		expect(page).not.toContain('"><');
		// A quote would end the url part of the refresh and send the browser elsewhere.
		expect(page.match(/content="([^"]*)"/)?.[1]).not.toContain("'");
	});

	it('refuses something that is not an address', () => {
		expect(() => appRedirectPage('not an address')).toThrow();
	});

	it('loads nothing, and has no script to allow', () => {
		const page = appRedirectPage('https://app.example/callback');
		expect(page).not.toMatch(/<script|<link|src=/);
		expect(APP_REDIRECT_CSP).toContain("default-src 'none'");
		expect(APP_REDIRECT_CSP).not.toContain('script-src');
		expect(APP_REDIRECT_CSP).toContain("frame-ancestors 'self'");
	});
});
