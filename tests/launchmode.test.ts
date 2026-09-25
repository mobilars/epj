import { describe, expect, it } from 'vitest';
import {
	LAUNCH_MODES,
	isLaunchMode,
	launchModeFlags,
	launchModeOf,
	type LaunchMode
} from '../src/lib/server/auth/launchmode';

/**
 * Three ways to put an app in front of the user, stored as two booleans.
 *
 * The rules that matter are the ones that keep the pair honest: every mode has
 * to survive a round trip through the flags, an unset app has to land on the
 * frame, and the pair the database forbids still has to resolve to one answer
 * rather than to whichever branch is tested first.
 */
describe('app launch mode', () => {
	it('survives a round trip through the stored flags', () => {
		for (const mode of LAUNCH_MODES) {
			const flags = launchModeFlags(mode);
			expect(launchModeOf({ open_in_new_tab: flags.openInNewTab, top_level_signin: flags.topLevelSignin })).toBe(mode);
		}
	});

	it('never writes both flags at once', () => {
		for (const mode of LAUNCH_MODES) {
			const flags = launchModeFlags(mode);
			expect(flags.openInNewTab && flags.topLevelSignin).toBe(false);
		}
	});

	it('treats an app with neither flag, and an app with no flags at all, as framed', () => {
		expect(launchModeOf({ open_in_new_tab: false, top_level_signin: false })).toBe('frame');
		expect(launchModeOf({})).toBe('frame');
	});

	it('resolves the pair the database forbids to a single answer', () => {
		expect(launchModeOf({ open_in_new_tab: true, top_level_signin: true })).toBe('window');
	});

	it('accepts only the three modes', () => {
		expect(isLaunchMode('frame')).toBe(true);
		expect(isLaunchMode('signin')).toBe(true);
		expect(isLaunchMode('window')).toBe(true);
		expect(isLaunchMode('ramme')).toBe(false);
		expect(isLaunchMode('')).toBe(false);
		expect(isLaunchMode(undefined)).toBe(false);
		expect(isLaunchMode(null)).toBe(false);
	});

	it('does not let a form choose a mode by sending something else', () => {
		const fromForm = (value: unknown): LaunchMode => (isLaunchMode(value) ? value : 'frame');
		expect(fromForm('window')).toBe('window');
		expect(fromForm('WINDOW')).toBe('frame');
		expect(fromForm(['window'])).toBe('frame');
	});
});
