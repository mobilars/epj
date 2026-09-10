import { exec, one } from '../db';
import { newId } from '../util/ids';

/**
 * The terms a developer accepts before getting an account.
 *
 * Kept in code rather than in the database so a change is a change to the
 * repository - reviewable, dated, and impossible to make quietly. `VERSION` is
 * bumped whenever the text changes in a way that alters what someone agreed
 * to; every developer is then asked again before they can carry on.
 *
 * Acceptances are recorded one row per acceptance and never updated in place.
 * The question a year from now is not "which terms apply" but "what did this
 * person agree to, and when" - and that is only answerable if the old rows are
 * still there.
 *
 * The text is Norwegian because the people bound by it are, and because the
 * duties it points at - Normen, pasientjournalloven, databehandleravtale - are
 * Norwegian terms of art. It is written to be read, not to be impressive, and
 * it is a starting point that ought to be looked over by someone with a legal
 * qualification before real practices rely on it.
 */

export const VERSION = '2026-09-1';

export interface Section {
	title: string;
	paragraphs: string[];
}

export const TERMS: { version: string; updated: string; intro: string; sections: Section[] } = {
	version: VERSION,
	updated: '10. september 2026',
	intro:
		'Disse vilkårene gjelder mellom deg som utvikler og plattformen. De handler om én ting: ' +
		'at opplysningene i en journal tilhører virksomheten og pasienten, ikke appen din. Alt annet ' +
		'følger av det.',
	sections: [
		{
			title: '1. Hvem avtalen er mellom',
			paragraphs: [
				'Avtalen er mellom deg, eller virksomheten du registrerer deg på vegne av, og den som drifter denne plattformen. Den gjelder fra du oppretter konto og så lenge du har apper registrert.',
				'Avtalen gir deg ikke tilgang til noen journal. Den gir deg adgang til å registrere apper som en virksomhet selv kan velge å installere. Det er virksomheten som bestemmer om appen din slipper inn, og som kan fjerne den igjen når som helst uten å begrunne det.'
			]
		},
		{
			title: '2. Roller etter personvernforordningen',
			paragraphs: [
				'Virksomheten som bruker appen din, er behandlingsansvarlig for opplysningene i sin journal. Du er databehandler når appen din behandler dem på virksomhetens vegne.',
				'Det betyr at du må ha en databehandleravtale med hver enkelt virksomhet før appen behandler helseopplysninger for dem. Plattformen er ikke part i den avtalen og kan ikke inngå den for deg. Registrerer du appen med en referanse til en slik avtale, må den faktisk finnes.',
				'Du behandler opplysninger bare etter dokumenterte instrukser fra virksomheten, og til det formålet appen er beskrevet for. Trenger du et annet formål, er det en ny vurdering og som regel et nytt rettslig grunnlag - ikke noe du kan legge til stille.'
			]
		},
		{
			title: '3. Opplysningene tilhører ikke deg',
			paragraphs: [
				'Du får ingen eierrett, lisens eller bruksrett til opplysninger appen leser, ut over det som er nødvendig for å utføre oppgaven appen er der for.',
				'Du skal ikke bruke opplysninger fra en journal til å trene modeller, bygge statistikk, utvikle produkter, selge tilgang, eller til markedsføring - heller ikke i anonymisert eller aggregert form, med mindre virksomheten har gitt et selvstendig og dokumentert grunnlag for nettopp det.',
				'Anonymisering er ikke en vei rundt dette. Helseopplysninger om en pasientpopulasjon lar seg ofte føre tilbake til enkeltpersoner, og vurderingen av om noe faktisk er anonymt er virksomhetens, ikke din.'
			]
		},
		{
			title: '4. Virksomhetene skal holdes atskilt',
			paragraphs: [
				'Hver virksomhet som installerer appen din, får sin egen klient med sin egen klient-id. Du skal ikke bruke legitimasjon fra én virksomhet mot en annen, og ikke gjenbruke tokens på tvers.',
				'Du skal ikke sammenstille opplysninger fra flere virksomheter. En pasient som er registrert to steder, skal ikke bli til én oppføring hos deg fordi appen din så begge.',
				'Har appen din en server, skal data fra ulike virksomheter være atskilt der også. At de ligger i samme database er ikke i seg selv et brudd, men det må være umulig for en spørring på vegne av én virksomhet å treffe en annens rader.'
			]
		},
		{
			title: '5. Be om minst mulig',
			paragraphs: [
				'Du skal be om de scopene appen faktisk trenger, og ikke flere. Vi vurderer scopene mot beskrivelsen din når appen sendes inn, og avslår det som ikke henger sammen.',
				'Journalen snevrer uansett inn: en app får aldri mer enn rollen til den som er innlogget. At du har bedt om noe, betyr ikke at du får det.',
				'Lagre ikke opplysninger du ikke trenger, og ikke lenger enn du trenger dem. Sletter virksomheten appen, skal du slette det du har lagret om deres pasienter, og bekrefte det skriftlig hvis de ber om det.'
			]
		},
		{
			title: '6. Sikkerhet',
			paragraphs: [
				'Du skal følge Normen (Norm for informasjonssikkerhet og personvern i helse- og omsorgstjenesten) i den grad den gjelder for det appen gjør.',
				'Klientnøkler og hemmeligheter skal oppbevares slik at de ikke kommer på avveie, og aldri legges i kildekode, i en nettleser eller i et offentlig arkiv. Offentlige klienter skal bruke PKCE. Tokens skal ikke deles, videresendes eller lagres lenger enn de er gyldige.',
				'Overføring ut av EØS krever et gyldig overføringsgrunnlag, og virksomheten skal vite om det på forhånd. Bruker du underleverandører - skytjenester, analyseverktøy, modelltjenester - er de dine underdatabehandlere, og virksomheten skal ha godkjent dem.'
			]
		},
		{
			title: '7. Alt appen gjør, blir logget',
			paragraphs: [
				'Hvert oppslag appen gjør, skrives i journalens sikkerhetslogg med appens navn og brukeren som startet den. Pasienten har rett til å se den loggen.',
				'Du skal ikke forsøke å omgå loggingen, tilgangskontrollen eller sperringer, og ikke lete etter opplysninger appen ikke er der for å hente. Automatisert uttrekk av flere pasienter enn oppgaven krever, regnes som misbruk.',
				'Blir det spørsmål om et oppslag - fra en pasient, fra virksomheten eller fra tilsynsmyndighet - plikter du å bistå med det du vet.'
			]
		},
		{
			title: '8. Avvik',
			paragraphs: [
				'Oppdager du et sikkerhetsbrudd, en sårbarhet eller at opplysninger har kommet på avveie, skal du varsle plattformen og de berørte virksomhetene uten ugrunnet opphold, og senest innen 24 timer.',
				'Varsle selv om du er usikker på om det er alvorlig. Virksomheten har 72 timer på seg til å melde til Datatilsynet, og den fristen løper uansett hva du kommer fram til.',
				'Finner du en svakhet i plattformen selv, meld den til oss i stedet for å utnytte den. Vi kommer ikke etter noen som melder fra i god tro.'
			]
		},
		{
			title: '9. Vurdering, endringer og stenging',
			paragraphs: [
				'Apper vurderes før de kan installeres. Vi ser på om beskrivelsen stemmer med scopene, om adressene er de appen faktisk bruker, og om det du ber om står i forhold til det appen gjør. Avslag begrunnes.',
				'Endrer du scopes eller adresser på en godkjent app, går den til vurdering på nytt. Det som ble godkjent, var akkurat de scopene og de adressene.',
				'Vi kan stenge en app eller en konto uten forvarsel hvis vi har rimelig grunn til å tro at pasientopplysninger er i fare. Vi sier fra så snart vi kan, og begrunner det.'
			]
		},
		{
			title: '10. Om plattformen',
			paragraphs: [
				'Plattformen leveres som den er. Dette miljøet er et testmiljø: det kan startes på nytt, tømmes eller endres uten varsel, og du skal ikke legge inn opplysninger om virkelige personer i det.',
				'Vi lagrer om deg: e-postadressen din, navnet og virksomheten du oppgir, appene du registrerer, og når du har logget inn. Det brukes til å drifte portalen og til å kunne kontakte deg om appene dine. Du kan be om innsyn, retting eller sletting ved å ta kontakt.',
				'Norsk rett gjelder.'
			]
		}
	]
};

export interface Acceptance {
	version: string;
	accepted_at: string;
}

export async function acceptedVersion(developerId: string): Promise<string | null> {
	const row = await one<{ version: string }>(
		'SELECT version FROM developer_terms WHERE developer_id = $1 ORDER BY accepted_at DESC LIMIT 1',
		[developerId]
	);
	return row?.version ?? null;
}

export async function hasAcceptedCurrent(developerId: string): Promise<boolean> {
	return (await acceptedVersion(developerId)) === VERSION;
}

/** One row per acceptance. Old rows are never touched. */
export async function recordAcceptance(developerId: string, ip: string | null): Promise<void> {
	await exec('INSERT INTO developer_terms (id, developer_id, version, ip) VALUES ($1,$2,$3,$4)', [
		newId(),
		developerId,
		VERSION,
		ip
	]);
}
