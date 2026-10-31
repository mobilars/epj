import type { AppManifest } from '$lib/app-manifest';

export const manifest: AppManifest = {
	id: 'sfm',
	name: 'Sentral forskrivningsmodul',
	practiceSettings: [
		{
			key: 'journal_id',
			label: 'Journal-id i SFM',
			help: 'Bare med en multi-tenant HelseID-klient. Tom betyr ikke på SFM.',
			pattern: '^[\\w-]{1,100}$',
			invalid: 'Journal-id i SFM kan bare inneholde bokstaver, tall og bindestrek.'
		},
		{
			key: 'parent_organisation_number',
			label: 'Overordnet organisasjonsnummer',
			help: 'Toppnivået i Enhetsregisteret. Tomt når virksomheten selv er toppnivå.',
			inputMode: 'numeric',
			pattern: '^\\d{9}$',
			invalid: 'Overordnet organisasjonsnummer må være ni siffer.'
		}
	]
};
