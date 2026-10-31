import type { AppManifest } from '$lib/app-manifest';

export const manifest: AppManifest = {
	id: 'messages',
	name: 'Meldinger',
	patientTab: { segment: 'meldinger', label: 'Meldinger', order: 30 },
	mainMenu: { href: '/meldinger', label: 'Meldinger', anyOf: ['melding:les'], order: 10 },
	patientLink: { segment: 'meldinger', label: 'Send melding eller henvisning', order: 30 },
	goKey: { key: 'm', href: '/meldinger', label: 'Meldinger' },
	workspaceCards: [{ id: 'meldinger', title: 'Nye meldinger', description: 'Ubehandlede meldinger i innboksen.' }]
};
