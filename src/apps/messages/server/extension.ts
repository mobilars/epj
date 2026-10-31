import type { AuthContext } from '$srv/authz/context';
import { listMessages, pendingKvitteringer } from './nhn/message-queue';

/** How long a sent message may wait for its receipt before it is worth mentioning. */
const RECEIPT_MINUTES = 60;

export const messagesExtension = {
	workspaceCards: {
		/** New messages for the card on the work surface. */
		meldinger: async (ctx: AuthContext) => {
			if (!ctx.permissions.has('melding:les')) return { messages: [] };
			const messages = await listMessages({ direction: 'inn', status: 'mottatt', limit: 15 });
			return {
				messages: messages.map((m) => ({
					id: m.id,
					type: m.message_type,
					sender: m.recipient_name ?? m.sender_her_id ?? 'Ukjent',
					created_at: m.created_at
				}))
			};
		}
	},

	/** Shown at the top of the work surface, whichever cards are chosen. */
	notices: async (ctx: AuthContext) => {
		if (!ctx.permissions.has('melding:les')) return [];
		const waiting = (await pendingKvitteringer(RECEIPT_MINUTES)).length;
		return waiting > 0
			? [
					{
						text: `${waiting} sendte meldinger mangler applikasjonskvittering.`,
						href: '/meldinger?filter=uten-kvittering',
						linkText: 'Se hvilke'
					}
				]
			: [];
	},

	/** Figures for the administration page. */
	adminFacts: async () => [
		{
			label: 'Meldinger uten kvittering',
			value: (await pendingKvitteringer(RECEIPT_MINUTES).catch(() => [])).length
		}
	]
};
