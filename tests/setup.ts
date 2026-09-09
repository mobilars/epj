/** Felles oppsett for testene. Kjøres før hver testfil. */
process.env.EPJ_DATA_KEY ??= 'testnokkel-for-enhetstester-000000000000';
process.env.EPJ_BASE_URL ??= 'http://localhost:5173';
process.env.EPJ_ORG_HER_ID ??= '8000001';
process.env.EPJ_ORG_ORGNR ??= '994598759';
process.env.EPJ_INTEGRASJON_MODUS ??= 'mock';
