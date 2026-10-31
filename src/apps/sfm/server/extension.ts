import type { LoginExtension } from '$srv/auth/login-extensions';
import { sfmAuthorizationDetails } from './authorization';
import { sfmConfig } from './config';
import { endSfm } from './session-gateway';

/**
 * SFM acts as the signed-in clinician, so its scope belongs to the HelseID sign-in
 * and the token has to be kept. Asks for nothing while SFM is switched off.
 */
export const sfmLogin: LoginExtension = {
	scopes: () => (sfmConfig.full ? [sfmConfig.scope] : []),
	authorizationDetails: (tenant) => (sfmConfig.full ? sfmAuthorizationDetails(tenant) : null),
	keepTokens: () => sfmConfig.full,
	onSignOut: async (sessionId) => {
		if (sfmConfig.full) await endSfm(sessionId);
	}
};
