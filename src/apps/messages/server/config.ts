/** Read when asked rather than at start-up, like the rest of an app's settings. */
export const nhnConfig = {
	get messageServerUrl(): string {
		return process.env.EPJ_NHN_MESSAGE_SERVER_URL ?? '';
	},
	get herId(): string {
		return process.env.EPJ_ORG_HER_ID ?? '0000000';
	},
	get addressRegistryUrl(): string {
		return process.env.EPJ_NHN_ADDRESSREGISTRY_URL ?? '';
	}
};
