create table public.daily_plans (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  plan_date date not null,
  status text not null default 'draft' check (status in ('draft', 'committed', 'completed')),
  workday_start time not null default '09:00',
  workday_end time not null default '17:00',
  planned_minutes integer not null default 0 check (planned_minutes between 0 and 1440),
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, plan_date),
  check (workday_end > workday_start)
);

create trigger daily_plans_set_updated_at
before update on public.daily_plans
for each row execute function public.set_updated_at();

alter table public.daily_plans enable row level security;

create policy "daily_plans_select_own"
on public.daily_plans for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "daily_plans_insert_own"
on public.daily_plans for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "daily_plans_update_own"
on public.daily_plans for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "daily_plans_delete_own"
on public.daily_plans for delete
to authenticated
using ((select auth.uid()) = user_id);

revoke all on public.daily_plans from anon;
grant select, insert, update, delete on public.daily_plans to authenticated;

create or replace function public.commit_day_plan(
  p_plan_date date,
  p_workday_start time,
  p_workday_end time,
  p_items jsonb
)
returns public.daily_plans
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_item_count integer;
  v_unique_count integer;
  v_owned_count integer;
  v_total_minutes integer;
  v_plan public.daily_plans;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if p_workday_end <= p_workday_start then
    raise exception 'Workday end must be after workday start';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Plan items must be an array';
  end if;

  select count(*), coalesce(sum(item.planned_minutes), 0)
  into v_item_count, v_total_minutes
  from jsonb_to_recordset(p_items) as item(task_id uuid, scheduled_at timestamptz, planned_minutes integer, position bigint)
  where item.task_id is not null
    and item.scheduled_at is not null
    and item.planned_minutes between 5 and 480;

  if v_item_count <> jsonb_array_length(p_items) then
    raise exception 'Every plan item requires a valid task, time, and duration';
  end if;

  select count(distinct item.task_id)
  into v_unique_count
  from jsonb_to_recordset(p_items) as item(task_id uuid);

  if v_unique_count <> v_item_count then
    raise exception 'A task can only appear once in a day plan';
  end if;

  select count(*)
  into v_owned_count
  from public.tasks as task
  join jsonb_to_recordset(p_items) as item(task_id uuid, scheduled_at timestamptz, planned_minutes integer, position bigint)
    on item.task_id = task.id
  where task.user_id = v_user_id
    and task.status not in ('done', 'archived');

  if v_owned_count <> v_item_count then
    raise exception 'One or more tasks are unavailable';
  end if;

  insert into public.daily_plans (
    user_id, plan_date, status, workday_start, workday_end, planned_minutes, committed_at
  ) values (
    v_user_id, p_plan_date, 'committed', p_workday_start, p_workday_end, v_total_minutes, now()
  )
  on conflict (user_id, plan_date) do update set
    status = 'committed',
    workday_start = excluded.workday_start,
    workday_end = excluded.workday_end,
    planned_minutes = excluded.planned_minutes,
    committed_at = now()
  returning * into v_plan;

  update public.tasks as task
  set due_date = p_plan_date,
      scheduled_at = item.scheduled_at,
      planned_minutes = item.planned_minutes,
      position = item.position
  from jsonb_to_recordset(p_items) as item(task_id uuid, scheduled_at timestamptz, planned_minutes integer, position bigint)
  where task.id = item.task_id
    and task.user_id = v_user_id;

  return v_plan;
end;
$$;

revoke all on function public.commit_day_plan(date, time, time, jsonb) from public, anon;
grant execute on function public.commit_day_plan(date, time, time, jsonb) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'daily_plans'
  ) then
    alter publication supabase_realtime add table public.daily_plans;
  end if;
end;
$$;
