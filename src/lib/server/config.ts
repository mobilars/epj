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
		/** How long a re-authentication (step-up) is valid, e.g. for emergency access. */
		elevationSeconds: int('EPJ_SESSION_ELEVATION_SECONDS', 15 * 60)
	},

	oauth: {
		accessTokenTtl: int('EPJ_ACCESS_TOKEN_TTL', 10 * 60),
		refreshTokenTtl: int('EPJ_REFRESH_TOKEN_TTL', 30 * 24 * 60 * 60),
		authorizationCodeTtl: int('EPJ_AUTH_CODE_TTL', 60),
		/** SMART launch context is short-lived and single-use. */
		launchTtl: int('EPJ_LAUNCH_TTL', 5 * 60),
		/** Rotates refresh tokens on use and detects reuse of old tokens. */
		rotateRefreshTokens: bool('EPJ_ROTATE_REFRESH_TOKENS', true),
		signingKeyRotationDays: int('EPJ_KEY_ROTATION_DAYS', 90)
	},

	security: {
		/** Number of failed sign-in attempts before the account is temporarily locked. */
		maxFailedLogins: int('EPJ_MAX_FAILED_LOGINS', 5),
		lockoutSeconds: int('EPJ_LOCKOUT_SECONDS', 15 * 60),
		requireMfa: bool('EPJ_REQUIRE_MFA', true),
		/** Trusted proxy hops for deriving the client IP in the audit log. */
		trustedProxyHops: int('EPJ_TRUSTED_PROXY_HOPS', 1),
		/** Turns on HSTS and the Secure flag. Must always be on outside local development. */
		httpsOnly: bool('EPJ_HTTPS_ONLY', process.env.NODE_ENV === 'production'),
		/**
		 * Rate limiting. The sign-in endpoints have their own, stricter limits than
		 * the rest, both per IP address and per username, so a single account cannot
		 * be attacked from many addresses.
		 */
		rateLimit: {
			generellPerMinutt: int('EPJ_RATE_GENERAL', 600),
			autentiseringPerMinutt: int('EPJ_RATE_AUTH', 20),
			loginPerUser: int('EPJ_RATE_LOGIN_USER', 10),
			loginWindowSekunder: int('EPJ_RATE_LOGIN_WINDOW', 300)
		}
	},

	/**
	 * Local sign-in with username/password/one-time code. Intended for
	 * development, test environments and as a fallback if HelseID is unavailable.
	 * Must be turned off in production when HelseID is in use.
	 */
	testLogin: {
		aktivert: bool('EPJ_TEST_LOGIN', process.env.NODE_ENV !== 'production'),
		/** Shows demo users with the password filled in on the sign-in page. */
		showDemoUsers: bool('EPJ_SHOW_DEMO_USERS', process.env.NODE_ENV !== 'production')
	},

	audit: {
		/** Health Personnel Act / patient records regulation: logs must be kept for at least 10 years. */
		retentionYears: int('EPJ_AUDIT_RETENTION_YEARS', 10)
	},

	/**
	 * Default organisation and platform administration.
	 *
	 * Organisation details live in the `tenant` table. The values here are used
	 * only to create the default organisation on first start-up, and as a
	 * fallback when a request cannot be tied to an organisation.
	 */
	tenant: {
		/** The organisation requests fall back on when the hostname is unknown. */
		defaultValue: env.EPJ_DEFAULT_TENANT ?? 'standard',
		/** The hostname platform administration is reached on. */
		platformHostname: env.EPJ_PLATFORM_HOSTNAME ?? '',
		/** Accept an unknown hostname and use the default organisation. Off in production. */
		allowUnknownHostname: bool('EPJ_ALLOW_UNKNOWN_HOSTNAME', process.env.NODE_ENV !== 'production')
	},

	organisation: {
		name: env.EPJ_ORG_NAME ?? 'Fastlegekontoret (utviklingsmiljø)',
		organisation_number: env.EPJ_ORG_NUMBER ?? '999999999',
		herId: env.EPJ_ORG_HER_ID ?? '0000000',
		municipality_code: env.EPJ_ORG_MUNICIPALITY_CODE ?? '0301'
	},

	integrations: {
		/** `mock` runs everything locally without network. `live` requires an endpoint + client certificate. */
		mode: (env.EPJ_INTEGRATION_MODE ?? 'mock') as 'mock' | 'live',
		sfm: {
			baseUrl: env.EPJ_SFM_BASE_URL ?? '',
			clientId: env.EPJ_SFM_CLIENT_ID ?? '',
			/** SFM authenticates with HelseID (client_credentials + private_key_jwt). */
			healthIdTokenEndpoint: env.EPJ_HELSEID_TOKEN_ENDPOINT ?? '',
			scope: env.EPJ_SFM_SCOPE ?? 'nhn:sfm/api'
		},
		nhn: {
			messageServerUrl: env.EPJ_NHN_MESSAGE_SERVER_URL ?? '',
			herId: env.EPJ_ORG_HER_ID ?? '0000000',
			addressRegistryUrl: env.EPJ_NHN_ADDRESSREGISTRY_URL ?? ''
		},
		helfo: {
			/** Submission of billing cards to KUHR (settlement). */
			settlementUrl: env.EPJ_HELFO_SETTLEMENT_URL ?? '',
			/** Lookups against the exemption-card/copayment service. */
			copaymentUrl: env.EPJ_HELFO_COPAYMENT_URL ?? '',
			agreementId: env.EPJ_HELFO_AGREEMENT_ID ?? ''
		},
		/**
		 * HelseID is the primary sign-in mechanism for health personnel. The
		 * client authenticates with private_key_jwt; no shared secret.
		 */
		healthId: {
			enabled: bool('EPJ_HELSEID_ENABLED', false),
			issuer: (env.EPJ_HELSEID_ISSUER ?? 'https://helseid-sts.test.nhn.no').replace(/\/$/, ''),
			clientId: env.EPJ_HELSEID_CLIENT_ID ?? '',
			/**
			 * Client key for the assertions, as a base64-encoded JWK (or a JSON
			 * array of them, in which case the first is used). This is the form
			 * HelseID hands the key out in, and it carries `kid` and `alg` with
			 * it - which matters, because HelseID matches the assertion against
			 * the registered key by `kid`.
			 */
			privateJwkBase64: env.EPJ_HELSEID_PRIVATE_JWK ?? '',
			/** The same key as PKCS#8 PEM. Used when no JWK is configured. */
			privateKeyPem: env.EPJ_HELSEID_PRIVATE_KEY ?? '',
			/** Only consulted alongside the PEM; a JWK brings its own `kid`. */
			keyId: env.EPJ_HELSEID_KEY_ID ?? '',
			signingAlgorithm: (env.EPJ_HELSEID_ALG ?? 'RS256') as 'RS256' | 'PS256' | 'ES256',
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
