import { one, exec, query, transaction } from '../db';
import { requireTenant } from '../tenant/context';
import { config } from '../config';
import { decrypt, hashPassword, encrypt, verifyPassword } from '../util/crypto';
import { newId } from '../util/ids';
import { isRole, permissionsForRoles, scopesForRoles, type Permission, type Role } from '../authz/roles';
import { verifyTotp } from './totp';

export interface User {
	id: string;
	tenant_id: string | null;
	username: string;
	name: string;
	email: string | null;
	hpr_number: string | null;
	practitioner_id: string | null;
	mfa_aktivert: boolean;
	status: string;
	must_change_password: boolean;
	failed_attempts: number;
	locked_until: string | null;
	last_login: string | null;
}

const USERFIELDS = `id, tenant_id, username, name, email, hpr_number, practitioner_id, mfa_aktivert,
	status, must_change_password, failed_attempts, locked_until, last_login`;

export async function getUser(id: string): Promise<User | null> {
	return one<User>(`SELECT ${USERFIELDS} FROM user_account WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2`, [
		id, requireTenant().id
	]);
}

/** Slår opp en bruker uten virksomhetsavgrensning. Kun for plattformpålogging. */
export async function getUserOnTversOfOrganisations(id: string): Promise<User | null> {
	return one<User>(`SELECT ${USERFIELDS} FROM user_account WHERE id = $1`, [id]);
}

export async function getUserAtUsername(username: string): Promise<User | null> {
	return one<User>(
		`SELECT ${USERFIELDS} FROM user_account WHERE lower(username) = lower($1) AND tenant_id IS NOT DISTINCT FROM $2`,
		[username, requireTenant().id]
	);
}

export async function listUsers(): Promise<(User & { roles: Role[] })[]> {
	const tenantId = requireTenant().id;
	const users = await query<User>(
		`SELECT ${USERFIELDS} FROM user_account WHERE tenant_id IS NOT DISTINCT FROM $1 ORDER BY name`,
		[tenantId]
	);
	const roles = await query<{ user_id: string; role: string }>(
		`SELECT r.user_id, r.role FROM role_assignment r
		 JOIN user_account u ON u.id = r.user_id
		 WHERE u.tenant_id IS NOT DISTINCT FROM $1
		   AND r.valid_from <= now() AND (r.valid_until IS NULL OR r.valid_until > now())`,
		[tenantId]
	);
	const map = new Map<string, Role[]>();
	for (const r of roles) {
		if (!isRole(r.role)) continue;
		map.set(r.user_id, [...(map.get(r.user_id) ?? []), r.role]);
	}
	return users.map((b) => ({ ...b, roles: map.get(b.id) ?? [] }));
}

export async function rolesFor(userId: string): Promise<Role[]> {
	// Rollen henger på brukeren, som allerede er virksomhetsavgrenset.
	const rows = await query<{ role: string }>(
		`SELECT role FROM role_assignment
		 WHERE user_id = $1 AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())`,
		[userId]
	);
	return rows.map((r) => r.role).filter(isRole);
}

export interface NewUser {
	username: string;
	name: string;
	email?: string;
	hprNumber?: string;
	practitionerId?: string;
	password?: string;
	roles: Role[];
	createdOf?: string;
	/** `null` gir en plattformadministrator uten virksomhet. */
	tenantId?: string | null;
}

export async function createUser(inValue: NewUser): Promise<User> {
	return transaction(async () => {
		const id = newId();
		await exec(
			`INSERT INTO user_account (id, tenant_id, username, name, email, hpr_number, practitioner_id, password_hash, must_change_password)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			[
				id, inValue.tenantId === undefined ? requireTenant().id : inValue.tenantId,
				inValue.username, inValue.name, inValue.email ?? null, inValue.hprNumber ?? null,
				inValue.practitionerId ?? null, inValue.password ? hashPassword(inValue.password) : null, inValue.password ? true : false
			]
		);
		for (const role of inValue.roles) {
			await exec('INSERT INTO role_assignment (id, user_id, role, assigned_by) VALUES ($1,$2,$3,$4)', [
				newId(), id, role, inValue.createdOf ?? null
			]);
		}
		const user = await getUserOnTversOfOrganisations(id);
		if (!user) throw new Error('Klarte ikke å opprette bruker');
		return user;
	});
}

export async function setRoles(userId: string, roles: Role[], tildeltOf: string): Promise<void> {
	await requireSammeOrganisation(userId);
	await transaction(async () => {
		await exec('UPDATE role_assignment SET valid_until = now() WHERE user_id = $1 AND valid_until IS NULL', [userId]);
		for (const role of roles) {
			await exec('INSERT INTO role_assignment (id, user_id, role, assigned_by) VALUES ($1,$2,$3,$4)', [newId(), userId, role, tildeltOf]);
		}
	});
}

/**
 * Kontrollerer at brukeren tilhører virksomheten i konteksten. Kalles før
 * endringer som tar en bruker-id utenfra.
 */
async function requireSammeOrganisation(userId: string): Promise<void> {
	const user = await getUser(userId);
	if (!user) throw new Error('Brukeren finnes ikke i denne virksomheten');
}

export async function setStatus(userId: string, status: 'aktiv' | 'sperret' | 'avsluttet'): Promise<void> {
	await requireSammeOrganisation(userId);
	await exec('UPDATE user_account SET status = $2, updated_at = now() WHERE id = $1', [userId, status]);
	if (status !== 'aktiv') {
		await exec('UPDATE user_session SET ended = true WHERE user_id = $1', [userId]);
		await exec("UPDATE oauth_token SET revoked = true, revoked_reason = 'bruker deaktivert' WHERE user_id = $1", [userId]);
	}
}

export async function setPassword(userId: string, password: string, mustByttes = false): Promise<void> {
	await requireSammeOrganisation(userId);
	await exec('UPDATE user_account SET password_hash = $2, must_change_password = $3, updated_at = now() WHERE id = $1', [
		userId, hashPassword(password), mustByttes
	]);
}

export type Innloggingsresultat =
	| { outcome: 'ok'; user: User; roles: Role[]; amr: string }
	| { outcome: 'krever-mfa'; user: User }
	| { outcome: 'feil-passord' }
	| { outcome: 'laast'; to: string }
	| { outcome: 'sperret' }
	| { outcome: 'ukjent-bruker' };

/**
 * Verifiserer brukernavn, passord og engangskode.
 *
 * Normen krever totrinnsverifisering for tilgang til helseopplysninger utenfor
 * virksomhetens eget nett. Vi krever det som standard, og teller feilede forsøk
 * per konto med midlertidig utestengelse.
 */
export async function logIn(username: string, password: string, totp?: string): Promise<Innloggingsresultat> {
	const row = await one<User & { password_hash: string | null; totp_secret_enc: string | null }>(
		`SELECT ${USERFIELDS}, password_hash, totp_secret_enc FROM user_account
		 WHERE lower(username) = lower($1) AND tenant_id IS NOT DISTINCT FROM $2`,
		[username, requireTenant().id]
	);
	if (!row || !row.password_hash) {
		// Bruk samme arbeidsmengde som ved gyldig bruker, for å ikke avsløre
		// om brukernavnet finnes.
		verifyPassword(password, hashPassword('dummy'));
		return { outcome: 'ukjent-bruker' };
	}
	if (row.status !== 'aktiv') return { outcome: 'sperret' };
	if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
		return { outcome: 'laast', to: row.locked_until };
	}

	// Et mislykket forsøk teller likt enten det var passordet eller engangskoden
	// som var feil. Teller vi bare passordet, får den som allerede har passordet
	// fritt spillerom til å gjette seksifret engangskode, og totrinnsverifiseringen
	// er da bare et forsinkende ledd.
	const registerError = async (): Promise<Innloggingsresultat> => {
		const attempts = row.failed_attempts + 1;
		const lock = attempts >= config.security.maxFailedLogins;
		await exec(
			`UPDATE user_account SET failed_attempts = $2, locked_until = CASE WHEN $3 THEN now() + ($4 || ' seconds')::interval ELSE locked_until END
			 WHERE id = $1`,
			[row.id, lock ? 0 : attempts, lock, String(config.security.lockoutSeconds)]
		);
		return { outcome: 'feil-passord' };
	};

	if (!verifyPassword(password, row.password_hash)) {
		return registerError();
	}

	if (row.mfa_aktivert && row.totp_secret_enc) {
		if (!totp) return { outcome: 'krever-mfa', user: row };
		if (!verifyTotp(decrypt(row.totp_secret_enc), totp)) {
			return registerError();
		}
	} else if (config.security.requireMfa) {
		return { outcome: 'krever-mfa', user: row };
	}

	await exec('UPDATE user_account SET failed_attempts = 0, locked_until = NULL, last_login = now() WHERE id = $1', [row.id]);
	const roles = await rolesFor(row.id);
	return { outcome: 'ok', user: row, roles, amr: row.mfa_aktivert ? 'pwd+otp' : 'pwd' };
}

export async function activateMfa(userId: string, secret: string, code: string): Promise<boolean> {
	await requireSammeOrganisation(userId);
	if (!verifyTotp(secret, code)) return false;
	await exec('UPDATE user_account SET totp_secret_enc = $2, mfa_aktivert = true, updated_at = now() WHERE id = $1', [
		userId, encrypt(secret)
	]);
	return true;
}

export async function hasMfa(userId: string): Promise<boolean> {
	const row = await one<{ mfa_aktivert: boolean }>(
		'SELECT mfa_aktivert FROM user_account WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2',
		[userId, requireTenant().id]
	);
	return row?.mfa_aktivert ?? false;
}

/** Verifiserer engangskode på nytt, f.eks. før nødrettstilgang. */
export async function confirmTotp(userId: string, code: string): Promise<boolean> {
	const row = await one<{ totp_secret_enc: string | null }>(
		'SELECT totp_secret_enc FROM user_account WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2',
		[userId, requireTenant().id]
	);
	if (!row?.totp_secret_enc) return false;
	return verifyTotp(decrypt(row.totp_secret_enc), code);
}

export function scopesForUser(roles: Role[]): Set<string> {
	return scopesForRoles(roles);
}

export function permissionsForUser(roles: Role[]): Set<Permission> {
	return permissionsForRoles(roles);
}
