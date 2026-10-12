-- Set up your venue (O-02; spec 17 · How it behaves). Each step's state is
-- worked out from the rows the step saves to, never from a copy; the two
-- things the wizard keeps of its own are below. A step the owner skipped
-- ("Skip for now") stays skipped until its rows make it done, on any device;
-- Finish setup stamps venues.setup_completed_at.
set lock_timeout = '5s';

alter table venues add column setup_completed_at timestamptz;
grant update (setup_completed_at) on venues to app_rw;

create table venue_setup_skips (
  venue_id    uuid not null references venues (id),
  step        text not null check (step in ('venue', 'plan', 'card', 'rooms', 'hours', 'deposits',
                                            'money', 'menu', 'team', 'licenses', 'texts', 'devices')),
  skipped_by  uuid not null references users (id),
  skipped_at  timestamptz not null default now(),
  primary key (venue_id, step)
);
alter table venue_setup_skips enable row level security;
alter table venue_setup_skips force row level security;
create policy venue_isolation on venue_setup_skips to app_rw
  using (venue_id = app_venue_id())
  with check (venue_id = app_venue_id());
grant select, insert on venue_setup_skips to app_rw;
select audit_table('venue_setup_skips');
