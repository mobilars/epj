/** Read when asked rather than at start-up, so a test can change it. */
const flag = (name: string) => {
	const value = process.env[name];
	return value === '1' || value?.toLowerCase() === 'true';
};

export const sfmConfig = {
	/**
	 * SFM's own screen in the Legemidler tab (SFM Full). Off by default, because it
	 * adds the SFM scope to the HelseID sign-in, and a client not yet granted that
	 * scope would have every sign-in refused.
	 */
	get full(): boolean {
		return flag('EPJ_SFM_FULL');
	},
	get sessionGatewayUrl(): string {
		return process.env.EPJ_SFM_SESSION_URL ?? '';
	},
	get scope(): string {
		return process.env.EPJ_SFM_SCOPE ?? 'e-helse:sfm.api/sfm.api2';
	}
};
