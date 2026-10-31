/**
 * What an app built into this codebase tells the platform about itself.
 *
 * The platform draws the tabs, menus and shortcuts, and holds no list of its own
 * of what they are: an app appears because it declares it here, and removing the
 * app removes all of it. A practice can still put an external SMART app in a tab
 * in place of one of these. See docs/arkitektur.md.
 *
 * Labels are Norwegian, because they are shown as they stand. Kept free of server
 * code and of components, so it can be read anywhere.
 */

export interface CardDeclaration {
	id: string;
	title: string;
	/** What the card is for, shown where the layout is arranged. */
	description: string;
}

export interface AppManifest {
	/** The directory under src/apps. */
	id: string;
	name: string;
	/** Other apps this one may import from. Anything else is refused by a test. */
	dependsOn?: string[];
	/** A tab in the patient record. An empty segment is the record's front page. */
	patientTab?: { segment: string; label: string; order: number };
	/** An entry in the main menu, for those holding any of the permissions. */
	mainMenu?: { href: string; label: string; anyOf: string[]; order: number };
	/** A line under Snarveier in the patient record. */
	patientLink?: { segment: string; label: string; order: number };
	/** `g` then this key, anywhere. */
	goKey?: { key: string; href: string; label: string };
	/** `g` then this key, in a patient record. */
	patientGoKey?: { key: string; segment: string; label: string };
	/** A single key in a patient record: go to the segment and focus a field. */
	patientAction?: { key: string; segment: string; focusId: string; label: string };
	/** Cards this app offers on the work surface. */
	workspaceCards?: CardDeclaration[];
	/** Cards this app offers on the patient's front page. */
	patientCards?: CardDeclaration[];
}
