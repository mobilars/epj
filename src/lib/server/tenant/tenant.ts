import { en, exec, query, transaction } from '../db';
import { medTenant, type Tenant } from './kontekst';
import { opprettPartisjon, listPartisjoner } from './partisjon';
import { logg, type AuditAktor } from '../audit';
import { gyldigOrganisasjonsnummer } from '../fhir/kodeverk';
import { opprettBruker } from '../auth/brukere';
import { nyToken } from '../util/ids';

/**
 * Virksomhetsregister.
 *
 * Dette er den eneste modulen som leser og skriver på tvers av virksomheter.
 * Den brukes bare av oppslaget som utleder virksomhet fra vertsnavn, og av
 * plattformadministrasjonen.
 */

const FELT = `id, navn, organisasjonsnummer, her_id, kommunenummer, vertsnavn, base_url,
	partisjon_id, status, merknad, opprettet`;

export async function hentTenant(id: string): Promise<Tenant | null> {
	return en<Tenant>(`SELECT ${FELT} FROM tenant WHERE id = $1`, [id]);
}

export async function hentTenantPaVertsnavn(vertsnavn: string): Promise<Tenant | null> {
	return en<Tenant>(`SELECT ${FELT} FROM tenant WHERE lower(vertsnavn) = lower($1)`, [vertsnavn]);
}

export async function listTenanter(): Promise<Tenant[]> {
	return query<Tenant>(`SELECT ${FELT} FROM tenant ORDER BY navn`);
}

export interface NyTenant {
	id: string;
	navn: string;
	organisasjonsnummer: string;
	herId?: string;
	kommunenummer?: string;
	vertsnavn?: string;
	baseUrl: string;
	merknad?: string;
	/** Første administratorbruker i virksomheten. */
	adminBrukernavn?: string;
	adminNavn?: string;
	opprettetAv?: string;
}

export type OpprettResultat =
	| { ok: true; tenant: Tenant; adminBrukernavn?: string; midlertidigPassord?: string }
	| { ok: false; feil: string };

/**
 * Oppretter en virksomhet.
 *
 * Rekkefølgen er viktig: partisjonen i HAPI opprettes *før* raden lagres. Feiler
 * partisjonen, får vi ingen virksomhet som peker på en partisjon som ikke
 * finnes - og en virksomhet uten fungerende klinisk lager er verre enn ingen
 * virksomhet.
 */
export async function opprettTenant(inn: NyTenant, aktor: AuditAktor): Promise<OpprettResultat> {
	if (!/^[a-z][a-z0-9-]{1,30}$/.test(inn.id)) {
		return { ok: false, feil: 'Maskinnavnet må starte med en bokstav og bare inneholde små bokstaver, tall og bindestrek.' };
	}
	if (!gyldigOrganisasjonsnummer(inn.organisasjonsnummer)) {
		return { ok: false, feil: 'Ugyldig organisasjonsnummer (mod11-kontroll feilet).' };
	}
	if (await hentTenant(inn.id)) {
		return { ok: false, feil: `Virksomheten «${inn.id}» finnes allerede.` };
	}
	if (inn.vertsnavn && (await hentTenantPaVertsnavn(inn.vertsnavn))) {
		return { ok: false, feil: `Vertsnavnet ${inn.vertsnavn} er allerede i bruk.` };
	}
	try {
		new URL(inn.baseUrl);
	} catch {
		return { ok: false, feil: 'Ugyldig adresse (base_url).' };
	}

	const neste = await en<{ n: number }>('SELECT COALESCE(MAX(partisjon_id), 0) + 1 AS n FROM tenant');
	const partisjonId = neste?.n ?? 1;

	const partisjon = await opprettPartisjon(partisjonId, inn.id, inn.navn);
	if (!partisjon.ok) {
		return { ok: false, feil: `Klarte ikke å opprette FHIR-partisjon: ${partisjon.feil}` };
	}

	const tenant = await transaction(async () => {
		await exec(
			`INSERT INTO tenant (id, navn, organisasjonsnummer, her_id, kommunenummer, vertsnavn,
				base_url, partisjon_id, merknad, opprettet_av)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			[
				inn.id, inn.navn, inn.organisasjonsnummer, inn.herId ?? null, inn.kommunenummer ?? null,
				inn.vertsnavn ?? null, inn.baseUrl.replace(/\/$/, ''), partisjonId,
				inn.merknad ?? null, aktor.userId
			]
		);
		return (await hentTenant(inn.id)) as Tenant;
	});

	let adminBrukernavn: string | undefined;
	let midlertidigPassord: string | undefined;
	if (inn.adminBrukernavn) {
		midlertidigPassord = nyToken(9);
		// Brukeren opprettes i den nye virksomhetens kontekst.
		await medTenant(tenant, async () => {
			await opprettBruker({
				brukernavn: inn.adminBrukernavn as string,
				navn: inn.adminNavn ?? 'Systemansvarlig',
				passord: midlertidigPassord,
				roller: ['systemansvarlig'],
				opprettetAv: aktor.userId ?? undefined
			});
		});
		adminBrukernavn = inn.adminBrukernavn;
	}

	await logg(
		{
			type: 'admin', subtype: 'tenant:opprettet', handling: 'C', utfall: '0',
			entityRef: `Organization/${tenant.id}`,
			detaljer: { navn: tenant.navn, orgnr: tenant.organisasjonsnummer, partisjon: partisjonId }
		},
		aktor,
		tenant.id
	);

	return { ok: true, tenant, adminBrukernavn, midlertidigPassord };
}

export async function settTenantstatus(
	id: string,
	status: 'aktiv' | 'suspendert' | 'avviklet',
	aktor: AuditAktor
): Promise<void> {
	await transaction(async () => {
		await exec('UPDATE tenant SET status = $2, oppdatert = now() WHERE id = $1', [id, status]);
		if (status !== 'aktiv') {
			// Suspensjon skal virke umiddelbart, ikke ved neste utløp.
			await exec('UPDATE user_session SET avsluttet = true WHERE user_id IN (SELECT id FROM user_account WHERE tenant_id = $1)', [id]);
			await exec(
				"UPDATE oauth_token SET tilbakekalt = true, tilbakekalt_grunn = $2 WHERE tenant_id = $1 AND tilbakekalt = false",
				[id, `virksomhet ${status}`]
			);
		}
	});
	await logg(
		{ type: 'admin', subtype: 'tenant:status', handling: 'U', utfall: '0', entityRef: `Organization/${id}`, detaljer: { status } },
		aktor,
		id
	);
}

export async function oppdaterTenant(
	id: string,
	endring: { navn?: string; vertsnavn?: string | null; baseUrl?: string; herId?: string | null; kommunenummer?: string | null; merknad?: string | null },
	aktor: AuditAktor
): Promise<{ ok: boolean; feil?: string }> {
	if (endring.vertsnavn) {
		const annen = await hentTenantPaVertsnavn(endring.vertsnavn);
		if (annen && annen.id !== id) return { ok: false, feil: 'Vertsnavnet er allerede i bruk.' };
	}
	await exec(
		`UPDATE tenant SET
			navn = COALESCE($2, navn),
			vertsnavn = COALESCE($3, vertsnavn),
			base_url = COALESCE($4, base_url),
			her_id = COALESCE($5, her_id),
			kommunenummer = COALESCE($6, kommunenummer),
			merknad = COALESCE($7, merknad),
			oppdatert = now()
		 WHERE id = $1`,
		[id, endring.navn ?? null, endring.vertsnavn ?? null, endring.baseUrl ?? null,
		 endring.herId ?? null, endring.kommunenummer ?? null, endring.merknad ?? null]
	);
	await logg(
		{ type: 'admin', subtype: 'tenant:endret', handling: 'U', utfall: '0', entityRef: `Organization/${id}` },
		aktor,
		id
	);
	return { ok: true };
}

export interface TenantOversikt extends Tenant {
	antallBrukere: number;
	antallAuditInnslag: number;
	sisteAktivitet: string | null;
	partisjonFinnes: boolean | null;
}

/** Oversikt for plattformadministrasjonen, med kontroll mot HAPI. */
export async function tenantOversikt(): Promise<TenantOversikt[]> {
	const tenanter = await listTenanter();
	const partisjoner = await listPartisjoner();

	const tall = await query<{ tenant_id: string; brukere: number; innslag: number; siste: string | null }>(
		`SELECT t.id AS tenant_id,
			(SELECT count(*)::int FROM user_account u WHERE u.tenant_id = t.id) AS brukere,
			(SELECT count(*)::int FROM audit_event a WHERE a.tenant_id = t.id) AS innslag,
			(SELECT max(a.recorded)::text FROM audit_event a WHERE a.tenant_id = t.id) AS siste
		 FROM tenant t`
	);
	const kart = new Map(tall.map((r) => [r.tenant_id, r]));

	return tenanter.map((t) => ({
		...t,
		antallBrukere: kart.get(t.id)?.brukere ?? 0,
		antallAuditInnslag: kart.get(t.id)?.innslag ?? 0,
		sisteAktivitet: kart.get(t.id)?.siste ?? null,
		partisjonFinnes: partisjoner.ok ? partisjoner.partisjoner.some((p) => p.navn === t.id) : null
	}));
}
