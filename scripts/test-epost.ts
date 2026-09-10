/** Sends one message, to check that the mail configuration works. */
import { sendEmail } from '../src/lib/server/util/smtp';

const to = process.argv[2];
if (!to) throw new Error('Bruk: npm run test:epost -- <adresse>');

await sendEmail({
	to,
	subject: 'Test fra EPJ',
	text: 'Dette er en test av utsending fra journalens utviklerportal.\n\nHilsen EPJ'
});
console.log(`Sendt til ${to}`);
