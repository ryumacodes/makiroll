-- RLS is the authorization boundary. FORCE keeps it active even for table
-- owners; service_role remains the only bypass used by trusted Edge Functions.
alter table public.projects force row level security;
alter table public.tasks force row level security;
alter table public.saved_filters force row level security;
alter table public.daily_plans force row level security;
alter table public.calendar_events force row level security;
alter table public.calendar_connections force row level security;
alter table public.calendar_sync_state force row level security;

-- Remove broad auto-exposure grants such as TRUNCATE, REFERENCES, and TRIGGER.
-- RLS does not apply to TRUNCATE, so least-privilege table grants matter too.
revoke all on table
  public.projects,
  public.tasks,
  public.saved_filters,
  public.daily_plans,
  public.calendar_events,
  public.calendar_connections,
  public.calendar_sync_state
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.projects,
  public.tasks,
  public.saved_filters,
  public.daily_plans
to authenticated;

-- Google events are an imported projection. Browser clients can read only
-- their own rows; all mutations stay in the trusted sync worker.
grant select on table public.calendar_events to authenticated;

-- OAuth tokens and incremental sync cursors are server-only.
revoke all on table public.calendar_connections, public.calendar_sync_state
from public, anon, authenticated;

-- RPCs are deny-by-default and individually exposed below.
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.search_tasks(text) to authenticated;
grant execute on function public.commit_day_plan(date, time, time, jsonb) to authenticated;

-- Future public objects start private and require an explicit migration grant.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
