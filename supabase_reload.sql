-- Tell Supabase's API layer (PostgREST) to refresh its table cache so the
-- new BootLog tables become visible to the app. Run this in the SQL Editor:
--   https://supabase.com/dashboard/project/hycuxnwskexnckedihgt/sql/new
notify pgrst, 'reload schema';
