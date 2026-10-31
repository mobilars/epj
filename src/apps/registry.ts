import { manifest as billing, type permissions as billingPermissions } from './billing/manifest';
import { manifest as cdsServices } from './cds-services/manifest';
import { manifest as fhirBrowser } from './fhir-browser/manifest';
import { manifest as medications, type permissions as medicationPermissions } from './medications/manifest';
import { manifest as messages, type permissions as messagePermissions } from './messages/manifest';
import { manifest as notes } from './notes/manifest';
import type { AppManifest } from '$lib/app-manifest';
import { manifest as overview } from './overview/manifest';
import { manifest as sfm } from './sfm/manifest';

/**
 * The apps in this codebase. The one place the platform learns of them: adding an
 * app means adding it here, and removing one means removing it here.
 *
 * Together with `slots.ts` and `registry.server.ts`, this is what the platform may
 * import from src/apps, apart from the one-line files that mount an app's routes.
 * A test holds that line.
 */
export const appManifests: AppManifest[] = [overview, notes, medications, sfm, messages, billing, cdsServices, fhirBrowser];

/** The permissions apps declare, so that a misspelt one is a compile error. */
export type AppPermissionId = (typeof billingPermissions | typeof medicationPermissions | typeof messagePermissions)[number]['id'];
