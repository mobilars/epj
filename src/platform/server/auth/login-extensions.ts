import type { Tenant } from '../tenant/context';

/**
 * What an app may ask of the HelseID sign-in.
 *
 * Some national services act as the signed-in person, so their scope has to be
 * part of the sign-in itself, and the token has to be kept for later. Sign-in
 * belongs to the platform and knows nothing about those services: an app registers
 * what it needs here, and asks for nothing while it is switched off.
 */
export interface LoginExtension {
	/** Further scopes to ask HelseID for. */
	scopes(): string[];
	/** Sent in a signed request object, for a multi-tenant HelseID client. */
	authorizationDetails?(tenant: Tenant): Promise<unknown[] | null>;
	/** Whether the token should be kept for the length of the session. */
	keepTokens(): boolean;
	/** Called as the user signs out, while the token is still there. */
	onSignOut?(sessionId: string): Promise<void>;
}

const extensions: LoginExtension[] = [];

export function registerLoginExtension(extension: LoginExtension): void {
	extensions.push(extension);
}

export function loginExtensions(): readonly LoginExtension[] {
	return extensions;
}

/** A failure in an app must not stop anyone signing out. */
export async function notifySignOut(sessionId: string): Promise<void> {
	for (const extension of extensions) {
		await extension.onSignOut?.(sessionId).catch((err) => {
			console.error('[login] an app failed at sign-out', (err as Error).message);
		});
	}
}
