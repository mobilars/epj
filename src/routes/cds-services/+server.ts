import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * CDS Hooks discovery.
 *
 * The record is both sides of this: it asks services registered by a practice,
 * and it offers one of its own. Kritisk informasjon is the obvious candidate -
 * severe allergies and conditions are exactly what should be said before
 * anything else happens, and a record that speaks CDS Hooks can show them
 * without embedding an app at all.
 *
 * Public, like every discovery document: it lists what exists. Each service
 * requires a JWT signed by the record when called - see cds/signing.ts - and
 * each accepts CDS Hooks 2.0 feedback at <service>/feedback.
 */
export const GET: RequestHandler = () =>
	json(
		{
			services: [
				{
					hook: 'patient-view',
					id: 'kritisk-informasjon',
					title: 'Kritisk informasjon',
					description:
						'Alvorlige allergier og tilstander som må være kjent før det gjøres noe annet. Leser fra journalen selv; Kjernejournal er ikke spurt.',
					prefetch: {
						allergies: 'AllergyIntolerance?patient={{context.patientId}}',
						conditions: 'Condition?patient={{context.patientId}}'
					}
				},
				{
					hook: 'patient-view',
					id: 'manglende-maalinger',
					title: 'Oppfølging som mangler',
					description:
						'Foreslår målinger som ikke er registrert siste året for pasienter med tilstander som følges opp. Et eksempel på hva et kort er godt for.'
				},
				{
					hook: 'patient-view',
					id: 'kalkulatorer',
					title: 'Kalkulatorer',
					description:
						'eGFR (CKD-EPI 2021) fra siste kreatinin, alder og kjønn, og BMI fra siste høyde og vekt. Sier hvilke målinger som ble brukt. Foreslår å registrere nedsatt nyrefunksjon som problem når eGFR er under 60.'
				},
				{
					hook: 'medication-prescribe',
					id: 'interaksjonssjekk',
					title: 'Interaksjonssjekk (demo)',
					description:
						'Advarer om kjente interaksjoner og registrerte allergier mens en resept skrives. Listen er tre oppføringer lang og er en demonstrasjon, ikke en kilde.'
				}
			]
		},
		{ headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } }
	);
