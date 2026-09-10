import { exec, one } from '../db';
import { config } from '../config';
import { createTenant } from './tenant';
import { PLATFORM_TENANT, withTenant } from './context';
import { createUser } from '../auth/users';
import { newId } from '../util/ids';
import type { AuditActor } from '../audit';

/**
 * Trial organisations.
 *
 * Someone fills in a form and gets a working record of their own, with
 * themselves as its administrator. That means creating a real organisation,
 * with a real FHIR partition - a trial that is not the real thing teaches
 * nothing.
 *
 * What keeps it honest is what it is not: a trial holds synthetic data, its
 * sign-in is a code by email rather than HelseID, and it is recorded in a
 * table of its own so the platform can tell trials from customers without
 * guessing from names. An installation that sees real patients turns the whole
 * thing off with EPJ_PROVEKONTO.
 */

export interface TrialRequest {
	contactName: string;
	contactEmail: string;
	practiceName: string;
	/**
	 * Optional. With it recorded, the person's first HelseID sign-in attaches to
	 * this account instead of creating a new one without a role - which is what
	 * makes it possible to try the record the way a clinician would actually
	 * reach it.
	 */
	nationalId?: string;
	ip: string | null;
}

export interface TrialResult {
	tenantId: string;
	userId: string;
}

/**
 * A machine name from what was typed.
 *
 * It becomes the FHIR partition name and cannot be changed afterwards, so it
 * has to be something that survives being a database identifier - and unique,
 * with a short suffix rather than a counter, because a counter would tell the
 * next person how many trials exist.
 */
function slugFor(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[æ]/g, 'ae')
		.replace(/[ø]/g, 'o')
		.replace(/[å]/g, 'a')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 22);
	const suffix = newId().replace(/[^a-z0-9]/gi, '').slice(0, 5).toLowerCase();
	return `${base || 'prove'}-${suffix}`;
}

export async function trialsAreOpen(): Promise<boolean> {
	return config.tenant.trialsEnabled && Boolean(config.tenant.trialHostname);
}

/**
 * Creates the organisation and its first administrator.
 *
 * The administrator gets both `systemansvarlig` and `lege`: a trial with one
 * person in it is useless if that person cannot open a record, and useless
 * again if they cannot add colleagues. In a real practice those are two people
 * for good reason, and the trial's own user administration can split them.
 */
export async function createTrial(request: TrialRequest, actor: AuditActor): Promise<TrialResult | { error: string }> {
	const email = request.contactEmail.trim().toLowerCase();

	// One trial per address. Not a security boundary - a second address is free
	// - but it keeps an accidental double submission from making two.
	const existing = await one<{ tenant_id: string }>('SELECT tenant_id FROM trial WHERE contact_email = $1', [email]);
	if (existing) {
		return { error: 'Det finnes allerede en prøvekonto på denne adressen. Logg inn med e-postkoden.' };
	}

	const id = slugFor(request.practiceName || request.contactName);
	const base = config.tenant.trialHostname
		? `https://${config.tenant.trialHostname}`
		: config.baseUrl.replace(/\/$/, '');

	const result = await createTenant(
		{
			id,
			name: request.practiceName || `${request.contactName} (prøve)`,
			// Synthetic, and valid mod11: a trial has no organisation number, and
			// inventing one that looks real would put a fiction into a field other
			// systems read as fact.
			organisation_number: '999999999',
			// No hostname of its own: trials share one, and which organisation a
			// request belongs to follows from who is signed in.
			baseUrl: base,
			// A trial holds synthetic data and its users have no HelseID for it, so
			// the weakest level is the only workable one. A practice that later
			// becomes real changes this before it sees a real patient.
			loginLevel: 'epost',
			note: `Prøvekonto opprettet av ${request.contactName} <${email}>`
		},
		actor
	);
	if (!result.ok) return { error: result.error };

	const user = await withTenant(result.tenant, () =>
		createUser({
			username: email,
			name: request.contactName || email,
			email,
			nationalId: request.nationalId,
			roles: ['systemansvarlig', 'lege']
		})
	);

	await exec(
		'INSERT INTO trial (tenant_id, contact_name, contact_email, practice_name, ip) VALUES ($1,$2,$3,$4,$5)',
		[result.tenant.id, request.contactName, email, request.practiceName, request.ip]
	);

	return { tenantId: result.tenant.id, userId: user.id };
}

export async function isTrial(tenantId: string): Promise<boolean> {
	if (tenantId === PLATFORM_TENANT) return false;
	return Boolean(await one('SELECT tenant_id FROM trial WHERE tenant_id = $1', [tenantId]));
}
