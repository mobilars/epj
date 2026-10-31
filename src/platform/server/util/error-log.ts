/**
 * An error as it may be written to the log.
 *
 * A database error carries the offending values in `detail`, and printing the error
 * object prints those: a duplicate fødselsnummer ended up in the log in plain text.
 * The stack says where it went wrong, and the code and constraint say what.
 */
export function errorForLog(err: unknown): string {
	if (!(err instanceof Error)) return 'unknown error';
	const database = err as Error & { code?: unknown; constraint?: unknown };
	const facts = [
		typeof database.code === 'string' ? `code=${database.code}` : '',
		typeof database.constraint === 'string' ? `constraint=${database.constraint}` : ''
	].filter(Boolean);
	return [err.stack ?? err.message, ...facts].join(' ');
}
