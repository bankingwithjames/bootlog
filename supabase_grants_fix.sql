-- ============================================================================
-- BootLog — Supabase GRANTS FIX
-- ----------------------------------------------------------------------------
-- Your tables already exist, but they were created via raw SQL so the `anon`
-- role was never granted access to them. PostgREST therefore refuses to expose
-- them to the REST API (every query returns PGRST205 "Could not find the table
-- in the schema cache"). RLS policies alone are NOT enough — the anon role
-- also needs table/sequence privileges.
--
-- Run this whole file in the Supabase SQL Editor and click "Run":
--   https://supabase.com/dashboard/project/hycuxnwskexnckedihgt/sql/new
-- ============================================================================

-- Grant the server-side anon role access to the existing tables.
grant usage on schema public to anon;
grant select, insert, update, delete on all tables in schema public to anon;
grant usage, select on all sequences in schema public to anon;

-- Apply the same grants automatically to any tables/sequences created later.
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon;
alter default privileges in schema public
  grant usage, select on sequences to anon;

-- Reload PostgREST's schema cache so the change takes effect immediately.
notify pgrst, 'reload schema';
