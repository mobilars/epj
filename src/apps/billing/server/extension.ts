import type { AuthContext } from '$srv/authz/context';
import { exec } from '$srv/db';
import { requireTenant } from '$srv/tenant/context';
import { listCard } from './helfo/billing';

export const billingExtension = {
	/** Billing cards and copayment lookups follow the patient when two records are joined. */
	movePatient: async (from: string, to: string) => {
		for (const table of ['billing_card', 'copayment_lookup']) {
			await exec(`UPDATE ${table} SET patient_id = $3 WHERE tenant_id = $1 AND patient_id = $2`, [requireTenant().id, from, to]);
		}
	},

	workspaceCards: {
		/** Settlement cards ready to send, for the card on the work surface. */
		oppgjor: async (ctx: AuthContext) => {
			const allowed = ctx.permissions.has('oppgjor:registrer') || ctx.permissions.has('oppgjor:send');
			const cards = allowed ? await listCard({ status: 'klar', limit: 500 }) : [];
			return {
				countKlare: cards.length,
				sumReimbursementOre: cards.reduce((sum, card) => sum + card.reimbursement_ore, 0)
			};
		}
	}
};
