/**
 * Central configuration. Every security-relevant value comes from an
 * environment variable, so no secret sits in the codebase (Normen fact sheet 14).
 */
/**
 * Read from `process.env`. SvelteKit exposes the same variables through
 * `$env/dynamic/private`, but going straight to `process.env` means the
 * configuration also works in the migration and seed scripts and in unit tests.
 */
const env: Record<string, string | undefined> = process.env;

// Loads .env in development. In production the runtime sets the variables.
//
// Variables already set in the environment win over .env. Without that, a .env
// file in the project folder would override values that test runs and container
// setups set explicitly - a fault that is hard to see.
if (process.env.NODE_ENV !== 'production' && typeof process.loadEnvFile === 'function') {
	const eksplisitt = { ...process.env };
	try {
		process.loadEnvFile();
	} catch {
		/* .env is optional */
	}
	Object.assign(process.env, eksplisitt);
}

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
	/** Canonical outward-facing base URL. Used as `issuer` in OAuth/OIDC metadata. */
	baseUrl: (env.EPJ_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
	get fhirBaseUrl() {
		return `${this.baseUrl}/fhir`;
	},
	get issuer() {
		return this.baseUrl;
	},
	/**
	 * PostgreSQL. Application data lives in the `epj` schema.
	 *
	 * Required values are read as getters, not at module load: the build step
	 * imports the server code without a runtime environment, and should not fail
	 * for that. If the variable is missing in production, first use fails.
	 */
	get databaseUrl() {
		return required('EPJ_DATABASE_URL', 'postgres://epj:epj@localhost:5432/epj');
	},
	dbPoolMax: int('EPJ_DB_POOL_MAX', 10),
	dbSsl: bool('EPJ_DB_SSL', process.env.NODE_ENV === 'production'),

	/**
	 * HAPI FHIR JPA server. This is the record's clinical store: it owns the FHIR
	 * resources, the version history, the search indexes and profile validation.
	 * The server must never be exposed directly to the internet - all traffic
	 * goes through `/fhir` in this application, which enforces access control and
	 * writes the audit log.
	 */
	fhirServer: {
		// Read on every lookup, so the tests can point at a server that is only
		// assigned a port once the process is running.
		get baseUrl() {
			return (env.EPJ_HAPI_BASE_URL ?? 'http://localhost:8080/fhir').replace(/\/$/, '');
		},
		/** Shared secret towards HAPI (Basic auth in the reference setup). */
		username: env.EPJ_HAPI_USER ?? '',
		password: env.EPJ_HAPI_PASSWORD ?? '',
		timeoutMs: int('EPJ_HAPI_TIMEOUT_MS', 20_000),
		/**
		 * Partitioning on. The organisation's partition name is then part of the
		 * FHIR URL, and HAPI keeps the organisations' clinical data apart.
		 * Can be turned off for single-organisation installations.
		 */
		multitenant: bool('EPJ_HAPI_MULTITENANT', true),
		/** Turns on $validate against HAPI before writing. */
		validateAtSkriving: bool('EPJ_HAPI_VALIDATE', false)
	},

	/** Key for encrypting data at rest (TOTP secrets, private signing keys). */
	get dataEncryptionKey() {
		return required('EPJ_DATA_KEY', 'utviklingsnokkel-kun-for-lokal-bruk-0000');
	},

	session: {
		cookieName: 'epj_session',
		/** Idle limit. Normen recommends automatic sign-out on inactivity. */
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
		httpsOnly: bool('EPJ_HTTPS_ONLY', process.env.NODE_ENV === 'production'),
		/**
		 * Ratebegrensning. Påloggingsendepunktene har egne, strengere grenser enn
		 * resten, både per IP-adresse og per brukernavn, slik at én konto ikke kan
		 * angripes fra mange adresser.
		 */
		rateLimit: {
			generellPerMinutt: int('EPJ_RATE_GENERELL', 600),
			autentiseringPerMinutt: int('EPJ_RATE_AUTH', 20),
			loginPerUser: int('EPJ_RATE_LOGIN_BRUKER', 10),
			loginWindowSekunder: int('EPJ_RATE_LOGIN_VINDU', 300)
		}
	},

	/**
	 * Lokal innlogging med brukernavn/passord/engangskode. Beregnet på
	 * utvikling, testmiljø og som reserveløsning hvis HelseID er utilgjengelig.
	 * Skal være avslått i produksjon når HelseID er i bruk.
	 */
	testLogin: {
		aktivert: bool('EPJ_TESTINNLOGGING', process.env.NODE_ENV !== 'production'),
		/** Viser demobrukere med ferdig utfylt passord på påloggingssiden. */
		showDemoUsers: bool('EPJ_VIS_DEMOBRUKERE', process.env.NODE_ENV !== 'production')
	},

	audit: {
		/** Helsepersonelloven/pasientjournalforskriften: logg skal bevares i minst 10 år. */
		retentionYears: int('EPJ_AUDIT_RETENTION_YEARS', 10)
	},

	/**
	 * Standardvirksomhet og plattformadministrasjon.
	 *
	 * Virksomhetsopplysninger ligger i `tenant`-tabellen. Verdiene her brukes
	 * bare til å opprette standardvirksomheten ved første oppstart, og som
	 * reserve når en forespørsel ikke kan knyttes til en virksomhet.
	 */
	tenant: {
		/** Virksomheten forespørsler faller tilbake på når vertsnavnet er ukjent. */
		defaultValue: env.EPJ_DEFAULT_TENANT ?? 'standard',
		/** Vertsnavnet plattformadministrasjonen nås på. */
		platformHostname: env.EPJ_PLATFORM_HOSTNAME ?? '',
		/** Godta ukjent vertsnavn og bruk standardvirksomheten. Av i produksjon. */
		allowUnknownHostname: bool('EPJ_TILLAT_UKJENT_VERTSNAVN', process.env.NODE_ENV !== 'production')
	},

	organisation: {
		name: env.EPJ_ORG_NAME ?? 'Fastlegekontoret (utviklingsmiljø)',
		organisation_number: env.EPJ_ORG_ORGNR ?? '999999999',
		herId: env.EPJ_ORG_HER_ID ?? '0000000',
		municipality_code: env.EPJ_ORG_KOMMUNENR ?? '0301'
	},

	integrations: {
		/** `mock` kjører alt lokalt uten nettverk. `live` krever endepunkt + klientsertifikat. */
		modus: (env.EPJ_INTEGRATION_MODUS ?? 'mock') as 'mock' | 'live',
		sfm: {
			baseUrl: env.EPJ_SFM_BASE_URL ?? '',
			clientId: env.EPJ_SFM_CLIENT_ID ?? '',
			/** SFM autentiseres med HelseID (client_credentials + private_key_jwt). */
			healthIdTokenEndpoint: env.EPJ_HELSEID_TOKEN_ENDPOINT ?? '',
			scope: env.EPJ_SFM_SCOPE ?? 'nhn:sfm/api'
		},
		nhn: {
			meldingstjenerUrl: env.EPJ_NHN_MELDINGSTJENER_URL ?? '',
			herId: env.EPJ_ORG_HER_ID ?? '0000000',
			addressRegistryUrl: env.EPJ_NHN_ADDRESSREGISTRY_URL ?? ''
		},
		helfo: {
			/** Innsending av regningskort til KUHR (oppgjør). */
			settlementUrl: env.EPJ_HELFO_SETTLEMENT_URL ?? '',
			/** Oppslag mot frikort-/egenandelstjenesten. */
			copaymentUrl: env.EPJ_HELFO_COPAYMENT_URL ?? '',
			avtaleId: env.EPJ_HELFO_AVTALE_ID ?? ''
		},
		/**
		 * HelseID er den primære påloggingsmekanismen for helsepersonell.
		 * Klienten autentiserer seg med private_key_jwt; ingen delt hemmelighet.
		 */
		healthId: {
			enabled: bool('EPJ_HELSEID_ENABLED', false),
			issuer: (env.EPJ_HELSEID_ISSUER ?? 'https://helseid-sts.test.nhn.no').replace(/\/$/, ''),
			clientId: env.EPJ_HELSEID_CLIENT_ID ?? '',
			/** Privat nøkkel (PEM, PKCS#8) for klientassertions. */
			privateKeyPem: env.EPJ_HELSEID_PRIVATE_KEY ?? '',
			keyId: env.EPJ_HELSEID_KEY_ID ?? '',
			signeringsalgoritme: (env.EPJ_HELSEID_ALG ?? 'RS256') as 'RS256' | 'PS256' | 'ES256',
			scopes: (env.EPJ_HELSEID_SCOPES ??
				'openid profile helseid://scopes/identity/pid helseid://scopes/identity/security_level helseid://scopes/hpr/hpr_number')
				.split(/\s+/).filter(Boolean),
			get redirectUri() {
				return env.EPJ_HELSEID_REDIRECT_URI ?? '';
			}
		}
	}
};

export type Config = typeof config;
