import type { AppManifest, AppPermission } from '$lib/app-manifest';

export const permissions = [
	{ id: 'oppgjor:registrer', roles: ['behandler', 'resepsjon'] },
	{ id: 'oppgjor:send', roles: ['resepsjon'] }
] as const satisfies readonly AppPermission[];

export const manifest: AppManifest = {
	permissions,
	id: 'billing',
	name: 'Oppgjør',
	patientTab: { segment: 'oppgjor', label: 'Oppgjør', order: 40 },
	mainMenu: { href: '/oppgjor', label: 'Oppgjør', anyOf: ['oppgjor:registrer', 'oppgjor:send'], order: 20 },
	patientLink: { segment: 'oppgjor', label: 'Regningskort', order: 40 },
	workspaceCards: [{ id: 'oppgjor', title: 'Oppgjør', description: 'Regningskort som er klare for innsending.' }]
};
