import type { AppManifest, AppPermission } from '$lib/app-manifest';

export const permissions = [
	{ id: 'resept:forskriv', roles: ['behandler'] },
	{ id: 'resept:fornye', roles: ['behandler'] }
] as const satisfies readonly AppPermission[];

export const manifest: AppManifest = {
	permissions,
	id: 'medications',
	name: 'Legemidler',
	// Shows SFM's screen in place of its own when SFM is switched on.
	dependsOn: ['sfm'],
	patientTab: { segment: 'legemidler', label: 'Legemidler', order: 20 },
	patientLink: { segment: 'legemidler', label: 'Legemidler og resepter', order: 20 },
	patientGoKey: { key: 'l', segment: 'legemidler', label: 'Legemidler' }
};
