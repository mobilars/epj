import { describe, expect, it } from 'vitest';
import { beskrivScope, parseScope, parseScopes, sjekkScope, snevreInn } from '../src/lib/server/authz/scopes';

describe('parsing av SMART-scope', () => {
	it('leser v2-scope', () => {
		const s = parseScope('patient/Observation.rs');
		expect(s).toMatchObject({ kontekst: 'patient', ressurs: 'Observation' });
		expect([...(s?.operasjoner ?? [])].sort()).toEqual(['r', 's']);
	});

	it('leser v1-scope som v2', () => {
		expect([...(parseScope('user/Patient.read')?.operasjoner ?? [])].sort()).toEqual(['r', 's']);
		expect([...(parseScope('user/Patient.write')?.operasjoner ?? [])].sort()).toEqual(['c', 'd', 'u']);
		expect([...(parseScope('system/*.*')?.operasjoner ?? [])].sort()).toEqual(['c', 'd', 'r', 's', 'u']);
	});

	it('krever normativ rekkefølge på operasjonsbokstavene', () => {
		expect(parseScope('user/Patient.sr')).toBeNull();
		expect(parseScope('user/Patient.rs')).not.toBeNull();
	});

	it('leser søkebegrensning', () => {
		const s = parseScope('patient/Observation.rs?category=vital-signs');
		expect(s?.begrensning?.get('category')).toBe('vital-signs');
	});

	it('avviser sprøyt', () => {
		expect(parseScope('patient/Observation')).toBeNull();
		expect(parseScope('noe/Observation.rs')).toBeNull();
		expect(parseScope('patient/Observation.xyz')).toBeNull();
	});

	it('skiller spesialscope fra kliniske scope', () => {
		const sett = parseScopes('openid fhirUser launch/patient patient/Patient.rs');
		expect(sett.spesielle.has('openid')).toBe(true);
		expect(sett.spesielle.has('launch/patient')).toBe(true);
		expect(sett.kliniske).toHaveLength(1);
	});
});

describe('scope-kontroll', () => {
	it('nekter når scope mangler', () => {
		const sett = parseScopes('patient/Observation.rs');
		expect(sjekkScope(sett, { ressurs: 'Condition', operasjon: 'r' }).tillatt).toBe(false);
	});

	it('nekter skriving når bare lesescope er gitt', () => {
		const sett = parseScopes('user/Observation.rs');
		expect(sjekkScope(sett, { ressurs: 'Observation', operasjon: 'u' }).tillatt).toBe(false);
	});

	it('krever pasient i launch-kontekst for patient/-scope', () => {
		const sett = parseScopes('patient/Observation.rs');
		expect(sjekkScope(sett, { ressurs: 'Observation', operasjon: 'r' }).tillatt).toBe(false);
		expect(
			sjekkScope(sett, { ressurs: 'Observation', operasjon: 'r', tokenPasientId: 'p1', kontekstPasientId: 'p1' }).tillatt
		).toBe(true);
	});

	it('nekter patient/-scope for en annen pasient enn i tokenet', () => {
		const sett = parseScopes('patient/Observation.rs');
		const svar = sjekkScope(sett, { ressurs: 'Observation', operasjon: 'r', tokenPasientId: 'p1', kontekstPasientId: 'p2' });
		expect(svar.tillatt).toBe(false);
		expect(svar.grunn).toContain('annen pasient');
	});

	it('lar user/-scope gjelde på tvers av pasienter', () => {
		const sett = parseScopes('user/Observation.rs');
		expect(sjekkScope(sett, { ressurs: 'Observation', operasjon: 'r', kontekstPasientId: 'p9' }).tillatt).toBe(true);
	});

	it('lar jokertegn dekke alle ressurstyper', () => {
		const sett = parseScopes('user/*.cruds');
		expect(sjekkScope(sett, { ressurs: 'Condition', operasjon: 'd' }).tillatt).toBe(true);
	});

	it('krever håndheving av begrensning når alle treffende scope er begrenset', () => {
		const sett = parseScopes('patient/Observation.rs?category=vital-signs');
		const svar = sjekkScope(sett, { ressurs: 'Observation', operasjon: 'r', tokenPasientId: 'p1', kontekstPasientId: 'p1' });
		expect(svar.tillatt).toBe(true);
		expect(svar.begrensninger).toHaveLength(1);
		expect(svar.begrensninger[0].get('category')).toBe('vital-signs');
	});

	it('dropper begrensning når et ubegrenset scope også treffer', () => {
		const sett = parseScopes('patient/Observation.rs?category=vital-signs patient/Observation.rs');
		const svar = sjekkScope(sett, { ressurs: 'Observation', operasjon: 'r', tokenPasientId: 'p1', kontekstPasientId: 'p1' });
		expect(svar.begrensninger).toHaveLength(0);
	});
});

describe('innsnevring mot rolle', () => {
	it('fjerner scope klienten ikke er registrert for', () => {
		const ut = snevreInn('user/Patient.rs user/Condition.rs', ['user/Patient.rs'], new Set(['user/Patient.rs', 'user/Condition.rs']));
		expect(ut).toBe('user/Patient.rs');
	});

	it('fjerner scope brukerens rolle ikke gir', () => {
		const ut = snevreInn('user/Patient.rs user/MedicationRequest.cruds', ['user/Patient.rs', 'user/MedicationRequest.cruds'], new Set(['user/Patient.rs']));
		expect(ut).toBe('user/Patient.rs');
	});

	it('lar et jokertegn hos brukeren dekke et smalere scope', () => {
		const ut = snevreInn('user/Observation.rs', ['user/Observation.rs'], new Set(['user/*.cruds']));
		expect(ut).toBe('user/Observation.rs');
	});

	it('beholder spesialscope uavhengig av rolle', () => {
		const ut = snevreInn('openid launch/patient user/Patient.rs', ['openid', 'launch/patient', 'user/Patient.rs'], new Set(['user/Patient.rs']));
		expect(ut.split(' ').sort()).toEqual(['launch/patient', 'openid', 'user/Patient.rs']);
	});
});

describe('forklaring til samtykkedialogen', () => {
	it('oversetter scope til norsk', () => {
		expect(beskrivScope('patient/Observation.rs')).toContain('målinger og prøvesvar');
		expect(beskrivScope('user/Condition.cruds')).toContain('diagnoser');
		expect(beskrivScope('offline_access')).toContain('ikke er pålogget');
	});
});
