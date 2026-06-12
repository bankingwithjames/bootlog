-- ============================================================================
-- BootLog — STAGING realistic seed data
-- Target: bootlog-staging (awrxwygjwnhqonyjilnq)
-- Adapted to the ACTUAL schema (license_plate/boot_fee/created_by_name/etc).
-- Safe to re-run: clears the seeded tables first (NOT users).
-- ============================================================================

-- Reset data tables (leave users intact)
truncate table public.enforcement_events restart identity;
truncate table public.paid_snapshots     restart identity;
truncate table public.cash_collections   restart identity;
truncate table public.release_requests   restart identity;
truncate table public.boot_requests      restart identity;
truncate table public.shifts             restart identity;
truncate table public.staff_locations    restart identity;
truncate table public.boots              restart identity;
delete from public.locations;
alter sequence locations_id_seq restart with 1;

-- ---------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------
insert into public.locations (name, address, color, active, latitude, longitude, geofence_radius) values
  ('Deep Ellum Lot A',   '2900 Commerce St, Dallas TX', '#378ADD', true, 32.7842, -96.7838, 150),
  ('Uptown Surface Lot', '3000 McKinney Ave, Dallas TX','#1D9E75', true, 32.7976, -96.8016, 150),
  ('Bishop Arts Garage', '400 W 7th St, Dallas TX',     '#7F77DD', true, 32.7505, -96.8290, 150);

-- ---------------------------------------------------------------------------
-- Boots (across the real status / enforcement_stage lifecycle)
-- ---------------------------------------------------------------------------
insert into public.boots
  (license_plate, make_model, booted_at, boot_fee, amount_collected, status, resolved_at,
   photos, created_by_id, created_by_name, last_action_by_id, last_action_by_name, fee_paid,
   latitude, longitude, color, location_id, enforcement_stage, evidence_labels)
values
  ('SBK7880','Toyota Camry','2026-06-09T22:32:00Z',150,150,'completed','2026-06-09T23:40:00Z',
   '[]',2,'Chop (Enforcer)',1,'Admin',150, 32.7842,-96.7838,'White',1,'completed','[]'),
  ('EIIU21','Kia Sportage','2026-06-09T20:15:00Z',150,150,'completed','2026-06-09T21:05:00Z',
   '[]',2,'Chop (Enforcer)',2,'Chop (Enforcer)',150, 32.7976,-96.8016,'Gray',2,'completed','[]'),
  ('DENALI','GMC Denali','2026-06-09T19:11:00Z',150,0,'released','2026-06-09T19:55:00Z',
   '[]',1,'Admin',1,'Admin',0, 32.7842,-96.7838,'White',1,'released','[]'),
  ('322141','Dodge Durango','2026-06-09T18:38:00Z',150,150,'completed','2026-06-09T20:10:00Z',
   '[]',1,'Admin',2,'Chop (Enforcer)',150, 32.7842,-96.7838,'Black',1,'completed','[]'),
  ('BLACKK','Honda Civic','2026-06-10T10:13:00Z',150,0,'booted',null,
   '[]',2,'Chop (Enforcer)',2,'Chop (Enforcer)',0, 32.7976,-96.8016,'Black',2,'booted','[]'),
  ('TX-9R4K','Ford F-150','2026-06-11T14:02:00Z',150,75,'booted',null,
   '[]',2,'Chop (Enforcer)',2,'Chop (Enforcer)',75, 32.7505,-96.8290,'Blue',3,'payment_pending','[]'),
  ('PARK22','Nissan Altima','2026-06-11T21:48:00Z',150,0,'booted',null,
   '[]',2,'Chop (Enforcer)',2,'Chop (Enforcer)',0, 32.7842,-96.7838,'Silver',1,'release_pending','[]');

-- ---------------------------------------------------------------------------
-- Boot requests (attendant-submitted)
-- ---------------------------------------------------------------------------
insert into public.boot_requests
  (license_plate, make_model, suggested_fee, note, photos, status,
   requested_by_id, requested_by_name, requested_at, resolved_by_id, resolved_by_name,
   resolved_at, boot_id, color)
values
  ('PARK22','Nissan Altima',150,'No permit on dash','[]','approved',
   3,'Mari (Attendant)','2026-06-11T21:40:00Z',2,'Chop (Enforcer)','2026-06-11T21:48:00Z',7,'Silver'),
  ('VIS-771','Chevy Malibu',150,'Parked in reserved spot','[]','pending',
   3,'Mari (Attendant)','2026-06-12T09:05:00Z',null,null,null,null,'Red');

-- ---------------------------------------------------------------------------
-- Release requests (one open)
-- ---------------------------------------------------------------------------
insert into public.release_requests
  (boot_id, license_plate, make_model, note, status, requested_by_id, requested_by_name,
   requested_at, resolved_by_id, resolved_by_name, resolved_at, location_id)
values
  (7,'PARK22','Nissan Altima','Owner disputes — manager review','pending',
   3,'Mari (Attendant)','2026-06-11T22:10:00Z',null,null,null,1);

-- ---------------------------------------------------------------------------
-- Paid snapshots (Stripe + manual)
-- ---------------------------------------------------------------------------
insert into public.paid_snapshots
  (day, session_id, license_plate, normalized_plate, make_model, color, paid_at, source, amount, method, space)
values
  ('2026-06-09','sess_demo_1','SBK7880','SBK7880','Toyota Camry','White','2026-06-09T23:38:00Z','stripe',150,'card','A-12'),
  ('2026-06-09','sess_demo_2','EIIU21','EIIU21','Kia Sportage','Gray','2026-06-09T21:02:00Z','stripe',150,'card','B-07'),
  ('2026-06-09','sess_demo_3','322141','322141','Dodge Durango','Black','2026-06-09T20:05:00Z','manual',150,'cash','A-03'),
  ('2026-06-11','sess_demo_4','TX-9R4K','TX9R4K','Ford F-150','Blue','2026-06-11T16:20:00Z','manual',75,'cash','C-01');

-- ---------------------------------------------------------------------------
-- Cash collections (reconciliation)
-- ---------------------------------------------------------------------------
insert into public.cash_collections
  (day, snapshot_session_id, license_plate, make_model, amount, collected_by_id, collected_by_name,
   collected_at, reconciled, reconciled_at, reconciled_by_name)
values
  ('2026-06-09','sess_demo_3','322141','Dodge Durango',150,2,'Chop (Enforcer)','2026-06-09T20:06:00Z',true,'2026-06-10T08:00:00Z','Admin'),
  ('2026-06-11','sess_demo_4','TX-9R4K','Ford F-150',75,2,'Chop (Enforcer)','2026-06-11T16:21:00Z',false,null,null);

-- ---------------------------------------------------------------------------
-- Enforcement events (audit trail)
-- ---------------------------------------------------------------------------
insert into public.enforcement_events (boot_id, request_id, stage, note, actor_id, actor_name, created_at) values
  (1,null,'booted','Boot placed on white Camry',2,'Chop (Enforcer)','2026-06-09T22:32:00Z'),
  (1,null,'paid','Card payment received',1,'Admin','2026-06-09T23:38:00Z'),
  (1,null,'completed','Boot removed, case closed',1,'Admin','2026-06-09T23:40:00Z'),
  (6,null,'payment_pending','Partial payment $75 collected',2,'Chop (Enforcer)','2026-06-11T16:21:00Z'),
  (7,1,'release_pending','Release requested by attendant',3,'Mari (Attendant)','2026-06-11T22:10:00Z');

-- ---------------------------------------------------------------------------
-- Shifts (one active check-in for the enforcer)
-- ---------------------------------------------------------------------------
insert into public.shifts
  (user_id, user_name, location_id, location_name, check_in_at, check_out_at,
   check_in_lat, check_in_lng, check_out_lat, check_out_lng, geofence_verified)
values
  (2,'Chop (Enforcer)',1,'Deep Ellum Lot A','2026-06-12T08:00:00Z',null,32.7842,-96.7838,null,null,true);

-- ---------------------------------------------------------------------------
-- Staff location assignments
-- ---------------------------------------------------------------------------
insert into public.staff_locations (user_id, location_id) values
  (2,1),
  (3,2);

-- ---------------------------------------------------------------------------
-- Org settings (key/value — column-visibility flags)
-- ---------------------------------------------------------------------------
insert into public.settings (key, value) values
  ('show_booted_to_staff','true'),
  ('show_paid_to_staff','true'),
  ('show_enforcement_to_staff','true'),
  ('show_fees_to_staff','true')
on conflict (key) do update set value = excluded.value;

notify pgrst, 'reload schema';
