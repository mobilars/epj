import type { AuthContext } from '$srv/authz/context';
import { exec } from '$srv/db';
import { requireTenant } from '$srv/tenant/context';
import { listMessages, pendingKvitteringer } from './nhn/message-queue';

/** How long a sent message may wait for its receipt before it is worth mentioning. */
const RECEIPT_MINUTES = 60;

export const messagesExtension = {
	/** Messages follow the patient when two records are joined. */
	movePatient: async (from: string, to: string) => {
		await exec('UPDATE message SET patient_id = $3 WHERE tenant_id = $1 AND patient_id = $2', [requireTenant().id, from, to]);
	},

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
