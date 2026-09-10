import { describe, expect, it } from 'vitest';
import { describeScope, parseScope, parseScopes, checkScope, narrowIn } from '../src/lib/server/authz/scopes';

describe('parsing av SMART-scope', () => {
	it('leser v2-scope', () => {
		const s = parseScope('patient/Observation.rs');
		expect(s).toMatchObject({ context: 'patient', resource: 'Observation' });
		expect([...(s?.operations ?? [])].sort()).toEqual(['r', 's']);
	});

	it('leser v1-scope som v2', () => {
		expect([...(parseScope('user/Patient.read')?.operations ?? [])].sort()).toEqual(['r', 's']);
		expect([...(parseScope('user/Patient.write')?.operations ?? [])].sort()).toEqual(['c', 'd', 'u']);
		expect([...(parseScope('system/*.*')?.operations ?? [])].sort()).toEqual(['c', 'd', 'r', 's', 'u']);
	});

	it('krever normativ rekkefølge på operasjonsbokstavene', () => {
		expect(parseScope('user/Patient.sr')).toBeNull();
		expect(parseScope('user/Patient.rs')).not.toBeNull();
	});

	it('leser søkebegrensning', () => {
		const s = parseScope('patient/Observation.rs?category=vital-signs');
		expect(s?.limitation?.get('category')).toBe('vital-signs');
	});

	it('avviser sprøyt', () => {
		expect(parseScope('patient/Observation')).toBeNull();
		expect(parseScope('noe/Observation.rs')).toBeNull();
		expect(parseScope('patient/Observation.xyz')).toBeNull();
	});

	it('skiller spesialscope fra kliniske scope', () => {
		const set = parseScopes('openid fhirUser launch/patient patient/Patient.rs');
		expect(set.spesielle.has('openid')).toBe(true);
		expect(set.spesielle.has('launch/patient')).toBe(true);
		expect(set.clinical).toHaveLength(1);
	});
});

describe('scope-kontroll', () => {
	it('nekter når scope mangler', () => {
		const set = parseScopes('patient/Observation.rs');
		expect(checkScope(set, { resource: 'Condition', operation: 'r' }).allowed).toBe(false);
	});

	it('nekter skriving når bare lesescope er gitt', () => {
		const set = parseScopes('user/Observation.rs');
		expect(checkScope(set, { resource: 'Observation', operation: 'u' }).allowed).toBe(false);
	});

	it('krever pasient i launch-kontekst for patient/-scope', () => {
		const set = parseScopes('patient/Observation.rs');
		expect(checkScope(set, { resource: 'Observation', operation: 'r' }).allowed).toBe(false);
		expect(
			checkScope(set, { resource: 'Observation', operation: 'r', tokenPatientId: 'p1', contextPatientId: 'p1' }).allowed
		).toBe(true);
	});

	it('nekter patient/-scope for en annen pasient enn i tokenet', () => {
		const set = parseScopes('patient/Observation.rs');
		const response = checkScope(set, { resource: 'Observation', operation: 'r', tokenPatientId: 'p1', contextPatientId: 'p2' });
		expect(response.allowed).toBe(false);
		expect(response.reason).toContain('annen pasient');
	});

	it('lar user/-scope gjelde på tvers av pasienter', () => {
		const set = parseScopes('user/Observation.rs');
		expect(checkScope(set, { resource: 'Observation', operation: 'r', contextPatientId: 'p9' }).allowed).toBe(true);
	});

	it('lar jokertegn dekke alle ressurstyper', () => {
		const set = parseScopes('user/*.cruds');
		expect(checkScope(set, { resource: 'Condition', operation: 'd' }).allowed).toBe(true);
	});

	it('krever håndheving av begrensning når alle treffende scope er begrenset', () => {
		const set = parseScopes('patient/Observation.rs?category=vital-signs');
		const response = checkScope(set, { resource: 'Observation', operation: 'r', tokenPatientId: 'p1', contextPatientId: 'p1' });
		expect(response.allowed).toBe(true);
		expect(response.limitations).toHaveLength(1);
		expect(response.limitations[0].get('category')).toBe('vital-signs');
	});

	it('dropper begrensning når et ubegrenset scope også treffer', () => {
		const set = parseScopes('patient/Observation.rs?category=vital-signs patient/Observation.rs');
		const response = checkScope(set, { resource: 'Observation', operation: 'r', tokenPatientId: 'p1', contextPatientId: 'p1' });
		expect(response.limitations).toHaveLength(0);
	});
});

describe('innsnevring mot rolle', () => {
	it('fjerner scope klienten ikke er registrert for', () => {
		const out = narrowIn('user/Patient.rs user/Condition.rs', ['user/Patient.rs'], new Set(['user/Patient.rs', 'user/Condition.rs']));
		expect(out).toBe('user/Patient.rs');
	});

	it('fjerner scope brukerens rolle ikke gir', () => {
		const out = narrowIn('user/Patient.rs user/MedicationRequest.cruds', ['user/Patient.rs', 'user/MedicationRequest.cruds'], new Set(['user/Patient.rs']));
		expect(out).toBe('user/Patient.rs');
	});

	it('lar et jokertegn hos brukeren dekke et smalere scope', () => {
		const out = narrowIn('user/Observation.rs', ['user/Observation.rs'], new Set(['user/*.cruds']));
		expect(out).toBe('user/Observation.rs');
	});

	it('lar user/-scope dekke tilsvarende patient/-scope', () => {
		// En app som startes i pasientkontekst ber om patient/-scope. Rollen til
		// helsepersonell er beskrevet med user/-scope, og må dekke den smalere
		// varianten - ellers kunne ingen kliniker starte en pasientnær app.
		const out = narrowIn(
			'patient/Observation.rs patient/Condition.rs',
			['patient/Observation.rs', 'patient/Condition.rs'],
			new Set(['user/Observation.rs', 'user/Condition.cruds'])
		);
		expect(out.split(' ').sort()).toEqual(['patient/Condition.rs', 'patient/Observation.rs']);
	});

	it('lar ikke patient/-scope dekke user/-scope', () => {
		const out = narrowIn('user/Observation.rs', ['user/Observation.rs'], new Set(['patient/Observation.rs']));
		expect(out).toBe('');
	});

	it('lar ikke system/-scope dekke brukerens scope', () => {
		const out = narrowIn('user/Observation.rs', ['user/Observation.rs'], new Set(['system/Observation.rs']));
		expect(out).toBe('');
	});

	it('gir ikke ubegrenset scope til en app som bare er tillatt et begrenset', () => {
		const out = narrowIn(
			'patient/Observation.rs',
			['patient/Observation.rs?category=vital-signs'],
			new Set(['user/Observation.rs'])
		);
		expect(out).toBe('');
	});

	it('beholder spesialscope uavhengig av rolle', () => {
		const out = narrowIn('openid launch/patient user/Patient.rs', ['openid', 'launch/patient', 'user/Patient.rs'], new Set(['user/Patient.rs']));
		expect(out.split(' ').sort()).toEqual(['launch/patient', 'openid', 'user/Patient.rs']);
	});
});

describe('forklaring til samtykkedialogen', () => {
	it('oversetter scope til norsk', () => {
		expect(describeScope('patient/Observation.rs')).toContain('målinger og prøvesvar');
		expect(describeScope('user/Condition.cruds')).toContain('diagnoser');
		expect(describeScope('offline_access')).toContain('ikke er pålogget');
	});
});
