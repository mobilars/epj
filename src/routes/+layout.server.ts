import type { LayoutServerLoad } from './$types';
import { config } from '$srv/config';
import { ROLLE_DEFINISJONER } from '$srv/authz/roles';

/** Felles data for hele applikasjonen: hvem er pålogget, og i hvilket miljø. */
export const load: LayoutServerLoad = async (event) => {
	const ctx = event.locals.auth;
	return {
		bruker: ctx
			? {
					navn: ctx.navn,
					roller: ctx.roller,
					rollenavn: ctx.roller.map((r) => ROLLE_DEFINISJONER[r]?.navn ?? r),
					rettigheter: [...ctx.rettigheter],
					mate: ctx.mate,
					amr: ctx.amr
				}
			: null,
		organisasjon: config.organisasjon.navn,
		miljo: {
			integrasjoner: config.integrasjoner.modus,
			testinnlogging: config.testinnlogging.aktivert,
			produksjon: process.env.NODE_ENV === 'production'
		}
	};
};
