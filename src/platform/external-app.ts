/** How an external app is named wherever the record marks one, on its frame and on links to it. */
export const externalAppLabel = (name: string, approved = true) =>
	`Ekstern app - ${name}${approved ? '' : ` - ${NOT_APPROVED}`}`;

export const NOT_APPROVED = 'ikke godkjent av plattformeier';

export const NOT_APPROVED_EXPLANATION =
	'Plattformeier har ikke vurdert denne appen. Virksomhetens administrator har valgt å ta den i bruk likevel.';
