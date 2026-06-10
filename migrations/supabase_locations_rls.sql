-- Multi-location support: RLS policies for new tables.
-- The app connects to Supabase with the anon key; all access control is
-- enforced in the Express/storage layer, not in Postgres. Existing tables
-- (e.g. boots) already use a permissive "app_all_*" anon policy. The new
-- locations and staff_locations tables had RLS enabled but NO policies,
-- which silently denied every insert/select for the anon role. These
-- policies mirror the existing pattern so the app layer remains the
-- single source of truth for authorization.

CREATE POLICY app_all_locations ON public.locations
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY app_all_staff_locations ON public.staff_locations
  FOR ALL TO anon USING (true) WITH CHECK (true);
