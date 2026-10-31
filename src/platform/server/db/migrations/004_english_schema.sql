-- ---------------------------------------------------------------------------
-- English schema names.
--
-- Migrations 001-003 were rewritten in place when the code was translated, so
-- a database created before that still carries the Norwegian names while the
-- code now asks for the English ones. This migration closes that gap.
--
-- Every rename is guarded: on a database built from the rewritten 001-003 the
-- English name is already there and each statement is a no-op. So it is safe
-- to run against both, and there is no need to recreate anything.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Tables -------------------------------------------------------------
  FOR r IN SELECT * FROM (VALUES
    ('journal_sperring', 'record_restriction'),
    ('melding', 'message'),
    ('sfm_synk', 'sfm_sync'),
    ('regningskort', 'billing_card'),
    ('regningslinje', 'billing_line'),
    ('oppgjor', 'settlement'),
    ('egenandel_oppslag', 'copayment_lookup')
  ) AS t(old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'epj' AND table_name = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                       WHERE table_schema = 'epj' AND table_name = r.new_name) THEN
      EXECUTE format('ALTER TABLE epj.%I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;

  -- Columns ------------------------------------------------------------
  FOR r IN SELECT * FROM (VALUES
    ('schema_migration', 'versjon', 'version'),
    ('schema_migration', 'navn', 'name'),
    ('schema_migration', 'anvendt', 'applied_at'),
    ('audit_event', 'actor_navn', 'actor_name'),
    ('audit_event', 'actor_rolle', 'actor_role'),
    ('user_account', 'brukernavn', 'username'),
    ('user_account', 'navn', 'name'),
    ('user_account', 'epost', 'email'),
    ('user_account', 'hpr_nummer', 'hpr_number'),
    ('user_account', 'passord_hash', 'password_hash'),
    ('user_account', 'ma_bytte_passord', 'must_change_password'),
    ('user_account', 'feilede_forsok', 'failed_attempts'),
    ('user_account', 'laast_til', 'locked_until'),
    ('user_account', 'siste_innlogging', 'last_login'),
    ('user_account', 'opprettet', 'created_at'),
    ('user_account', 'oppdatert', 'updated_at'),
    ('role_assignment', 'rolle', 'role'),
    ('role_assignment', 'gyldig_fra', 'valid_from'),
    ('role_assignment', 'gyldig_til', 'valid_until'),
    ('role_assignment', 'tildelt_av', 'assigned_by'),
    ('role_assignment', 'begrunnelse', 'justification'),
    ('care_relationship', 'grunnlag', 'basis'),
    ('care_relationship', 'gyldig_fra', 'valid_from'),
    ('care_relationship', 'gyldig_til', 'valid_until'),
    ('care_relationship', 'opprettet_av', 'created_by'),
    ('break_glass', 'begrunnelse', 'justification'),
    ('break_glass', 'startet', 'started_at'),
    ('break_glass', 'utloper', 'expires_at'),
    ('break_glass', 'varslet', 'notified'),
    ('break_glass', 'gjennomgatt_av', 'reviewed_by'),
    ('break_glass', 'gjennomgatt_tid', 'reviewed_at'),
    ('record_restriction', 'omfang', 'scope_extent'),
    ('record_restriction', 'mal_user_id', 'target_user_id'),
    ('record_restriction', 'mal_rolle', 'target_role'),
    ('record_restriction', 'mal_ressurs', 'target_resource'),
    ('record_restriction', 'begrunnelse', 'justification'),
    ('record_restriction', 'registrert', 'registered_at'),
    ('record_restriction', 'registrert_av', 'registered_by'),
    ('record_restriction', 'gyldig_til', 'valid_until'),
    ('record_restriction', 'opphevet', 'lifted'),
    ('oauth_client', 'navn', 'name'),
    ('oauth_client', 'klient_kategori', 'client_category'),
    ('oauth_client', 'tillatte_scopes', 'allowed_scopes'),
    ('oauth_client', 'krev_pkce', 'require_pkce'),
    ('oauth_client', 'krev_samtykke', 'require_consent'),
    ('oauth_client', 'opprettet', 'created_at'),
    ('oauth_client', 'opprettet_av', 'created_by'),
    ('oauth_authorization_code', 'utloper', 'expires_at'),
    ('oauth_authorization_code', 'brukt', 'used'),
    ('oauth_token', 'utstedt', 'issued_at'),
    ('oauth_token', 'utloper', 'expires_at'),
    ('oauth_token', 'tilbakekalt', 'revoked'),
    ('oauth_token', 'tilbakekalt_grunn', 'revoked_reason'),
    ('smart_launch', 'opprettet', 'created_at'),
    ('smart_launch', 'utloper', 'expires_at'),
    ('smart_launch', 'brukt', 'used'),
    ('signing_key', 'opprettet', 'created_at'),
    ('signing_key', 'aktiv', 'active'),
    ('signing_key', 'utfases_etter', 'phased_out_after'),
    ('user_session', 'opprettet', 'created_at'),
    ('user_session', 'sist_aktiv', 'last_active'),
    ('user_session', 'utloper', 'expires_at'),
    ('user_session', 'elevert_til', 'elevated_until'),
    ('user_session', 'avsluttet', 'ended'),
    ('rate_limit', 'teller', 'counter'),
    ('rate_limit', 'vindu_start', 'window_start'),
    ('message', 'retning', 'direction'),
    ('message', 'meldingstype', 'message_type'),
    ('message', 'avsender_her', 'sender_her_id'),
    ('message', 'mottaker_her', 'recipient_her_id'),
    ('message', 'mottaker_navn', 'recipient_name'),
    ('message', 'status_detalj', 'status_detail'),
    ('message', 'forsok', 'attempts'),
    ('message', 'neste_forsok', 'next_attempt'),
    ('message', 'opprettet', 'created_at'),
    ('message', 'oppdatert', 'updated_at'),
    ('message', 'opprettet_av', 'created_by'),
    ('sfm_sync', 'operasjon', 'operation'),
    ('sfm_sync', 'foresporsel', 'request'),
    ('sfm_sync', 'svar', 'response'),
    ('sfm_sync', 'opprettet', 'created_at'),
    ('sfm_sync', 'oppdatert', 'updated_at'),
    ('sfm_sync', 'utfort_av', 'performed_by'),
    ('billing_card', 'behandler_id', 'practitioner_id'),
    ('billing_card', 'hpr_nummer', 'hpr_number'),
    ('billing_card', 'dato', 'date'),
    ('billing_card', 'diagnose_kode', 'diagnosis_code'),
    ('billing_card', 'diagnose_system', 'diagnosis_system'),
    ('billing_card', 'refusjon_ore', 'reimbursement_ore'),
    ('billing_card', 'egenandel_ore', 'copayment_ore'),
    ('billing_card', 'frikort', 'exemption_card'),
    ('billing_card', 'fritak_grunn', 'exemption_reason'),
    ('billing_card', 'oppgjor_id', 'settlement_id'),
    ('billing_card', 'avvisning', 'rejection'),
    ('billing_card', 'opprettet', 'created_at'),
    ('billing_card', 'oppdatert', 'updated_at'),
    ('billing_line', 'regningskort_id', 'billing_card_id'),
    ('billing_line', 'takstkode', 'tariff_code'),
    ('billing_line', 'antall', 'count'),
    ('billing_line', 'refusjon_ore', 'reimbursement_ore'),
    ('billing_line', 'egenandel_ore', 'copayment_ore'),
    ('billing_line', 'merknad', 'note'),
    ('settlement', 'periode_fra', 'period_from'),
    ('settlement', 'periode_til', 'period_to'),
    ('settlement', 'antall_kort', 'card_count'),
    ('settlement', 'sum_refusjon_ore', 'sum_reimbursement_ore'),
    ('settlement', 'sum_egenandel_ore', 'sum_copayment_ore'),
    ('settlement', 'kvittering', 'receipt'),
    ('settlement', 'fil', 'file'),
    ('settlement', 'opprettet', 'created_at'),
    ('settlement', 'sendt', 'sent_at'),
    ('settlement', 'sendt_av', 'sent_by'),
    ('copayment_lookup', 'utfort_av', 'performed_by'),
    ('copayment_lookup', 'har_frikort', 'has_exemption_card'),
    ('copayment_lookup', 'frikort_til', 'exemption_card_until'),
    ('copayment_lookup', 'opptjent_ore', 'earned_ore'),
    ('copayment_lookup', 'kilde', 'source'),
    ('tenant', 'navn', 'name'),
    ('tenant', 'organisasjonsnummer', 'organisation_number'),
    ('tenant', 'kommunenummer', 'municipality_code'),
    ('tenant', 'vertsnavn', 'hostname'),
    ('tenant', 'partisjon_id', 'partition_id'),
    ('tenant', 'merknad', 'note'),
    ('tenant', 'opprettet', 'created_at'),
    ('tenant', 'opprettet_av', 'created_by'),
    ('tenant', 'oppdatert', 'updated_at')
  ) AS c(tbl, old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'epj' AND table_name = r.tbl AND column_name = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'epj' AND table_name = r.tbl AND column_name = r.new_name) THEN
      EXECUTE format('ALTER TABLE epj.%I RENAME COLUMN %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;

  -- Indexes ------------------------------------------------------------
  FOR r IN SELECT * FROM (VALUES
    ('idx_bg_aktiv', 'idx_bg_active'),
    ('idx_sperring_patient', 'idx_restriction_patient'),
    ('idx_authcode_utloper', 'idx_authcode_expires_at'),
    ('idx_melding_msgid', 'idx_message_msgid'),
    ('idx_melding_ko', 'idx_message_queue'),
    ('idx_melding_pasient', 'idx_message_patient'),
    ('idx_sfm_pasient', 'idx_sfm_patient'),
    ('idx_regningskort_status', 'idx_billing_card_status'),
    ('idx_regningskort_pasient', 'idx_billing_card_patient'),
    ('idx_regningslinje_kort', 'idx_billing_line_card'),
    ('idx_egenandel_pasient', 'idx_copayment_patient'),
    ('idx_tenant_vertsnavn', 'idx_tenant_hostname'),
    ('idx_user_brukernavn_tenant', 'idx_user_username_tenant'),
    ('idx_melding_msgid', 'idx_message_msgid')
  ) AS i(old_name, new_name) LOOP
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'epj' AND indexname = r.old_name)
       AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'epj' AND indexname = r.new_name) THEN
      EXECUTE format('ALTER INDEX epj.%I RENAME TO %I', r.old_name, r.new_name);
    END IF;
  END LOOP;

  -- The unique constraint on user_account.brukernavn was named after the old
  -- column. 003 drops it by name; on an older database that drop missed, which
  -- kept the same username from existing in two tenants.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_account_brukernavn_key') THEN
    ALTER TABLE epj.user_account DROP CONSTRAINT user_account_brukernavn_key;
  END IF;
END $$;
