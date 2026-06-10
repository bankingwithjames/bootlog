-- ============================================================================
-- BootLog — Supabase schema migration
-- Run this in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/hycuxnwskexnckedihgt/sql/new
-- Paste the whole file and click "Run".
-- ============================================================================

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id                   bigint generated always as identity primary key,
  username             text    not null,
  name                 text    not null,
  password_hash        text    not null,
  role                 text    not null default 'attendant',
  active               boolean not null default true,
  must_change_password boolean not null default false,
  created_at           text    not null
);

-- Case-insensitive unique username.
create unique index if not exists idx_users_username_lower
  on public.users (lower(username));

-- ---------------------------------------------------------------------------
-- sessions (persistent login tokens — survive restarts/redeploys)
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  token      text   primary key,
  user_id    bigint not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_sessions_user_id on public.sessions (user_id);
create index if not exists idx_sessions_expires_at on public.sessions (expires_at);

-- ---------------------------------------------------------------------------
-- boots
-- ---------------------------------------------------------------------------
create table if not exists public.boots (
  id                  bigint generated always as identity primary key,
  license_plate       text   not null,
  make_model          text   not null,
  booted_at           text   not null,
  boot_fee            real   not null default 0,
  amount_collected    real   not null default 0,
  status              text   not null default 'booted',
  resolved_at         text,
  photos              text   not null default '[]',
  created_by_id       bigint,
  created_by_name     text   not null default '',
  last_action_by_id   bigint,
  last_action_by_name text,
  fee_paid            real   not null default 0
);

create index if not exists idx_boots_booted_at on public.boots (booted_at);

-- ---------------------------------------------------------------------------
-- boot_requests
-- ---------------------------------------------------------------------------
create table if not exists public.boot_requests (
  id                bigint generated always as identity primary key,
  license_plate     text   not null,
  make_model        text   not null,
  suggested_fee     real   not null default 0,
  note              text   not null default '',
  photos            text   not null default '[]',
  status            text   not null default 'pending',
  requested_by_id   bigint,
  requested_by_name text   not null default '',
  requested_at      text   not null,
  resolved_by_id    bigint,
  resolved_by_name  text,
  resolved_at       text,
  boot_id           bigint
);

create index if not exists idx_boot_requests_requested_at
  on public.boot_requests (requested_at);

-- ---------------------------------------------------------------------------
-- paid_snapshots
-- ---------------------------------------------------------------------------
create table if not exists public.paid_snapshots (
  id               bigint generated always as identity primary key,
  day              text not null,
  session_id       text not null,
  license_plate    text not null,
  normalized_plate text not null,
  make_model       text not null,
  color            text not null,
  paid_at          text not null,
  source           text not null default 'stripe'
);

create index if not exists idx_paid_snapshots_day on public.paid_snapshots (day);

-- ---------------------------------------------------------------------------
-- settings (key/value)
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  key   text primary key,
  value text not null
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- The anon key is used SERVER-SIDE ONLY by the Express backend (never shipped
-- to the browser). All authorization is enforced in the Express layer
-- (requireAuth / requireRole). We still enable RLS and grant the anon role
-- access so the server-side anon client can read/write, while the tables stay
-- locked down to anything that isn't this app.
-- ---------------------------------------------------------------------------
alter table public.users          enable row level security;
alter table public.sessions       enable row level security;
alter table public.boots          enable row level security;
alter table public.boot_requests  enable row level security;
alter table public.paid_snapshots enable row level security;
alter table public.settings       enable row level security;

-- Allow the anon role (server-side app) full access. Drop-and-recreate so this
-- script is safe to re-run.
do $$
declare
  t text;
begin
  foreach t in array array['users','sessions','boots','boot_requests','paid_snapshots','settings']
  loop
    execute format('drop policy if exists "app_all_%1$s" on public.%1$s;', t);
    execute format(
      'create policy "app_all_%1$s" on public.%1$s for all to anon using (true) with check (true);',
      t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Table privileges for the anon role (REQUIRED)
-- ---------------------------------------------------------------------------
-- Tables created via raw SQL (not the dashboard table editor) are NOT
-- auto-granted to the anon role, and PostgREST will not expose them to the
-- REST API. RLS policies alone are insufficient — the anon role must also hold
-- table/sequence privileges. Without these grants, every query fails with
-- PGRST205 "Could not find the table in the schema cache" and GET /rest/v1/
-- returns an empty exposed-paths list.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon;
grant select, insert, update, delete on all tables in schema public to anon;
grant usage, select on all sequences in schema public to anon;

-- Apply the same grants automatically to any tables/sequences created later.
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon;
alter default privileges in schema public
  grant usage, select on sequences to anon;

-- ---------------------------------------------------------------------------
-- Reload the PostgREST schema cache so the new tables/grants take effect
-- immediately (otherwise you may wait up to a minute, or need to re-run the
-- standalone reload statement).
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
