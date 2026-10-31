import type { LoginExtension } from '$srv/auth/login-extensions';
import { appSettings } from '$srv/tenant/app-settings';
import { sfmAuthorizationDetails } from './authorization';
import { sfmConfig } from './config';
import { endSfm } from './session-gateway';

/**
 * SFM acts as the signed-in clinician, so its scope belongs to the HelseID sign-in
 * and the token has to be kept. Asks for nothing while SFM is switched off.
 */
export const sfmLogin: LoginExtension = {
	scopes: () => (sfmConfig.full ? [sfmConfig.scope] : []),
	authorizationDetails: async (tenant) => {
		if (!sfmConfig.full) return null;
		const settings = await appSettings(tenant.id, 'sfm');
		return sfmAuthorizationDetails({
			organisation_number: tenant.organisation_number,
			sfm_journal_id: settings.journal_id ?? null,
			sfm_parent_organisation_number: settings.parent_organisation_number ?? null
		});
	},
	keepTokens: () => sfmConfig.full,
	onSignOut: async (sessionId) => {
		if (sfmConfig.full) await endSfm(sessionId);
	}
};
