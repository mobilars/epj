import type { AppManifest } from '$lib/app-manifest';

export const manifest: AppManifest = {
	id: 'overview',
	name: 'Pasientoversikt',
	patientTab: { segment: '', label: 'Oversikt', order: 0 },
	patientGoKey: { key: 'o', segment: '', label: 'Oversikt' },
	patientCards: [
		{ id: 'diagnoser', title: 'Diagnoser og problemer', description: 'Aktive diagnoser med ICPC-2-kode.' },
		{ id: 'kritisk', title: 'Kritisk informasjon', description: 'Allergier og intoleranser.' },
		{ id: 'legemidler', title: 'Legemidler i bruk', description: 'Aktive resepter.' },
		{ id: 'maalinger', title: 'Siste målinger og prøvesvar', description: 'De nyeste observasjonene.' },
		{ id: 'notater', title: 'Siste journalnotater', description: 'De siste konsultasjonsnotatene.' },
		{ id: 'kontakter', title: 'Kontakter', description: 'Konsultasjoner og andre kontakter.' },
		{ id: 'vaksiner', title: 'Vaksiner', description: 'Registrerte vaksinasjoner, når det finnes noen.' }
	]
};
