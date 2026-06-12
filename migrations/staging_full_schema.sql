-- ============================================================================
-- BootLog — STAGING schema (mirrors production hycuxnwskexnckedihgt)
-- Target: bootlog-staging (awrxwygjwnhqonyjilnq)
-- Schema only — NO production data is copied.
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
create unique index if not exists idx_users_username_lower on public.users (lower(username));

-- ---------------------------------------------------------------------------
-- sessions
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
  fee_paid            real   not null default 0,
  latitude            double precision,
  longitude           double precision,
  color               text,
  location_id         integer,
  enforcement_stage   text,
  evidence_labels     text   default '[]'
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
  boot_id           bigint,
  color             text
);
create index if not exists idx_boot_requests_requested_at on public.boot_requests (requested_at);

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
  source           text not null default 'stripe',
  amount           numeric,
  method           text,
  space            text,
  constraint paid_snapshots_method_check
    check (method is null or (method = any (array['cash'::text, 'card'::text, 'app'::text])))
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
-- locations
-- ---------------------------------------------------------------------------
create table if not exists public.locations (
  id              integer generated by default as identity primary key,
  name            text not null,
  address         text not null default '',
  color           text not null default '#378ADD',
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  latitude        double precision,
  longitude       double precision,
  geofence_radius double precision not null default 150
);

-- ---------------------------------------------------------------------------
-- staff_locations
-- ---------------------------------------------------------------------------
create table if not exists public.staff_locations (
  id          integer generated by default as identity primary key,
  user_id     integer not null,
  location_id integer not null
);

-- ---------------------------------------------------------------------------
-- shifts
-- ---------------------------------------------------------------------------
create table if not exists public.shifts (
  id                bigint generated always as identity primary key,
  user_id           bigint not null,
  user_name         text not null default '',
  location_id       bigint not null,
  location_name     text not null default '',
  check_in_at       timestamptz not null,
  check_out_at      timestamptz,
  check_in_lat      double precision,
  check_in_lng      double precision,
  check_out_lat     double precision,
  check_out_lng     double precision,
  geofence_verified boolean not null default false
);

-- ---------------------------------------------------------------------------
-- release_requests
-- ---------------------------------------------------------------------------
create table if not exists public.release_requests (
  id                integer generated always as identity primary key,
  boot_id           integer not null,
  license_plate     text not null,
  make_model        text not null,
  note              text not null default '',
  status            text not null default 'pending',
  requested_by_id   integer,
  requested_by_name text not null default '',
  requested_at      text not null,
  resolved_by_id    integer,
  resolved_by_name  text,
  resolved_at       text,
  location_id       integer
);

-- ---------------------------------------------------------------------------
-- cash_collections  (NOTE: RLS disabled in production — mirrored here)
-- ---------------------------------------------------------------------------
create table if not exists public.cash_collections (
  id                  bigint generated always as identity primary key,
  day                 text not null,
  snapshot_session_id text,
  license_plate       text not null,
  make_model          text not null default '',
  amount              real not null default 0,
  collected_by_id     bigint not null,
  collected_by_name   text not null default '',
  collected_at        text not null,
  reconciled          boolean not null default false,
  reconciled_at       text,
  reconciled_by_name  text,
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- enforcement_events
-- ---------------------------------------------------------------------------
create table if not exists public.enforcement_events (
  id         bigint generated by default as identity primary key,
  boot_id    bigint,
  request_id bigint,
  stage      text not null,
  note       text,
  actor_id   bigint,
  actor_name text,
  created_at text not null
);

-- ---------------------------------------------------------------------------
-- Row Level Security — enable on all tables EXCEPT cash_collections
-- (matches production; cash_collections has RLS disabled there).
-- The anon role is used SERVER-SIDE ONLY by the Express backend.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'users','sessions','boots','boot_requests','paid_snapshots','settings',
    'locations','staff_locations','shifts','release_requests','enforcement_events'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "app_all_%1$s" on public.%1$s;', t);
    execute format(
      'create policy "app_all_%1$s" on public.%1$s for all to anon using (true) with check (true);',
      t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants for the anon role (REQUIRED for PostgREST to expose tables)
-- ---------------------------------------------------------------------------
grant usage on schema public to anon;
grant select, insert, update, delete on all tables in schema public to anon;
grant usage, select on all sequences in schema public to anon;
alter default privileges in schema public grant select, insert, update, delete on tables to anon;
alter default privileges in schema public grant usage, select on sequences to anon;

-- Reload PostgREST schema cache.
notify pgrst, 'reload schema';
