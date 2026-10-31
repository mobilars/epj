import type { AuthContext } from '$srv/authz/context';
import { registerLoginExtension } from '$srv/auth/login-extensions';
import { billingExtension } from './billing/server/extension';
import { messagesExtension } from './messages/server/extension';
import { sfmLogin } from './sfm/server/extension';

/**
 * What apps add to the platform's own pages on the server. Imported once from
 * hooks.server.ts, which is also what registers an app's needs at sign-in.
 */

export interface WorkspaceNotice {
	text: string;
	href: string;
	linkText: string;
}

/** What each card on the work surface shows, by card id. */
export const workspaceCardLoaders: Record<string, (ctx: AuthContext) => Promise<unknown>> = {
	...messagesExtension.workspaceCards,
	...billingExtension.workspaceCards
};

/** Things worth saying at the top of the work surface. */
export async function workspaceNotices(ctx: AuthContext): Promise<WorkspaceNotice[]> {
	return (await Promise.all([messagesExtension.notices(ctx)])).flat();
}

/** Figures for the administration page. */
export async function adminFacts(): Promise<{ label: string; value: number }[]> {
	return (await Promise.all([messagesExtension.adminFacts()])).flat();
}

registerLoginExtension(sfmLogin);
