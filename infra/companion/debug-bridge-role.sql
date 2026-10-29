-- Optional sidecar only. Apply to the Eros database as its administrator:
-- psql "$EROS_DATABASE_URL" --set=debug_password="$DEBUG_DATABASE_PASSWORD" \
--   --file=infra/companion/debug-bridge-role.sql
-- Passwords are supplied at runtime, never stored in this file. The bridge
-- cannot read message text, BYOC keys, evaluation prompts, or unrelated tables.
\set ON_ERROR_STOP on
\if :{?debug_password}
\else
  \echo 'debug_password must be supplied'
  \quit 1
\endif

BEGIN;
DO $$ BEGIN
  CREATE ROLE rakazo_eros_debug;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER ROLE rakazo_eros_debug LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'debug_password';
GRANT CONNECT ON DATABASE :"DBNAME" TO rakazo_eros_debug;
REVOKE ALL ON SCHEMA engine FROM rakazo_eros_debug;
GRANT USAGE ON SCHEMA engine TO rakazo_eros_debug;
REVOKE ALL ON ALL TABLES IN SCHEMA engine FROM rakazo_eros_debug;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA engine FROM rakazo_eros_debug;

GRANT SELECT (id,user_id,instance_id,archived,channel) ON engine.chat_sessions TO rakazo_eros_debug;
GRANT SELECT (id,genome_id,owner_uid,status) ON engine.persona_instances TO rakazo_eros_debug;
GRANT SELECT (id,name,system_prompt,tip_personality,art_metadata) ON engine.persona_genomes TO rakazo_eros_debug;
GRANT SELECT ON engine.companion_affinity TO rakazo_eros_debug;
GRANT UPDATE (trust,intrigue,intimacy,tension,warmth_grade,patience_grade,
  feeling_clause,feeling_clause_at,updated_at) ON engine.companion_affinity TO rakazo_eros_debug;
GRANT SELECT (session_id,user_id,user_message_id,status) ON engine.chat_turn_queue TO rakazo_eros_debug;
GRANT SELECT (id,session_id,user_message_id,role,channel,sent_at) ON engine.chat_messages TO rakazo_eros_debug;
GRANT SELECT (affinity_id,user_message_id) ON engine.companion_affinity_events TO rakazo_eros_debug;

-- Every request opens a transaction and binds these four values with set_config
-- before reading. Missing settings expose no rows. This role cannot disable RLS.
DROP POLICY IF EXISTS rakazo_debug_session ON engine.chat_sessions;
CREATE POLICY rakazo_debug_session ON engine.chat_sessions FOR SELECT TO rakazo_eros_debug USING (
  id::text=current_setting('rakazo_debug.session_id',true)
  AND user_id::text=current_setting('rakazo_debug.user_id',true)
  AND instance_id::text=current_setting('rakazo_debug.instance_id',true)
  AND NOT archived AND channel='text'
);
DROP POLICY IF EXISTS rakazo_debug_instance ON engine.persona_instances;
CREATE POLICY rakazo_debug_instance ON engine.persona_instances FOR SELECT TO rakazo_eros_debug USING (
  id::text=current_setting('rakazo_debug.instance_id',true)
  AND owner_uid::text=current_setting('rakazo_debug.user_id',true)
  AND genome_id::text=current_setting('rakazo_debug.genome_id',true) AND status='active'
);
DROP POLICY IF EXISTS rakazo_debug_genome ON engine.persona_genomes;
CREATE POLICY rakazo_debug_genome ON engine.persona_genomes FOR SELECT TO rakazo_eros_debug USING (
  id::text=current_setting('rakazo_debug.genome_id',true)
  AND EXISTS (SELECT 1 FROM engine.persona_instances i WHERE i.genome_id=persona_genomes.id)
);
DROP POLICY IF EXISTS rakazo_debug_affinity_read ON engine.companion_affinity;
CREATE POLICY rakazo_debug_affinity_read ON engine.companion_affinity FOR SELECT TO rakazo_eros_debug USING (
  session_id::text=current_setting('rakazo_debug.session_id',true)
  AND user_id::text=current_setting('rakazo_debug.user_id',true)
  AND instance_id::text=current_setting('rakazo_debug.instance_id',true)
);
DROP POLICY IF EXISTS rakazo_debug_affinity_write ON engine.companion_affinity;
CREATE POLICY rakazo_debug_affinity_write ON engine.companion_affinity FOR UPDATE TO rakazo_eros_debug USING (
  session_id::text=current_setting('rakazo_debug.session_id',true)
  AND user_id::text=current_setting('rakazo_debug.user_id',true)
  AND instance_id::text=current_setting('rakazo_debug.instance_id',true)
  AND EXISTS (SELECT 1 FROM engine.chat_sessions s JOIN engine.persona_instances i ON i.id=s.instance_id
    WHERE s.id=companion_affinity.session_id)
) WITH CHECK (
  session_id::text=current_setting('rakazo_debug.session_id',true)
  AND user_id::text=current_setting('rakazo_debug.user_id',true)
  AND instance_id::text=current_setting('rakazo_debug.instance_id',true)
);
DROP POLICY IF EXISTS rakazo_debug_queue ON engine.chat_turn_queue;
CREATE POLICY rakazo_debug_queue ON engine.chat_turn_queue FOR SELECT TO rakazo_eros_debug USING (
  session_id::text=current_setting('rakazo_debug.session_id',true)
  AND user_id::text=current_setting('rakazo_debug.user_id',true)
);
DROP POLICY IF EXISTS rakazo_debug_message ON engine.chat_messages;
CREATE POLICY rakazo_debug_message ON engine.chat_messages FOR SELECT TO rakazo_eros_debug USING (
  session_id::text=current_setting('rakazo_debug.session_id',true)
);
DROP POLICY IF EXISTS rakazo_debug_affinity_event ON engine.companion_affinity_events;
CREATE POLICY rakazo_debug_affinity_event ON engine.companion_affinity_events FOR SELECT TO rakazo_eros_debug USING (
  EXISTS (SELECT 1 FROM engine.companion_affinity a WHERE a.id=companion_affinity_events.affinity_id)
);
COMMIT;
