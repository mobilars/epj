import { manifest as billing } from './billing/manifest';
import { manifest as cdsServices } from './cds-services/manifest';
import { manifest as fhirBrowser } from './fhir-browser/manifest';
import { manifest as medications } from './medications/manifest';
import { manifest as messages } from './messages/manifest';
import { manifest as notes } from './notes/manifest';
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
export const appManifests = [overview, notes, medications, sfm, messages, billing, cdsServices, fhirBrowser];
