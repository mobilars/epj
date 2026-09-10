/** Løst typet FHIR R5-representasjon. Validering skjer i `validate.ts`. */
export interface FhirResource {
	resourceType: string;
	id?: string;
	meta?: {
		versionId?: string;
		loadUpdated?: string;
		profile?: string[];
		security?: Coding[];
		tag?: Coding[];
		source?: string;
	};
	[key: string]: unknown;
}

export interface Coding {
	system?: string;
	code?: string;
	display?: string;
	version?: string;
}

export interface CodeableConcept {
	coding?: Coding[];
	text?: string;
}

export interface Identifier {
	use?: string;
	system?: string;
	value?: string;
	type?: CodeableConcept;
	assigner?: Reference;
}

export interface Reference {
	reference?: string;
	type?: string;
	identifier?: Identifier;
	display?: string;
}

export interface BundleEntry {
	fullUrl?: string;
	resource?: FhirResource;
	search?: { mode?: 'match' | 'include' | 'outcome'; score?: number };
	request?: { method: string; url: string; ifNoneExist?: string; ifMatch?: string };
	response?: { status: string; location?: string; etag?: string; loadModified?: string; outcome?: FhirResource };
}

export interface Bundle extends FhirResource {
	resourceType: 'Bundle';
	type: string;
	total?: number;
	link?: { relation: string; url: string }[];
	entry?: BundleEntry[];
}

export type IssueSeverity = 'fatal' | 'error' | 'warning' | 'information';

export interface OperationOutcomeIssue {
	severity: IssueSeverity;
	code: string;
	details?: CodeableConcept;
	diagnostics?: string;
	expression?: string[];
}
