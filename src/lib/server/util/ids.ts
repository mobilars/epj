import { randomUUID, randomBytes } from 'node:crypto';

export const newId = (): string => randomUUID();

/** Kryptografisk tilfeldig token i base64url, egnet for cookies og OAuth-koder. */
export function newToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

export const now = (): string => new Date().toISOString();

export function aboutSekunder(sekunder: number, from = new Date()): string {
	return new Date(from.getTime() + sekunder * 1000).toISOString();
}

export function isExpired(isoTid: string | null | undefined): boolean {
	if (!isoTid) return false;
	return new Date(isoTid).getTime() <= Date.now();
}
