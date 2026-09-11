/**
 * Which dropdown is open, for the whole page.
 *
 * One value rather than a flag per menu, because the rule is about all of them
 * at once: opening one has to close the others. With a boolean each, pressing a
 * second menu left the first standing and the two panels overlapped.
 */
export const apenMeny = $state<{ id: symbol | null }>({ id: null });
