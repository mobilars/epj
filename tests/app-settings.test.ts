import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrasjoner } from '../src/platform/server/db/migrate';
import { appSettings, practiceSettingsForm, readPracticeSettings, storePracticeSettings } from '../src/platform/server/tenant/app-settings';
import { createTestDatabase, hasTestDatabase, type TestDatabase } from './fixtures/db';

const JOURNAL = 'setting-sfm-journal_id';
const PARENT = 'setting-sfm-parent_organisation_number';

const form = (values: Record<string, string>) => (name: string) => values[name] ?? '';

describe('reading the settings an app declared', () => {
	it('takes values that match, and leaves an empty one to be removed', () => {
		const read = readPracticeSettings(form({ [JOURNAL]: 'journal-1' }));
		expect(read).toEqual({
			ok: true,
			values: [
				{ key: 'app:sfm:journal_id', value: 'journal-1' },
				{ key: 'app:sfm:parent_organisation_number', value: '' }
			]
		});
	});

	it("refuses a value the app does not accept, with the app's own message", () => {
		expect(readPracticeSettings(form({ [PARENT]: '123' }))).toEqual({
			ok: false,
			error: 'Overordnet organisasjonsnummer må være ni siffer.'
		});
		expect(readPracticeSettings(form({ [JOURNAL]: 'not valid!' })).ok).toBe(false);
	});
});

describe('migrations across the platform and the apps', () => {
	it('form one unbroken order, whichever folder each is in', () => {
		const versions = readMigrasjoner().map((m) => m.version);
		expect(versions).toEqual(versions.map((_, i) => i + 1));
	});

	it('finds the ones in an app', () => {
		const names = readMigrasjoner().map((m) => m.name);
		expect(names).toContain('note_template');
		expect(names).toContain('sfm_practice_settings');
	});
});

describe.runIf(hasTestDatabase())('storing the settings', () => {
	const TENANT = 'settings-test';

	let db: TestDatabase;

	beforeAll(async () => {
		db = await createTestDatabase('appsettings');
	});
	afterAll(() => db?.riv());

	it('keeps them per practice, and an empty value clears one', async () => {
		await storePracticeSettings(TENANT, [{ key: 'app:sfm:journal_id', value: 'j1' }, { key: 'app:sfm:parent_organisation_number', value: '100100126' }], 'u1');
		expect(await appSettings(TENANT, 'sfm')).toEqual({ journal_id: 'j1', parent_organisation_number: '100100126' });
		expect(await appSettings('another-practice', 'sfm')).toEqual({});

		await storePracticeSettings(TENANT, [{ key: 'app:sfm:journal_id', value: '' }], 'u1');
		expect(await appSettings(TENANT, 'sfm')).toEqual({ parent_organisation_number: '100100126' });
	});

	it('gives the form what is stored', async () => {
		const [group] = await practiceSettingsForm(TENANT);
		expect(group.app).toBe('Sentral forskrivningsmodul');
		expect(group.fields.find((f) => f.name === PARENT)?.value).toBe('100100126');
		expect(group.fields.find((f) => f.name === JOURNAL)?.value).toBe('');
	});
});
