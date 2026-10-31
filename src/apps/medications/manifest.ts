import type { AppManifest } from '$lib/app-manifest';

export const manifest: AppManifest = {
	id: 'medications',
	name: 'Legemidler',
	// Shows SFM's screen in place of its own when SFM is switched on.
	dependsOn: ['sfm'],
	patientTab: { segment: 'legemidler', label: 'Legemidler', order: 20 },
	patientLink: { segment: 'legemidler', label: 'Legemidler og resepter', order: 20 },
	patientGoKey: { key: 'l', segment: 'legemidler', label: 'Legemidler' }
};
