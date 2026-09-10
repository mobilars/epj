import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { config } from '../config';

/**
 * A small SMTP client.
 *
 * The record sends few messages and they are all short: a sign-in code to a
 * developer, and little else. A dependency for that would be a dependency to
 * keep patched forever, in a system where the list of things that can reach
 * the network is itself a security property - so this speaks the handful of
 * SMTP verbs it needs and nothing more.
 *
 * STARTTLS on the submission port, then AUTH LOGIN. The connection is refused
 * outright if the server will not upgrade: a sign-in code is a credential, and
 * sending one in the clear would be worse than not sending it.
 */

const CRLF = '\r\n';

interface Reply {
	code: number;
	text: string;
}

/** Reads one SMTP reply, which may span several lines. */
function readReply(socket: Socket, timeoutMs: number): Promise<Reply> {
	return new Promise((resolve, reject) => {
		let buffer = '';
		const done = (fn: () => void) => {
			clearTimeout(timer);
			socket.off('data', onData);
			socket.off('error', onError);
			fn();
		};
		const timer = setTimeout(() => done(() => reject(new Error('SMTP-tjeneren svarte ikke i tide'))), timeoutMs);
		const onError = (err: Error) => done(() => reject(err));
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			// The last line of a reply has a space after the code; continuation
			// lines have a hyphen.
			const lines = buffer.split(CRLF).filter(Boolean);
			const last = lines[lines.length - 1];
			if (!last || !/^\d{3}[ ]/.test(last)) return;
			done(() => resolve({ code: Number(last.slice(0, 3)), text: buffer.trim() }));
		};
		socket.on('data', onData);
		socket.on('error', onError);
	});
}

async function say(socket: Socket, line: string | null, expect: number[], timeoutMs: number): Promise<Reply> {
	if (line !== null) socket.write(line + CRLF);
	const reply = await readReply(socket, timeoutMs);
	if (!expect.includes(Math.floor(reply.code / 100)) && !expect.includes(reply.code)) {
		throw new Error(`SMTP: uventet svar ${reply.text.slice(0, 200)}`);
	}
	return reply;
}

/** Folds a header value so no line exceeds what SMTP allows. */
function header(name: string, value: string): string {
	return `${name}: ${value.replace(/[\r\n]+/g, ' ')}`;
}

/**
 * Anything but plain ASCII goes as base64 with a charset, so Norwegian letters
 * survive. Simpler than quoted-printable and correct for short messages.
 */
function encodedWord(value: string): string {
	// eslint-disable-next-line no-control-regex
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export interface Message {
	to: string;
	subject: string;
	/** Plain text. These messages have no reason to be anything else. */
	text: string;
}

export async function sendEmail(message: Message): Promise<void> {
	const { host, port, user, password, from, fromName } = config.email;
	if (!host || !user || !password) throw new Error('E-post er ikke konfigurert (EPJ_SMTP_*)');

	const timeoutMs = 15_000;
	let socket: Socket = tcpConnect({ host, port });
	socket.setTimeout(timeoutMs);

	try {
		await say(socket, null, [2], timeoutMs); // greeting
		await say(socket, `EHLO ${new URL(config.baseUrl).hostname}`, [2], timeoutMs);
		await say(socket, 'STARTTLS', [2], timeoutMs);

		socket = tlsConnect({ socket, servername: host }) as unknown as Socket;
		await new Promise<void>((resolve, reject) => {
			socket.once('secureConnect' as never, () => resolve());
			socket.once('error', reject);
		});

		// EHLO again inside TLS: the server's capabilities are only trustworthy
		// once the connection is protected.
		await say(socket, `EHLO ${new URL(config.baseUrl).hostname}`, [2], timeoutMs);
		await say(socket, 'AUTH LOGIN', [334], timeoutMs);
		await say(socket, Buffer.from(user, 'utf8').toString('base64'), [334], timeoutMs);
		await say(socket, Buffer.from(password, 'utf8').toString('base64'), [2], timeoutMs);

		await say(socket, `MAIL FROM:<${from}>`, [2], timeoutMs);
		await say(socket, `RCPT TO:<${message.to}>`, [2], timeoutMs);
		await say(socket, 'DATA', [354], timeoutMs);

		const body = [
			header('From', `${encodedWord(fromName)} <${from}>`),
			header('To', message.to),
			header('Subject', encodedWord(message.subject)),
			header('Date', new Date().toUTCString()),
			header('MIME-Version', '1.0'),
			header('Content-Type', 'text/plain; charset=UTF-8'),
			header('Content-Transfer-Encoding', 'base64'),
			'',
			// Base64 in fixed-length lines, so nothing exceeds the line limit.
			(Buffer.from(message.text, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join(CRLF)
		].join(CRLF);

		// A line consisting of a single dot ends the message, so any such line in
		// the body has to be escaped. Base64 never produces one, but the rule
		// belongs with the code that writes the body rather than in a comment
		// somewhere else.
		socket.write(body.replace(/\r\n\./g, `${CRLF}..`) + CRLF + '.' + CRLF);
		await say(socket, null, [2], timeoutMs);
		await say(socket, 'QUIT', [2, 221], timeoutMs).catch(() => undefined);
	} finally {
		socket.destroy();
	}
}
