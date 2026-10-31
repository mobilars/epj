import type { AppManifest, AppPermission } from '$lib/app-manifest';

export const permissions = [
	{ id: 'melding:les', roles: ['behandler', 'lab', 'resepsjon'] },
	{ id: 'melding:send', roles: ['behandler'] },
	{ id: 'melding:signer', roles: ['behandler'] }
] as const satisfies readonly AppPermission[];

export const manifest: AppManifest = {
	permissions,
	id: 'messages',
	name: 'Meldinger',
	patientTab: { segment: 'meldinger', label: 'Meldinger', order: 30 },
	mainMenu: { href: '/meldinger', label: 'Meldinger', anyOf: ['melding:les'], order: 10 },
	patientLink: { segment: 'meldinger', label: 'Send melding eller henvisning', order: 30 },
	goKey: { key: 'm', href: '/meldinger', label: 'Meldinger' },
	workspaceCards: [{ id: 'meldinger', title: 'Nye meldinger', description: 'Ubehandlede meldinger i innboksen.' }]
};
