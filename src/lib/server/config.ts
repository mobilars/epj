/**
 * Sentral konfigurasjon. Alle sikkerhetsrelevante verdier hentes fra miljøvariabler
 * slik at ingen hemmeligheter ligger i kodebasen (Normen faktaark 14 - konfigurasjon).
 */
/**
 * Leses fra `process.env`. SvelteKit eksponerer de samme variablene gjennom
 * `$env/dynamic/private`, men ved å gå direkte til `process.env` fungerer
 * konfigurasjonen også i migrasjons- og seed-skript og i enhetstestene.
 */
const env: Record<string, string | undefined> = process.env;

// Laster .env i utvikling. I produksjon settes variablene av kjøremiljøet.
//
// Variabler som allerede er satt i miljøet vinner over .env. Uten dette ville
// en .env-fil i prosjektmappen overstyre verdiene testkjøringer og
// containeroppsett setter eksplisitt - en feilkilde som er vanskelig å se.
if (process.env.NODE_ENV !== 'production' && typeof process.loadEnvFile === 'function') {
	const eksplisitt = { ...process.env };
	try {
		process.loadEnvFile();
	} catch {
		/* .env er valgfri */
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
	/** Kanonisk utadvendt base-URL. Brukes som `issuer` i OAuth/OIDC-metadata. */
	baseUrl: (env.EPJ_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
	get fhirBaseUrl() {
		return `${this.baseUrl}/fhir`;
	},
	get issuer() {
		return this.baseUrl;
	},

	/**
	 * PostgreSQL. Applikasjonsdata ligger i skjemaet `epj`.
	 *
	 * Obligatoriske verdier leses som getters, ikke ved modullasting: byggetrinnet
	 * importerer serverkoden uten at driftsmiljøet finnes, og skal ikke feile av
	 * den grunn. Mangler variabelen i produksjon, feiler første faktiske bruk.
	 */
	get databaseUrl() {
		return required('EPJ_DATABASE_URL', 'postgres://epj:epj@localhost:5432/epj');
	},
	dbPoolMax: int('EPJ_DB_POOL_MAX', 10),
	dbSsl: bool('EPJ_DB_SSL', process.env.NODE_ENV === 'production'),

	/**
	 * HAPI FHIR JPA-server. Denne er journalens kliniske lager: den eier
	 * FHIR-ressursene, versjonshistorikken, søkeindeksene og profilvalideringen.
	 * Serveren skal aldri eksponeres direkte mot internett - all trafikk går
	 * gjennom `/fhir` i denne applikasjonen, som håndhever tilgangskontroll og
	 * skriver sikkerhetslogg.
	 */
	fhirServer: {
		// Leses ved hvert oppslag, slik at testene kan peke på en server som
		// først har fått tildelt port når prosessen kjører.
		get baseUrl() {
			return (env.EPJ_HAPI_BASE_URL ?? 'http://localhost:8080/fhir').replace(/\/$/, '');
		},
		/** Delt hemmelighet mot HAPI (Basic auth i referanseoppsettet). */
		brukernavn: env.EPJ_HAPI_USER ?? '',
		passord: env.EPJ_HAPI_PASSWORD ?? '',
		timeoutMs: int('EPJ_HAPI_TIMEOUT_MS', 20_000),
		/** Slår på $validate mot HAPI før skriving. */
		validerVedSkriving: bool('EPJ_HAPI_VALIDATE', false)
	},

	/** Nøkkel for kryptering av data at rest (TOTP-hemmeligheter, private signeringsnøkler). */
	get dataEncryptionKey() {
		return required('EPJ_DATA_KEY', 'utviklingsnokkel-kun-for-lokal-bruk-0000');
	},

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
		httpsOnly: bool('EPJ_HTTPS_ONLY', process.env.NODE_ENV === 'production'),
		/**
		 * Ratebegrensning. Påloggingsendepunktene har egne, strengere grenser enn
		 * resten, både per IP-adresse og per brukernavn, slik at én konto ikke kan
		 * angripes fra mange adresser.
		 */
		rateLimit: {
			generellPerMinutt: int('EPJ_RATE_GENERELL', 600),
			autentiseringPerMinutt: int('EPJ_RATE_AUTH', 20),
			paloggingPerBruker: int('EPJ_RATE_LOGIN_BRUKER', 10),
			paloggingVinduSekunder: int('EPJ_RATE_LOGIN_VINDU', 300)
		}
	},

	/**
	 * Lokal innlogging med brukernavn/passord/engangskode. Beregnet på
	 * utvikling, testmiljø og som reserveløsning hvis HelseID er utilgjengelig.
	 * Skal være avslått i produksjon når HelseID er i bruk.
	 */
	testinnlogging: {
		aktivert: bool('EPJ_TESTINNLOGGING', process.env.NODE_ENV !== 'production'),
		/** Viser demobrukere med ferdig utfylt passord på påloggingssiden. */
		visDemobrukere: bool('EPJ_VIS_DEMOBRUKERE', process.env.NODE_ENV !== 'production')
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
		/**
		 * HelseID er den primære påloggingsmekanismen for helsepersonell.
		 * Klienten autentiserer seg med private_key_jwt; ingen delt hemmelighet.
		 */
		helseId: {
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
