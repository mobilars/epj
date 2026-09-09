import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * SMART styling. Apper som støtter «context-style» henter denne og tilpasser
 * seg journalens utseende, slik at de ikke føles som et fremmedelement midt i
 * en konsultasjon.
 */
export const GET: RequestHandler = () =>
	json(
		{
			color_background: '#f6f7f9',
			color_error: '#a4262c',
			color_highlight: '#e3edf5',
			color_modal_backdrop: 'rgba(20, 24, 29, 0.5)',
			color_success: '#14682f',
			color_text: '#14181d',
			dim_border_radius: '6px',
			dim_font_size: '15px',
			dim_spacing_size: '8px',
			font_family_body: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
			font_family_heading: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif"
		},
		{ headers: { 'cache-control': 'public, max-age=3600' } }
	);
