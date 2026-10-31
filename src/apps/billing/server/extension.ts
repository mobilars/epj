import type { AuthContext } from '$srv/authz/context';
import { listCard } from './helfo/billing';

export const billingExtension = {
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
