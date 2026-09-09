/**
 * Sentral konfigurasjon. Alle sikkerhetsrelevante verdier hentes fra miljøvariabler
 * slik at ingen hemmeligheter ligger i kodebasen (Normen faktaark 14 - konfigurasjon).
 */
import { env } from '$env/dynamic/private';

function required(name: string, fallbackInDev: string): string {
	const v = env[name];
	if (v && v.length > 0) return v;
	if (process.env.NODE_ENV === 'production') {
		throw new Error(`Manglende obligatorisk miljøvariabel: ${name}`);
	}
	return fallbackInDev;
}

function int(name: string, fallback: number): number {
	const v = env[name];
	if (!v) return fallback;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
	const v = env[name];
	if (v === undefined) return fallback;
	return v === '1' || v.toLowerCase() === 'true';
}

export const config = {
	/** Kanonisk utadvendt base-URL. Brukes som `issuer` i OAuth/OIDC-metadata. */
	baseUrl: (env.EPJ_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
	get fhirBaseUrl() {
		return `${this.baseUrl}/fhir`;
	},
	get issuer() {
		return this.baseUrl;
	},

	databasePath: env.EPJ_DB_PATH ?? 'data/epj.db',

	/** Nøkkel for kryptering av data at rest (TOTP-hemmeligheter, private signeringsnøkler). */
	dataEncryptionKey: required('EPJ_DATA_KEY', 'utviklingsnokkel-kun-for-lokal-bruk-0000'),

	session: {
		cookieName: 'epj_session',
		/** Inaktivitetsgrense. Normen anbefaler automatisk utlogging ved inaktivitet. */
		idleSeconds: int('EPJ_SESSION_IDLE_SECONDS', 30 * 60),
		absoluteSeconds: int('EPJ_SESSION_ABSOLUTE_SECONDS', 12 * 60 * 60),
		/** Hvor lenge en re-autentisering (step-up) er gyldig, f.eks. for nødrettstilgang. */
		elevationSeconds: int('EPJ_SESSION_ELEVATION_SECONDS', 15 * 60)
	},

	oauth: {
		accessTokenTtl: int('EPJ_ACCESS_TOKEN_TTL', 10 * 60),
		refreshTokenTtl: int('EPJ_REFRESH_TOKEN_TTL', 30 * 24 * 60 * 60),
		authorizationCodeTtl: int('EPJ_AUTH_CODE_TTL', 60),
		/** SMART-launch-kontekst er kortlivet og engangsbruk. */
		launchTtl: int('EPJ_LAUNCH_TTL', 5 * 60),
		/** Roterer refresh tokens ved bruk og oppdager gjenbruk av gamle tokens. */
		rotateRefreshTokens: bool('EPJ_ROTATE_REFRESH_TOKENS', true),
		signingKeyRotationDays: int('EPJ_KEY_ROTATION_DAYS', 90)
	},

	security: {
		/** Antall mislykkede påloggingsforsøk før kontoen låses midlertidig. */
		maxFailedLogins: int('EPJ_MAX_FAILED_LOGINS', 5),
		lockoutSeconds: int('EPJ_LOCKOUT_SECONDS', 15 * 60),
		requireMfa: bool('EPJ_REQUIRE_MFA', true),
		/** Betrodde proxy-hopp for utledning av klient-IP i audit-loggen. */
		trustedProxyHops: int('EPJ_TRUSTED_PROXY_HOPS', 1),
		/** Slår på HSTS og Secure-flagg. Skal alltid være på utenfor lokal utvikling. */
		httpsOnly: bool('EPJ_HTTPS_ONLY', process.env.NODE_ENV === 'production')
	},

	audit: {
		/** Helsepersonelloven/pasientjournalforskriften: logg skal bevares i minst 10 år. */
		retentionYears: int('EPJ_AUDIT_RETENTION_YEARS', 10)
	},

	organisasjon: {
		navn: env.EPJ_ORG_NAVN ?? 'Fastlegekontoret (utviklingsmiljø)',
		organisasjonsnummer: env.EPJ_ORG_ORGNR ?? '999999999',
		herId: env.EPJ_ORG_HER_ID ?? '0000000',
		kommunenummer: env.EPJ_ORG_KOMMUNENR ?? '0301'
	},

	integrasjoner: {
		/** `mock` kjører alt lokalt uten nettverk. `live` krever endepunkt + klientsertifikat. */
		modus: (env.EPJ_INTEGRASJON_MODUS ?? 'mock') as 'mock' | 'live',
		sfm: {
			baseUrl: env.EPJ_SFM_BASE_URL ?? '',
			clientId: env.EPJ_SFM_CLIENT_ID ?? '',
			/** SFM autentiseres med HelseID (client_credentials + private_key_jwt). */
			helseIdTokenEndpoint: env.EPJ_HELSEID_TOKEN_ENDPOINT ?? '',
			scope: env.EPJ_SFM_SCOPE ?? 'nhn:sfm/api'
		},
		nhn: {
			meldingstjenerUrl: env.EPJ_NHN_MELDINGSTJENER_URL ?? '',
			herId: env.EPJ_ORG_HER_ID ?? '0000000',
			adresseregisterUrl: env.EPJ_NHN_ADRESSEREGISTER_URL ?? ''
		},
		helfo: {
			/** Innsending av regningskort til KUHR (oppgjør). */
			oppgjorUrl: env.EPJ_HELFO_OPPGJOR_URL ?? '',
			/** Oppslag mot frikort-/egenandelstjenesten. */
			egenandelUrl: env.EPJ_HELFO_EGENANDEL_URL ?? '',
			avtaleId: env.EPJ_HELFO_AVTALE_ID ?? ''
		},
		helseId: {
			issuer: env.EPJ_HELSEID_ISSUER ?? '',
			clientId: env.EPJ_HELSEID_CLIENT_ID ?? '',
			enabled: bool('EPJ_HELSEID_ENABLED', false)
		}
	}
};

export type Config = typeof config;
