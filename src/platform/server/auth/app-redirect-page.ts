/**
 * The page shown for the moment between the record and an app.
 *
 * The browser keeps a page on screen until the next one starts answering, so this
 * stays up for as long as the app takes. It used to be an ordinary page of the
 * record, with the menu and the whole layout, which looked like the record had
 * opened something of its own, in the app's window or frame. It holds one line,
 * loads nothing, and needs no script: the refresh carries the browser on.
 */

const escapeHtml = (text: string) =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Nothing may load, and it has to render in the frame an embedded app runs in. */
export const APP_REDIRECT_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'";

export function appRedirectPage(target: string): string {
	const href = escapeHtml(new URL(target).href);
	return `<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${href}">
<title>Åpner appen</title>
<style>body{font:1rem system-ui,sans-serif;color:#667;margin:2rem;color-scheme:light dark}</style>
</head>
<body>
<p>Åpner appen … <a href="${href}">Fortsett</a> hvis ingenting skjer.</p>
</body>
</html>
`;
}
