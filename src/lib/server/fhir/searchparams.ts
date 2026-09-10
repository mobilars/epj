export type ParamKind = 'string' | 'token' | 'reference' | 'date' | 'number' | 'quantity' | 'uri';

export interface SearchParamDef {
	kind: ParamKind;
	/** Enkle punktseparerte stier inn i ressursen. Arrays traverseres automatisk. */
	paths: string[];
	/** Ressurstyper en referanse kan peke på (brukes for kjedede søk). */
	targets?: string[];
	doc?: string;
}

const p = (kind: ParamKind, paths: string | string[], extra: Partial<SearchParamDef> = {}): SearchParamDef => ({
	kind,
	paths: Array.isArray(paths) ? paths : [paths],
	...extra
});

/** Søkeparametere som gjelder alle ressurstyper. */
export const FELLES_PARAMS: Record<string, SearchParamDef> = {
	_id: p('token', 'id'),
	_lastUpdated: p('date', 'meta.lastUpdated'),
	_profile: p('uri', 'meta.profile'),
	_tag: p('token', 'meta.tag'),
	_security: p('token', 'meta.security'),
	_source: p('uri', 'meta.source')
};

const pasientRef = (sti = 'subject') => p('reference', sti, { targets: ['Patient', 'Group'] });

export const SEARCH_PARAMS: Record<string, Record<string, SearchParamDef>> = {
	Patient: {
		identifier: p('token', 'identifier'),
		name: p('string', ['name.family', 'name.given', 'name.text']),
		family: p('string', 'name.family'),
		given: p('string', 'name.given'),
		birthdate: p('date', 'birthDate'),
		gender: p('token', 'gender'),
		address: p('string', ['address.line', 'address.city', 'address.postalCode']),
		'address-postalcode': p('string', 'address.postalCode'),
		telecom: p('token', 'telecom'),
		phone: p('token', 'telecom'),
		email: p('token', 'telecom'),
		active: p('token', 'active'),
		'general-practitioner': p('reference', 'generalPractitioner', {
			targets: ['Practitioner', 'PractitionerRole', 'Organization']
		}),
		organization: p('reference', 'managingOrganization', { targets: ['Organization'] }),
		deceased: p('token', 'deceasedBoolean'),
		'link-target': p('reference', 'link.other', { targets: ['Patient', 'RelatedPerson'] })
	},
	Practitioner: {
		identifier: p('token', 'identifier'),
		name: p('string', ['name.family', 'name.given', 'name.text']),
		family: p('string', 'name.family'),
		given: p('string', 'name.given'),
		active: p('token', 'active'),
		telecom: p('token', 'telecom'),
		qualification: p('token', 'qualification.code')
	},
	PractitionerRole: {
		practitioner: p('reference', 'practitioner', { targets: ['Practitioner'] }),
		organization: p('reference', 'organization', { targets: ['Organization'] }),
		role: p('token', 'code'),
		specialty: p('token', 'specialty'),
		identifier: p('token', 'identifier'),
		active: p('token', 'active')
	},
	Organization: {
		identifier: p('token', 'identifier'),
		name: p('string', ['name', 'alias']),
		type: p('token', 'type'),
		active: p('token', 'active'),
		partof: p('reference', 'partOf', { targets: ['Organization'] })
	},
	Encounter: {
		patient: pasientRef(),
		subject: pasientRef(),
		status: p('token', 'status'),
		class: p('token', 'class'),
		type: p('token', 'type'),
		date: p('date', 'actualPeriod'),
		participant: p('reference', 'participant.actor', { targets: ['Practitioner', 'PractitionerRole', 'RelatedPerson'] }),
		practitioner: p('reference', 'participant.actor', { targets: ['Practitioner'] }),
		'service-provider': p('reference', 'serviceProvider', { targets: ['Organization'] }),
		identifier: p('token', 'identifier'),
		'reason-code': p('token', 'reason.value.concept')
	},
	Condition: {
		patient: pasientRef(),
		subject: pasientRef(),
		code: p('token', 'code'),
		'clinical-status': p('token', 'clinicalStatus'),
		'verification-status': p('token', 'verificationStatus'),
		category: p('token', 'category'),
		encounter: p('reference', 'encounter', { targets: ['Encounter'] }),
		'onset-date': p('date', ['onsetDateTime', 'onsetPeriod']),
		'recorded-date': p('date', 'recordedDate'),
		severity: p('token', 'severity')
	},
	Observation: {
		patient: pasientRef(),
		subject: pasientRef(),
		code: p('token', 'code'),
		category: p('token', 'category'),
		date: p('date', ['effectiveDateTime', 'effectivePeriod', 'effectiveInstant']),
		status: p('token', 'status'),
		encounter: p('reference', 'encounter', { targets: ['Encounter'] }),
		performer: p('reference', 'performer', { targets: ['Practitioner', 'PractitionerRole', 'Organization'] }),
		'value-quantity': p('quantity', 'valueQuantity'),
		'value-concept': p('token', 'valueCodeableConcept'),
		'based-on': p('reference', 'basedOn', { targets: ['ServiceRequest', 'CarePlan'] }),
		'has-member': p('reference', 'hasMember', { targets: ['Observation'] })
	},
	MedicationRequest: {
		patient: pasientRef(),
		subject: pasientRef(),
		status: p('token', 'status'),
		intent: p('token', 'intent'),
		code: p('token', ['medication.concept', 'medication.reference']),
		authoredon: p('date', 'authoredOn'),
		requester: p('reference', 'requester', { targets: ['Practitioner', 'PractitionerRole'] }),
		encounter: p('reference', 'encounter', { targets: ['Encounter'] }),
		identifier: p('token', 'identifier'),
		category: p('token', 'category')
	},
	MedicationStatement: {
		patient: pasientRef(),
		subject: pasientRef(),
		status: p('token', 'status'),
		code: p('token', 'medication.concept'),
		effective: p('date', ['effectiveDateTime', 'effectivePeriod'])
	},
	MedicationDispense: {
		patient: pasientRef(),
		subject: pasientRef(),
		status: p('token', 'status'),
		code: p('token', 'medication.concept'),
		prescription: p('reference', 'authorizingPrescription', { targets: ['MedicationRequest'] }),
		whenhandedover: p('date', 'whenHandedOver')
	},
	Medication: {
		code: p('token', 'code'),
		identifier: p('token', 'identifier'),
		status: p('token', 'status')
	},
	AllergyIntolerance: {
		patient: p('reference', 'patient', { targets: ['Patient'] }),
		code: p('token', ['code', 'reaction.substance']),
		'clinical-status': p('token', 'clinicalStatus'),
		criticality: p('token', 'criticality'),
		type: p('token', 'type'),
		date: p('date', 'recordedDate')
	},
	Immunization: {
		patient: p('reference', 'patient', { targets: ['Patient'] }),
		'vaccine-code': p('token', 'vaccineCode'),
		status: p('token', 'status'),
		date: p('date', 'occurrenceDateTime'),
		'lot-number': p('string', 'lotNumber')
	},
	Procedure: {
		patient: pasientRef(),
		subject: pasientRef(),
		code: p('token', 'code'),
		status: p('token', 'status'),
		date: p('date', ['occurrenceDateTime', 'occurrencePeriod']),
		encounter: p('reference', 'encounter', { targets: ['Encounter'] })
	},
	DiagnosticReport: {
		patient: pasientRef(),
		subject: pasientRef(),
		code: p('token', 'code'),
		category: p('token', 'category'),
		status: p('token', 'status'),
		date: p('date', ['effectiveDateTime', 'effectivePeriod']),
		issued: p('date', 'issued'),
		'based-on': p('reference', 'basedOn', { targets: ['ServiceRequest'] }),
		result: p('reference', 'result', { targets: ['Observation'] })
	},
	ServiceRequest: {
		patient: pasientRef(),
		subject: pasientRef(),
		status: p('token', 'status'),
		intent: p('token', 'intent'),
		code: p('token', 'code.concept'),
		category: p('token', 'category'),
		authored: p('date', 'authoredOn'),
		requester: p('reference', 'requester', { targets: ['Practitioner', 'PractitionerRole'] }),
		performer: p('reference', 'performer', { targets: ['Practitioner', 'Organization'] }),
		encounter: p('reference', 'encounter', { targets: ['Encounter'] }),
		identifier: p('token', 'identifier')
	},
	DocumentReference: {
		patient: pasientRef(),
		subject: pasientRef(),
		type: p('token', 'type'),
		category: p('token', 'category'),
		status: p('token', 'status'),
		date: p('date', 'date'),
		author: p('reference', 'author', { targets: ['Practitioner', 'Organization', 'Patient'] }),
		identifier: p('token', 'identifier'),
		encounter: p('reference', 'context.encounter', { targets: ['Encounter'] })
	},
	Composition: {
		patient: pasientRef(),
		subject: pasientRef(),
		type: p('token', 'type'),
		status: p('token', 'status'),
		date: p('date', 'date'),
		author: p('reference', 'author', { targets: ['Practitioner', 'PractitionerRole', 'Organization'] }),
		encounter: p('reference', 'encounter', { targets: ['Encounter'] }),
		category: p('token', 'category'),
		title: p('string', 'title')
	},
	CarePlan: {
		patient: pasientRef(),
		subject: pasientRef(),
		status: p('token', 'status'),
		category: p('token', 'category'),
		date: p('date', 'period')
	},
	Goal: {
		patient: pasientRef(),
		subject: pasientRef(),
		'lifecycle-status': p('token', 'lifecycleStatus'),
		category: p('token', 'category')
	},
	Appointment: {
		patient: p('reference', 'participant.actor', { targets: ['Patient', 'Practitioner', 'Location'] }),
		actor: p('reference', 'participant.actor', { targets: ['Patient', 'Practitioner', 'Location'] }),
		practitioner: p('reference', 'participant.actor', { targets: ['Practitioner'] }),
		status: p('token', 'status'),
		date: p('date', 'start'),
		'service-type': p('token', 'serviceType'),
		identifier: p('token', 'identifier')
	},
	Schedule: {
		actor: p('reference', 'actor', { targets: ['Practitioner', 'Location'] }),
		date: p('date', 'planningHorizon'),
		active: p('token', 'active')
	},
	Slot: {
		schedule: p('reference', 'schedule', { targets: ['Schedule'] }),
		status: p('token', 'status'),
		start: p('date', 'start')
	},
	Communication: {
		patient: pasientRef(),
		subject: pasientRef(),
		status: p('token', 'status'),
		category: p('token', 'category'),
		sent: p('date', 'sent'),
		received: p('date', 'received'),
		sender: p('reference', 'sender', { targets: ['Practitioner', 'Organization', 'Patient'] }),
		recipient: p('reference', 'recipient', { targets: ['Practitioner', 'Organization', 'Patient'] }),
		identifier: p('token', 'identifier')
	},
	CommunicationRequest: {
		patient: pasientRef(),
		status: p('token', 'status'),
		authored: p('date', 'authoredOn')
	},
	Task: {
		patient: p('reference', 'for', { targets: ['Patient'] }),
		status: p('token', 'status'),
		owner: p('reference', 'owner', { targets: ['Practitioner', 'PractitionerRole', 'Organization'] }),
		code: p('token', 'code'),
		'authored-on': p('date', 'authoredOn'),
		'business-status': p('token', 'businessStatus'),
		priority: p('token', 'priority'),
		focus: p('reference', 'focus')
	},
	Consent: {
		patient: p('reference', 'subject', { targets: ['Patient'] }),
		subject: p('reference', 'subject', { targets: ['Patient'] }),
		status: p('token', 'status'),
		category: p('token', 'category'),
		date: p('date', 'date'),
		actor: p('reference', 'provision.actor.reference')
	},
	Coverage: {
		patient: p('reference', 'beneficiary', { targets: ['Patient'] }),
		beneficiary: p('reference', 'beneficiary', { targets: ['Patient'] }),
		status: p('token', 'status'),
		type: p('token', 'type'),
		identifier: p('token', 'identifier')
	},
	Claim: {
		patient: p('reference', 'patient', { targets: ['Patient'] }),
		status: p('token', 'status'),
		created: p('date', 'created'),
		provider: p('reference', 'provider', { targets: ['Practitioner', 'Organization'] }),
		identifier: p('token', 'identifier'),
		use: p('token', 'use')
	},
	ClaimResponse: {
		patient: p('reference', 'patient', { targets: ['Patient'] }),
		status: p('token', 'status'),
		created: p('date', 'created'),
		request: p('reference', 'request', { targets: ['Claim'] }),
		outcome: p('token', 'outcome')
	},
	ChargeItem: {
		patient: pasientRef(),
		code: p('token', 'code'),
		'entered-date': p('date', 'enteredDate'),
		status: p('token', 'status'),
		encounter: p('reference', 'encounter', { targets: ['Encounter'] })
	},
	Invoice: {
		patient: p('reference', 'subject', { targets: ['Patient'] }),
		status: p('token', 'status'),
		date: p('date', 'date'),
		identifier: p('token', 'identifier')
	},
	RelatedPerson: {
		patient: p('reference', 'patient', { targets: ['Patient'] }),
		name: p('string', ['name.family', 'name.given']),
		relationship: p('token', 'relationship'),
		active: p('token', 'active')
	},
	Questionnaire: {
		url: p('uri', 'url'),
		status: p('token', 'status'),
		title: p('string', 'title'),
		code: p('token', 'code')
	},
	QuestionnaireResponse: {
		patient: pasientRef(),
		subject: pasientRef(),
		questionnaire: p('uri', 'questionnaire'),
		status: p('token', 'status'),
		authored: p('date', 'authored'),
		encounter: p('reference', 'encounter', { targets: ['Encounter'] })
	},
	Flag: {
		patient: pasientRef(),
		status: p('token', 'status'),
		category: p('token', 'category'),
		date: p('date', 'period')
	},
	FamilyMemberHistory: {
		patient: p('reference', 'patient', { targets: ['Patient'] }),
		relationship: p('token', 'relationship'),
		status: p('token', 'status')
	},
	RiskAssessment: {
		patient: pasientRef(),
		status: p('token', 'status'),
		date: p('date', 'occurrenceDateTime')
	},
	List: {
		patient: pasientRef(),
		code: p('token', 'code'),
		status: p('token', 'status'),
		date: p('date', 'date')
	},
	// Group er med vilje ikke støttet gjennom /fhir, av samme grunn som Binary.
	//
	// En Group kan ha `member.entity` som peker på pasienter - et kohortuttrekk
	// er nettopp en liste over hvem som hører til, og for et fastlegekontor kan
	// selve medlemskapet være den følsomme opplysningen. Typen har ingen
	// `subject`, så tilgangen kan ikke vurderes per pasient. Den sto tidligere
	// oppført som «ikke pasientnær», og slapp dermed forbi både tjenstlig behov
	// og sperring.
	Location: {
		name: p('string', 'name'),
		identifier: p('token', 'identifier'),
		status: p('token', 'status'),
		organization: p('reference', 'managingOrganization', { targets: ['Organization'] })
	},
	AuditEvent: {
		patient: p('reference', 'patient', { targets: ['Patient'] }),
		date: p('date', 'recorded'),
		agent: p('reference', 'agent.who'),
		action: p('token', 'action'),
		outcome: p('token', 'outcome'),
		category: p('token', 'category'),
		code: p('token', 'code')
	},
	Provenance: {
		target: p('reference', 'target'),
		agent: p('reference', 'agent.who'),
		recorded: p('date', 'recorded'),
		patient: p('reference', 'patient', { targets: ['Patient'] })
	},
	// Binary er med vilje ikke støttet gjennom /fhir.
	//
	// Ressursen bærer vedlegg - skannede dokumenter, prøvesvar, bilder - men har
	// ingen `subject` eller `patient`. Tilgangskontrollen kan derfor ikke avgjøre
	// hvilken pasient et vedlegg hører til, og verken tjenstlig behov eller
	// sperring lar seg håndheve. Så lenge typen sto her, kunne et token med
	// `Binary`-scope hente hvilket som helst vedlegg i virksomheten.
	//
	// Skal vedlegg eksponeres, må pasienten utledes fra den DocumentReference
	// som peker på ressursen, og tilgangen vurderes mot den. Se docs/todo.md.
	Subscription: {
		status: p('token', 'status'),
		topic: p('uri', 'topic'),
		identifier: p('token', 'identifier')
	}
};

export const STOTTEDE_RESSURSTYPER = Object.keys(SEARCH_PARAMS);

export function paramDef(resourceType: string, navn: string): SearchParamDef | undefined {
	return SEARCH_PARAMS[resourceType]?.[navn] ?? FELLES_PARAMS[navn];
}

/**
 * Ressurstyper som alltid gjelder én pasient. Brukes av tilgangskontrollen til å
 * avgjøre om et kall må avgrenses til pasienter brukeren har tjenstlig behov for.
 */
export const PASIENTKOMPARTMENT: Record<string, string[]> = Object.fromEntries(
	Object.entries(SEARCH_PARAMS)
		.map(([type, params]) => {
			const pasientParams = Object.entries(params)
				.filter(([navn, def]) => def.kind === 'reference' && (navn === 'patient' || navn === 'subject' || navn === 'beneficiary'))
				.filter(([, def]) => !def.targets || def.targets.includes('Patient'))
				.map(([navn]) => navn);
			return [type, pasientParams] as const;
		})
		.filter(([, params]) => params.length > 0)
);
