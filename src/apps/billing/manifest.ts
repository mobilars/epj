import type { AppManifest } from '$lib/app-manifest';

export const manifest: AppManifest = {
	id: 'billing',
	name: 'Oppgjør',
	patientTab: { segment: 'oppgjor', label: 'Oppgjør', order: 40 },
	mainMenu: { href: '/oppgjor', label: 'Oppgjør', anyOf: ['oppgjor:registrer', 'oppgjor:send'], order: 20 },
	patientLink: { segment: 'oppgjor', label: 'Regningskort', order: 40 },
	workspaceCards: [{ id: 'oppgjor', title: 'Oppgjør', description: 'Regningskort som er klare for innsending.' }]
};
