/**
 * How an app is put in front of the user.
 *
 * Three answers to one question, stored as two booleans because they arrived a
 * release apart. Everything that has to decide reads `launchModeOf`, and the
 * only thing that writes reads `launchModeFlags`, so the pair is never set
 * halfway and never read two different ways.
 *
 * - `frame`  the app is embedded, and the patient banner, tabs and task panel
 *            stay where they are. The right answer whenever the app can take
 *            it, because leaving the record mid-consultation and finding the
 *            way back to the same patient is what makes an app feel bolted on.
 * - `signin` the app is embedded, but the user signs in through a window of
 *            its own first. For apps that authenticate against an identity
 *            provider, which will not be framed at any price.
 * - `window` the app is its own top-level document for as long as it is open.
 *            For apps that cannot work as a third-party context at all.
 */
export type LaunchMode = 'frame' | 'signin' | 'window';

export const LAUNCH_MODES: LaunchMode[] = ['frame', 'signin', 'window'];

/** What the record stores against an app for each mode. */
export interface LaunchFlags {
	openInNewTab: boolean;
	topLevelSignin: boolean;
}

export function isLaunchMode(value: unknown): value is LaunchMode {
	return typeof value === 'string' && (LAUNCH_MODES as string[]).includes(value);
}

/**
 * The mode an app is in.
 *
 * `open_in_new_tab` wins if both are somehow set. The database forbids that
 * pair, but a row written before the constraint existed must still resolve to
 * one answer rather than to whichever branch happens to come first.
 */
export function launchModeOf(client: { open_in_new_tab?: boolean; top_level_signin?: boolean }): LaunchMode {
	if (client.open_in_new_tab) return 'window';
	if (client.top_level_signin) return 'signin';
	return 'frame';
}

export function launchModeFlags(mode: LaunchMode): LaunchFlags {
	return { openInNewTab: mode === 'window', topLevelSignin: mode === 'signin' };
}

/** What the mode is called where a user reads it. Norwegian: this is interface text. */
export function launchModeLabel(mode: LaunchMode): string {
	if (mode === 'window') return 'åpnes i eget vindu';
	if (mode === 'signin') return 'pålogging i eget vindu, så i ramme';
	return 'åpnes i ramme';
}
