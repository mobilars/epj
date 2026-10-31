import type { Component } from 'svelte';
import BillingCard from './billing/components/BillingCard.svelte';
import MessagesCard from './messages/components/MessagesCard.svelte';
import QuickNote from './notes/components/QuickNote.svelte';

/**
 * Components apps place in spaces the platform draws. Apart from `registry.ts`, so
 * that reading the manifests does not pull in any components.
 */

// Each card takes what its own loader in `registry.server.ts` returned.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const workspaceCards: Record<string, Component<{ data: any }>> = {
	meldinger: MessagesCard,
	oppgjor: BillingCard
};

/** What the record's side panel holds when no external app has been put there. */
export const patientSidePanel: Component<{ patientId: string }> | null = QuickNote;
