import type { AppManifest } from '$lib/app-manifest';

export const manifest: AppManifest = {
	id: 'notes',
	name: 'Journalnotater',
	patientTab: { segment: 'notater', label: 'Journalnotater', order: 10 },
	patientLink: { segment: 'notater', label: 'Alle journalnotater', order: 10 },
	patientGoKey: { key: 'n', segment: 'notater', label: 'Journalnotater' },
	patientAction: { key: 'n', segment: 'notater', focusId: 'subjektivt', label: 'Nytt journalnotat' }
};
