/**
 * How strongly a user must prove who they are, per organisation.
 *
 * The three ways into the record are not equally strong, and which of them is
 * good enough is a decision that belongs to the practice. A practice holding
 * real patient records should require HelseID; a trial full of synthetic
 * patients would be unusable if it did, because nobody is issued a HelseID to
 * look at people who do not exist.
 *
 * So the setting is a floor, not a list: what it names is the weakest method
 * that will be accepted, and anything stronger is accepted too. Ordering them
 * is the whole trick - it means a practice that tightens the setting never has
 * to think about which methods to switch off.
 */

export const LOGIN_LEVELS = ['epost', 'passord', 'helseid'] as const;
export type LoginLevel = (typeof LOGIN_LEVELS)[number];

/** Higher is stronger. Only the order matters, never the numbers. */
const RANK: Record<LoginLevel, number> = { epost: 1, passord: 2, helseid: 3 };

export const LEVEL_TEXT: Record<LoginLevel, { name: string; description: string }> = {
	epost: {
		name: 'E-postkode',
		description:
			'Godtar kode på e-post, passord og HelseID. Svakest: en kode på e-post viser at noen leser posten på adressen, ikke hvem de er. Til prøvekontoer med syntetiske data.'
	},
	passord: {
		name: 'Passord med totrinn',
		description:
			'Godtar passord med engangskode, og HelseID. Ikke kode på e-post. Rimelig for et testmiljø, ikke for ekte pasientopplysninger.'
	},
	helseid: {
		name: 'HelseID',
		description:
			'Bare HelseID på sikkerhetsnivå 4. Det som gjelder for en virksomhet med ekte pasientopplysninger.'
	}
};

export function isLoginLevel(value: string): value is LoginLevel {
	return (LOGIN_LEVELS as readonly string[]).includes(value);
}

/** The method a session was established by, as recorded in `amr`. */
export function levelOfMethod(amr: string): LoginLevel {
	if (amr === 'helseid') return 'helseid';
	if (amr === 'epost') return 'epost';
	// Everything else is username and password, with or without a one-time code.
	return 'passord';
}

/** Whether a method is good enough for an organisation that requires `needed`. */
export function methodIsEnough(amr: string, needed: string): boolean {
	const required = isLoginLevel(needed) ? needed : 'passord';
	return RANK[levelOfMethod(amr)] >= RANK[required];
}

export function allows(needed: string, method: LoginLevel): boolean {
	return methodIsEnough(method, needed);
}
