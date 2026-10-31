/**
 * The conversation between the record's page and SFM's frame.
 *
 * SFM says it has loaded, the page logs it in, SFM says that worked, the page
 * opens the patient, SFM says that worked. Kept apart from the component so the
 * order and the checks can be tested without a browser.
 *
 * NHN's sample posts to `*` and reads every message. This does neither. The
 * login message carries the one-time code and the nonce, so it goes only to the
 * portal's own origin, and only messages from that frame at that origin count.
 * Anything else on the page, a framed app included, can neither read the code
 * nor pretend to be SFM.
 */

export type SfmState = 'loading' | 'signing-in' | 'opening' | 'ready' | 'failed';

export interface SfmLogin {
	code: string;
	nonce: string;
	apiEndpoint: string;
	metadata: Record<string, string>;
}

export interface HandshakeOptions {
	/** The origin the portal is served from. */
	portalOrigin: string;
	login: SfmLogin;
	ticket: string;
	post: (message: unknown, targetOrigin: string) => void;
	onState: (state: SfmState) => void;
}

export interface IncomingMessage {
	origin: string;
	/** True when the message came from the SFM frame's own window. */
	fromFrame: boolean;
	data: unknown;
}

export function createHandshake(options: HandshakeOptions) {
	let state: SfmState = 'loading';
	const set = (next: SfmState) => {
		state = next;
		options.onState(next);
	};

	return {
		get state() {
			return state;
		},
		/** Returns true when the message was SFM's and was acted on. */
		receive(message: IncomingMessage): boolean {
			if (!message.fromFrame || message.origin !== options.portalOrigin) return false;
			if (typeof message.data !== 'object' || message.data === null) return false;
			const data = message.data as Record<string, unknown>;

			if (state === 'loading' && 'clientLoaded' in data) {
				if (data.clientLoaded !== 'success') {
					set('failed');
					return true;
				}
				set('signing-in');
				options.post({ action: 'login', ...options.login }, options.portalOrigin);
				return true;
			}
			if (state === 'signing-in' && 'login' in data) {
				if (data.login !== 'success') {
					set('failed');
					return true;
				}
				set('opening');
				options.post(
					// `onBehalfOf` stays empty: the clinician acts as themselves.
					{ action: 'setPatient', ticket: options.ticket, showAllergies: true, onBehalfOf: '' },
					options.portalOrigin
				);
				return true;
			}
			if (state === 'opening' && 'setPatient' in data) {
				set(data.setPatient === 'success' ? 'ready' : 'failed');
				return true;
			}
			return false;
		}
	};
}
