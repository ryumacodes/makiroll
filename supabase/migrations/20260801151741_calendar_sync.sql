create table public.calendar_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  google_email text,
  access_token_ciphertext text,
  refresh_token_ciphertext text not null,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz,
  next_sync_at timestamptz not null default now(),
  last_error text,
  updated_at timestamptz not null default now()
);

create table public.calendar_sync_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  calendar_id text not null,
  sync_token text,
  updated_at timestamptz not null default now(),
  primary key (user_id, calendar_id)
);

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  calendar_id text not null,
  external_id text not null,
  title text not null default '(Untitled event)',
  description text not null default '',
  location text not null default '',
  starts_at timestamptz,
  ends_at timestamptz,
  all_day boolean not null default false,
  status text not null default 'confirmed',
  html_link text,
  meeting_url text,
  etag text,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, calendar_id, external_id)
);

create index calendar_events_user_start_idx
  on public.calendar_events(user_id, starts_at)
  where status <> 'cancelled';

create index calendar_connections_due_idx
  on public.calendar_connections(next_sync_at)
  where last_error is null;

create trigger calendar_connections_set_updated_at
before update on public.calendar_connections
for each row execute function public.set_updated_at();

create trigger calendar_sync_state_set_updated_at
before update on public.calendar_sync_state
for each row execute function public.set_updated_at();

create trigger calendar_events_set_updated_at
before update on public.calendar_events
for each row execute function public.set_updated_at();

alter table public.calendar_connections enable row level security;
alter table public.calendar_sync_state enable row level security;
alter table public.calendar_events enable row level security;

-- OAuth credentials and sync cursors are intentionally server-only. The Edge
-- Function uses the service role; browser roles cannot read either table.
revoke all on public.calendar_connections, public.calendar_sync_state from anon, authenticated;

create policy "calendar_events_select_own"
on public.calendar_events for select
to authenticated
using ((select auth.uid()) = user_id);

revoke all on public.calendar_events from anon;
grant select on public.calendar_events to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'calendar_events'
  ) then
    alter publication supabase_realtime add table public.calendar_events;
  end if;
end;
$$;
