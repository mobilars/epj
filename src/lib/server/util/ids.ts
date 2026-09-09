import { randomUUID, randomBytes } from 'node:crypto';

export const nyId = (): string => randomUUID();

/** Kryptografisk tilfeldig token i base64url, egnet for cookies og OAuth-koder. */
export function nyToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

export const naa = (): string => new Date().toISOString();

export function omSekunder(sekunder: number, fra = new Date()): string {
	return new Date(fra.getTime() + sekunder * 1000).toISOString();
}

export function erUtlopt(isoTid: string | null | undefined): boolean {
	if (!isoTid) return false;
	return new Date(isoTid).getTime() <= Date.now();
}
