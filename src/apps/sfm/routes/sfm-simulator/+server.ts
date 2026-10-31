import { error } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import type { RequestHandler } from '$routetypes/sfm-simulator/$types';
import { config } from '$srv/config';

/**
 * Stands in for SFM's patient portal when the record runs without NHN.
 *
 * It speaks the same messages as the real one, so the whole path from the
 * Legemidler tab to an opened patient can be run and tested. It has no medicines
 * in it and says plainly what it is. It only exists in `mock` mode with SFM on.
 *
 * Plain HTML rather than a page in the application, which would bring the
 * record's menus into the frame.
 */
export const GET: RequestHandler = () => {
	if (config.integrations.mode !== 'mock' || !config.integrations.sfm.full) error(404, 'Ikke tilgjengelig');

	const nonce = randomBytes(16).toString('base64');
	const html = `<!doctype html>
<html lang="nb">
<head><meta charset="utf-8"><title>SFM-simulator</title>
<style>body{font-family:system-ui,sans-serif;margin:1.5rem}</style></head>
<body>
<h1>SFM-simulator</h1>
<p>Dette er ikke Sentral forskrivningsmodul. Her er det ingen legemidler, og ingenting sendes til e-resept.</p>
<p id="status">Venter på innlogging …</p>
<script nonce="${nonce}">
(function () {
	var signedIn = false;
	var status = document.getElementById('status');
	function reply(message) { window.parent.postMessage(message, location.origin); }
	window.addEventListener('message', function (event) {
		if (event.source !== window.parent || event.origin !== location.origin) return;
		var data = event.data || {};
		if (data.action === 'login') {
			signedIn = Boolean(data.code && data.nonce && data.apiEndpoint);
			status.textContent = signedIn ? 'Innlogget. Venter på pasient …' : 'Innlogging avvist.';
			reply({ login: signedIn ? 'success' : 'failed' });
		} else if (data.action === 'setPatient') {
			var opened = signedIn && Boolean(data.ticket);
			status.textContent = opened ? 'Pasient åpnet med billett.' : 'Pasienten kunne ikke åpnes.';
			reply({ setPatient: opened ? 'success' : 'failed' });
		}
	});
	reply({ clientLoaded: 'success' });
})();
</script>
</body>
</html>`;
	return new Response(html, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'self'`,
			'cache-control': 'no-store'
		}
	});
};
