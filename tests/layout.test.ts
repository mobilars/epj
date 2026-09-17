import { describe, expect, it } from 'vitest';
import { CARDS, defaultLayout, layoutFromForm, parseLayout } from '../src/lib/server/workspace/layout';

/**
 * Which cards a surface shows, and in what order.
 *
 * The rules that matter are the defensive ones: a stored layout can name a
 * card that no longer exists, and a form can leave everything unchecked.
 * Neither may produce a surface that points at nothing.
 */
describe('workspace layout', () => {
	it('defaults to every card in catalogue order', () => {
		expect(defaultLayout('arbeidsflate')).toEqual(['timebok', 'meldinger', 'oppgjor']);
		expect(defaultLayout('pasientoversikt')).toEqual(CARDS.pasientoversikt.map((c) => c.id));
	});

	it('keeps known cards in the stored order and drops the rest', () => {
		expect(parseLayout('arbeidsflate', JSON.stringify(['oppgjor', 'timebok']))).toEqual(['oppgjor', 'timebok']);
		expect(parseLayout('arbeidsflate', JSON.stringify(['oppgjor', 'nope', 'oppgjor', 'timebok']))).toEqual(['oppgjor', 'timebok']);
	});

	it('treats nothing, garbage and an empty list as "no layout", never as "no cards"', () => {
		expect(parseLayout('arbeidsflate', null)).toBeNull();
		expect(parseLayout('arbeidsflate', 'not json')).toBeNull();
		expect(parseLayout('arbeidsflate', '[]')).toBeNull();
		expect(parseLayout('arbeidsflate', JSON.stringify(['nope']))).toBeNull();
	});

	it('reads a form: unchecked is hidden, numbers order, ties keep catalogue order', () => {
		const form = new FormData();
		form.set('vis:timebok', 'ja');
		form.set('rekkefolge:timebok', '3');
		form.set('vis:oppgjor', 'ja');
		form.set('rekkefolge:oppgjor', '1');
		// meldinger unchecked
		expect(layoutFromForm('arbeidsflate', form)).toEqual(['oppgjor', 'timebok']);

		const tie = new FormData();
		for (const id of ['timebok', 'meldinger', 'oppgjor']) {
			tie.set(`vis:${id}`, 'ja');
			tie.set(`rekkefolge:${id}`, '1');
		}
		expect(layoutFromForm('arbeidsflate', tie)).toEqual(['timebok', 'meldinger', 'oppgjor']);
	});

	it('refuses a form that hides everything', () => {
		expect(layoutFromForm('arbeidsflate', new FormData())).toBeNull();
	});
});
