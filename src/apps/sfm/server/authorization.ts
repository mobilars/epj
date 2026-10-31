/**
 * What a multi-tenant HelseID client tells HelseID about the practice and the
 * SFM journal at sign-in.
 *
 * Follows NHN's WebEPJSampleApp. Note the spelling: the JSON field is
 * `journal_id` with an underscore while the type has a hyphen. NHN says this is
 * for technical reasons.
 */

export const ORGANISATION_SYSTEM = 'urn:oid:1.0.6523';

interface PracticeIdentity {
	organisation_number: string;
	sfm_journal_id: string | null;
	sfm_parent_organisation_number: string | null;
}

/**
 * The `authorization_details` for a practice, or null when it has no journal id,
 * which is the single-tenant case: the client's own `sfm-id` claim says which
 * journal it is, and nothing needs to be sent.
 */
export function sfmAuthorizationDetails(practice: PracticeIdentity): unknown[] | null {
	if (!practice.sfm_journal_id) return null;
	const parent = practice.sfm_parent_organisation_number || practice.organisation_number;
	const child = practice.sfm_parent_organisation_number ? practice.organisation_number : null;
	return [
		{
			type: 'helseid_authorization',
			practitioner_role: {
				organization: {
					identifier: {
						system: ORGANISATION_SYSTEM,
						type: 'ENH',
						value: child ? `NO:ORGNR:${parent}:${child}` : `NO:ORGNR:${parent}`
					}
				}
			}
		},
		{ type: 'nhn:sfm:journal-id', value: { journal_id: practice.sfm_journal_id } }
	];
}
