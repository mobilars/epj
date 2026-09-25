import { describe, expect, it } from 'vitest';
import { templateProblem } from '../src/lib/server/journal/templates';
import { describeDevice, describeMethod } from '../src/lib/server/auth/activesessions';
import { isTheme, themeAttribute } from '../src/lib/server/auth/settings';

const template = (over: Partial<Parameters<typeof templateProblem>[0]> = {}) => ({
	name: 'Årskontroll diabetes',
	title: 'Årskontroll',
	subjective: 'Symptomer:',
	objective: '',
	assessment: '',
	...over
});

describe('note templates', () => {
	it('accepts a named template with some text', () => {
		expect(templateProblem(template())).toBeNull();
	});

	it('refuses a template without a name, or with nothing in it', () => {
		expect(templateProblem(template({ name: '' }))).toMatch(/navn/);
		expect(templateProblem(template({ subjective: '', objective: '', assessment: '' }))).toMatch(/tom/);
	});

	it('refuses what the table would refuse, before the table has to', () => {
		expect(templateProblem(template({ name: 'x'.repeat(81) }))).toMatch(/80/);
		expect(templateProblem(template({ title: 'x'.repeat(201) }))).toMatch(/200/);
		expect(templateProblem(template({ assessment: 'x'.repeat(10001) }))).toMatch(/10000/);
	});
});

describe('signed-in sessions', () => {
	it('names the browser, telling Edge and Chrome apart', () => {
		const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0';
		const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
		const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
		const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
		expect(describeDevice(edge)).toBe('Edge på Windows');
		expect(describeDevice(chrome)).toBe('Chrome på Windows');
		expect(describeDevice(safari)).toBe('Safari på macOS');
		expect(describeDevice(firefox)).toBe('Firefox på Linux');
		expect(describeDevice(null)).toBe('Ukjent');
	});

	it('names every sign-in method the record creates sessions with', () => {
		expect(describeMethod('helseid')).toBe('HelseID');
		expect(describeMethod('epost')).toBe('E-postkode');
		expect(describeMethod('pwd')).toBe('Passord');
		expect(describeMethod('pwd+otp')).toBe('Passord og engangskode');
		expect(describeMethod(null)).toBe('Ukjent');
	});
});

describe('colour theme', () => {
	it('maps the stored choice to the stylesheet attribute, and nothing else to anything', () => {
		expect(themeAttribute('dark')).toBe('mork');
		expect(themeAttribute('light')).toBe('lys');
		expect(themeAttribute(null)).toBeNull();
		expect(themeAttribute('"><script>')).toBeNull();
	});

	it('accepts only light and dark as a stored theme', () => {
		expect(isTheme('light')).toBe(true);
		expect(isTheme('dark')).toBe(true);
		expect(isTheme('system')).toBe(false);
		expect(isTheme(null)).toBe(false);
	});
});
