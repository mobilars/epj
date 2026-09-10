import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exec } from '../src/lib/server/db/index';
import { harTestdatabase, opprettTestdatabase, tomTabeller, type Testdatabase, settInn } from './fixtures/db';
import { appKontekst, kontekst } from './fixtures/kontekst';
import {
	aktivNodrett,
	erPasientnaer,
	harBehandlingsrelasjon,
	kanAvgjorePasient,
	pasientIdFraRessurs,
	sperredePasienter,
	tillattePasienter,
	vurder
} from '../src/lib/server/authz/tilgang';
import { STOTTEDE_RESSURSTYPER } from '../src/lib/server/fhir/searchparams';
import { nyId } from '../src/lib/server/util/ids';
import { parseScopes } from '../src/lib/server/authz/scopes';

const beskriv = harTestdatabase() ? describe : describe.skip;

const PASIENT = 'pas-1';
const ANNEN_PASIENT = 'pas-2';

async function lagBruker(id: string, brukernavn: string): Promise<void> {
	await settInn('INSERT INTO user_account (id, brukernavn, navn) VALUES ($1,$2,$3)', [id, brukernavn, brukernavn]);
}

async function girRelasjon(userId: string, patientId: string, grunnlag = 'fastlege'): Promise<void> {
	await settInn('INSERT INTO care_relationship (id, user_id, patient_id, grunnlag) VALUES ($1,$2,$3,$4)', [nyId(), userId, patientId, grunnlag]);
}

const observasjon = (patientId: string) => ({
	resourceType: 'Observation',
	id: 'obs-1',
	status: 'final',
	code: { text: 'Blodtrykk' },
	subject: { reference: `Patient/${patientId}` }
});

beskriv('tilgangsbeslutning', () => {
	let db: Testdatabase;
	beforeAll(async () => { db = await opprettTestdatabase('tilgang'); });
	afterAll(async () => { await db.riv(); });
	beforeEach(async () => {
		await tomTabeller();
		await lagBruker('bruker-1', 'lege');
		await lagBruker('bruker-2', 'sykepleier');
	});

	describe('lag 3 - tjenstlig behov', () => {
		it('nekter uten behandlingsrelasjon', async () => {
			const b = await vurder({ ctx: kontekst(), resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(PASIENT) });
			expect(b.tillatt).toBe(false);
			expect(b.grunn).toMatch(/behandlingsrelasjon/);
			expect(b.status).toBe(403);
		});

		it('tillater med behandlingsrelasjon', async () => {
			await girRelasjon('bruker-1', PASIENT);
			const b = await vurder({ ctx: kontekst(), resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(PASIENT) });
			expect(b.tillatt).toBe(true);
			expect(b.grunnlag).toBe('behandlingsrelasjon');
			expect(b.purposeOfUse).toBe('TREAT');
		});

		it('gjelder bare den pasienten relasjonen er registrert på', async () => {
			await girRelasjon('bruker-1', PASIENT);
			const b = await vurder({ ctx: kontekst(), resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(ANNEN_PASIENT) });
			expect(b.tillatt).toBe(false);
		});

		it('ser bort fra utløpt relasjon', async () => {
			await settInn(
				"INSERT INTO care_relationship (id, user_id, patient_id, grunnlag, gyldig_fra, gyldig_til) VALUES ($1,$2,$3,'vikar', now() - interval '30 days', now() - interval '1 day')",
				[nyId(), 'bruker-1', PASIENT]
			);
			expect(await harBehandlingsrelasjon('bruker-1', PASIENT)).toBe(false);
		});

		it('krever ikke relasjon for ressurser uten pasientopplysninger', async () => {
			const b = await vurder({ ctx: kontekst(), resourceType: 'Organization', operasjon: 'r' });
			expect(b.tillatt).toBe(true);
			expect(b.grunnlag).toBe('ikke-pasientdata');
		});
	});

	describe('lag 4 - sperring', () => {
		beforeEach(async () => {
			await girRelasjon('bruker-1', PASIENT);
			await girRelasjon('bruker-2', PASIENT);
		});

		it('sperrer for en navngitt bruker', async () => {
			await settInn(
				"INSERT INTO journal_sperring (id, patient_id, omfang, mal_user_id, registrert_av) VALUES ($1,$2,'bruker',$3,'bruker-1')",
				[nyId(), PASIENT, 'bruker-2']
			);
			const sykepleier = kontekst({ userId: 'bruker-2', roller: ['sykepleier'] });
			const b = await vurder({ ctx: sykepleier, resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(PASIENT) });
			expect(b.tillatt).toBe(false);
			expect(b.grunn).toMatch(/sperret/);

			// Legen er ikke omfattet av sperringen.
			expect((await vurder({ ctx: kontekst(), resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(PASIENT) })).tillatt).toBe(true);
		});

		it('sperrer for en hel rolle', async () => {
			await settInn(
				"INSERT INTO journal_sperring (id, patient_id, omfang, mal_rolle, registrert_av) VALUES ($1,$2,'rolle','sykepleier','bruker-1')",
				[nyId(), PASIENT]
			);
			const sykepleier = kontekst({ userId: 'bruker-2', roller: ['sykepleier'] });
			expect((await vurder({ ctx: sykepleier, resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(PASIENT) })).tillatt).toBe(false);
		});

		it('sperrer et enkeltdokument', async () => {
			await settInn(
				"INSERT INTO journal_sperring (id, patient_id, omfang, mal_ressurs, registrert_av) VALUES ($1,$2,'dokument','Observation/obs-1','bruker-1')",
				[nyId(), PASIENT]
			);
			expect((await vurder({ ctx: kontekst(), resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(PASIENT) })).tillatt).toBe(false);
			// En annen observasjon er ikke sperret.
			expect(
				(await vurder({ ctx: kontekst(), resourceType: 'Observation', operasjon: 'r', ressurs: { ...observasjon(PASIENT), id: 'obs-2' } })).tillatt
			).toBe(true);
		});

		it('ser bort fra opphevet sperring', async () => {
			await settInn(
				"INSERT INTO journal_sperring (id, patient_id, omfang, registrert_av, opphevet) VALUES ($1,$2,'alle','bruker-1',true)",
				[nyId(), PASIENT]
			);
			expect((await vurder({ ctx: kontekst(), resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(PASIENT) })).tillatt).toBe(true);
		});
	});

	describe('nødrett', () => {
		it('gir tilgang uten behandlingsrelasjon, og merker formålet ETREAT', async () => {
			await settInn(
				"INSERT INTO break_glass (id, user_id, patient_id, begrunnelse, utloper) VALUES ($1,$2,$3,$4, now() + interval '4 hours')",
				[nyId(), 'bruker-1', PASIENT, 'Akutt situasjon på legevakt']
			);
			expect(await aktivNodrett('bruker-1', PASIENT)).toBe(true);
			const b = await vurder({ ctx: kontekst(), resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(PASIENT) });
			expect(b.tillatt).toBe(true);
			expect(b.grunnlag).toBe('nodrett');
			expect(b.purposeOfUse).toBe('ETREAT');
		});

		it('overstyrer sperring', async () => {
			await settInn("INSERT INTO journal_sperring (id, patient_id, omfang, registrert_av) VALUES ($1,$2,'alle','bruker-1')", [nyId(), PASIENT]);
			await settInn(
				"INSERT INTO break_glass (id, user_id, patient_id, begrunnelse, utloper) VALUES ($1,$2,$3,'Nødsituasjon', now() + interval '1 hour')",
				[nyId(), 'bruker-1', PASIENT]
			);
			expect((await vurder({ ctx: kontekst(), resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(PASIENT) })).tillatt).toBe(true);
		});

		it('utløper', async () => {
			await settInn(
				"INSERT INTO break_glass (id, user_id, patient_id, begrunnelse, startet, utloper) VALUES ($1,$2,$3,'Gammel', now() - interval '5 hours', now() - interval '1 hour')",
				[nyId(), 'bruker-1', PASIENT]
			);
			expect(await aktivNodrett('bruker-1', PASIENT)).toBe(false);
		});

		it('overstyrer aldri manglende scope', async () => {
			await settInn(
				"INSERT INTO break_glass (id, user_id, patient_id, begrunnelse, utloper) VALUES ($1,$2,$3,'Nød', now() + interval '1 hour')",
				[nyId(), 'bruker-1', PASIENT]
			);
			const app = appKontekst('patient/Observation.rs', PASIENT);
			const b = await vurder({ ctx: app, resourceType: 'Condition', operasjon: 'r', patientId: PASIENT });
			expect(b.tillatt).toBe(false);
			expect(b.grunn).toMatch(/scope/);
		});
	});

	describe('lag 1 og 2 - scope og rolle', () => {
		beforeEach(async () => { await girRelasjon('bruker-1', PASIENT); });

		it('nekter skriving for rolle uten skriverettighet', async () => {
			const sekretaer = kontekst({ roller: ['helsesekretaer'] });
			const b = await vurder({ ctx: sekretaer, resourceType: 'Observation', operasjon: 'c', ressurs: observasjon(PASIENT) });
			expect(b.tillatt).toBe(false);
		});

		it('nekter app som mangler scope for ressurstypen', async () => {
			const app = appKontekst('patient/Observation.rs', PASIENT);
			expect((await vurder({ ctx: app, resourceType: 'MedicationRequest', operasjon: 'r', patientId: PASIENT })).tillatt).toBe(false);
		});

		it('nekter app som prøver seg på en annen pasient enn i launch-konteksten', async () => {
			await girRelasjon('bruker-1', ANNEN_PASIENT);
			const app = appKontekst('patient/Observation.rs', PASIENT);
			expect((await vurder({ ctx: app, resourceType: 'Observation', operasjon: 'r', patientId: ANNEN_PASIENT })).tillatt).toBe(false);
		});
	});

	describe('innbygger med innsyn i egen journal', () => {
		it('ser bare sin egen journal, og kan ikke skrive', async () => {
			const pasientCtx = kontekst({ roller: ['pasient'], actorRef: `Patient/${PASIENT}`, userId: 'innbygger-1' });
			const egen = await vurder({ ctx: pasientCtx, resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(PASIENT) });
			expect(egen.tillatt).toBe(true);
			expect(egen.purposeOfUse).toBe('PATRQT');

			const annen = await vurder({ ctx: pasientCtx, resourceType: 'Observation', operasjon: 'r', ressurs: observasjon(ANNEN_PASIENT) });
			expect(annen.tillatt).toBe(false);

			const skriv = await vurder({ ctx: pasientCtx, resourceType: 'Observation', operasjon: 'u', ressurs: observasjon(PASIENT) });
			expect(skriv.tillatt).toBe(false);
		});
	});

	describe('avgrensning av søk', () => {
		it('gir bare pasientene brukeren har relasjon til', async () => {
			await girRelasjon('bruker-1', PASIENT);
			await girRelasjon('bruker-1', ANNEN_PASIENT);
			const tillatte = await tillattePasienter(kontekst());
			expect(tillatte).not.toBe('alle');
			expect([...(tillatte as string[])].sort()).toEqual([PASIENT, ANNEN_PASIENT].sort());
		});

		it('tar med pasienter det er nødrett på', async () => {
			await settInn(
				"INSERT INTO break_glass (id, user_id, patient_id, begrunnelse, utloper) VALUES ($1,$2,$3,'Nød', now() + interval '1 hour')",
				[nyId(), 'bruker-1', 'pas-9']
			);
			expect(await tillattePasienter(kontekst())).toContain('pas-9');
		});

		it('gir «alle» til personvernombudet', async () => {
			expect(await tillattePasienter(kontekst({ roller: ['personvernombud'] }))).toBe('alle');
		});

		it('avgrenser til launch-pasienten når appen bare har patient/-scope', async () => {
			await girRelasjon('bruker-1', ANNEN_PASIENT);
			const app = appKontekst('patient/Observation.rs', PASIENT);
			expect(await tillattePasienter(app)).toEqual([PASIENT]);
		});

		it('lister sperrede pasienter som skal filtreres bort', async () => {
			await settInn("INSERT INTO journal_sperring (id, patient_id, omfang, registrert_av) VALUES ($1,$2,'alle','bruker-1')", [nyId(), ANNEN_PASIENT]);
			const sperret = await sperredePasienter(kontekst());
			expect(sperret.has(ANNEN_PASIENT)).toBe(true);
		});

		it('fjerner sperring fra listen når det finnes nødrett', async () => {
			await settInn("INSERT INTO journal_sperring (id, patient_id, omfang, registrert_av) VALUES ($1,$2,'alle','bruker-1')", [nyId(), ANNEN_PASIENT]);
			await settInn(
				"INSERT INTO break_glass (id, user_id, patient_id, begrunnelse, utloper) VALUES ($1,$2,$3,'Nød', now() + interval '1 hour')",
				[nyId(), 'bruker-1', ANNEN_PASIENT]
			);
			expect((await sperredePasienter(kontekst())).has(ANNEN_PASIENT)).toBe(false);
		});
	});

	describe('ressurser der pasienten ikke kan avgjøres', () => {
		/**
		 * Tjenstlig behov og sperring forutsetter begge at vi vet hvilken pasient
		 * opplysningen gjelder. Før dette slapp et oppslag der pasienten ikke lot
		 * seg utlede rett gjennom - `Binary` var en slik type, og den bærer
		 * vedlegg: skannede dokumenter, prøvesvar, bilder.
		 */
		it('nekter oppslag på en pasientnær type uten pasientreferanse', async () => {
			await girRelasjon('bruker-1', PASIENT);
			const b = await vurder({
				ctx: kontekst({ scopes: parseScopes('user/Binary.rs user/Observation.rs') }),
				resourceType: 'Binary',
				operasjon: 'r',
				ressurs: { resourceType: 'Binary', id: 'bin-1', contentType: 'application/pdf' }
			});
			expect(b.tillatt).toBe(false);
			expect(b.grunn).toMatch(/pasientreferanse/);
		});

		it('nekter oppslag når referansen mangler på en type som ellers har den', async () => {
			await girRelasjon('bruker-1', PASIENT);
			const utenSubject = { resourceType: 'Observation', id: 'obs-2', status: 'final', code: { text: 'Uten pasient' } };
			const b = await vurder({ ctx: kontekst(), resourceType: 'Observation', operasjon: 'r', ressurs: utenSubject });
			expect(b.tillatt).toBe(false);
			expect(b.grunn).toMatch(/pasientreferanse/);
		});

		it('lar søk slippe gjennom - der avgrenses det per treff i stedet', async () => {
			const b = await vurder({ ctx: kontekst(), resourceType: 'Observation', operasjon: 's' });
			expect(b.tillatt).toBe(true);
		});

		/**
		 * Strukturell kontroll, ikke en liste å vedlikeholde: legger noen til en
		 * ressurstype uten `patient`/`subject`-parameter, skal den enten unntas
		 * eksplisitt som ikke-pasientnær, eller feile her.
		 */
		it('alle støttede pasientnære typer har en pasientreferanse å avgrense på', () => {
			const uavklarte = STOTTEDE_RESSURSTYPER.filter((t) => erPasientnaer(t) && !kanAvgjorePasient(t));
			expect(uavklarte).toEqual([]);
		});
	});
});

describe('pasient-id fra ressurs', () => {
	it('finner pasienten via subject, patient og beneficiary', () => {
		expect(pasientIdFraRessurs({ resourceType: 'Observation', subject: { reference: 'Patient/p1' } })).toBe('p1');
		expect(pasientIdFraRessurs({ resourceType: 'AllergyIntolerance', patient: { reference: 'Patient/p2' } })).toBe('p2');
		expect(pasientIdFraRessurs({ resourceType: 'Coverage', beneficiary: { reference: 'Patient/p3' } })).toBe('p3');
	});

	it('bruker id-en når ressursen er pasienten selv', () => {
		expect(pasientIdFraRessurs({ resourceType: 'Patient', id: 'p4' })).toBe('p4');
	});

	it('gir null når ressursen ikke gjelder en pasient', () => {
		expect(pasientIdFraRessurs({ resourceType: 'Organization', id: 'o1' })).toBeNull();
	});
});
