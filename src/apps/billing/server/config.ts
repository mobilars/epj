/** Read when asked rather than at start-up, like the rest of an app's settings. */
export const helfoConfig = {
	/** Submission of billing cards to KUHR (settlement). */
	get settlementUrl(): string {
		return process.env.EPJ_HELFO_SETTLEMENT_URL ?? '';
	},
	/** Lookups against the exemption-card/copayment service. */
	get copaymentUrl(): string {
		return process.env.EPJ_HELFO_COPAYMENT_URL ?? '';
	},
	get agreementId(): string {
		return process.env.EPJ_HELFO_AGREEMENT_ID ?? '';
	}
};
