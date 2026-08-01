create extension if not exists pgcrypto with schema extensions;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  color text not null default 'coral' check (color in ('coral', 'sage', 'blue', 'violet', 'amber', 'slate')),
  position bigint not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, name)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid,
  title text not null check (char_length(title) between 1 and 500),
  notes text not null default '',
  status text not null default 'todo' check (status in ('todo', 'progress', 'done', 'archived')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  due_date date,
  scheduled_at timestamptz,
  planned_minutes integer not null default 30 check (planned_minutes between 0 and 10080),
  position bigint not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(notes, '')), 'B')
  ) stored,
  constraint tasks_project_owner_fk
    foreign key (user_id, project_id)
    references public.projects(user_id, id)
    on delete set null (project_id)
);

create table public.saved_filters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  definition jsonb not null default '{}'::jsonb check (jsonb_typeof(definition) = 'object'),
  position bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create index projects_user_position_idx on public.projects(user_id, position) where archived_at is null;
create index tasks_user_due_idx on public.tasks(user_id, due_date) where status <> 'archived';
create index tasks_user_project_position_idx on public.tasks(user_id, project_id, position) where status <> 'archived';
create index tasks_user_status_idx on public.tasks(user_id, status);
create index tasks_search_vector_idx on public.tasks using gin(search_vector);
create index saved_filters_user_position_idx on public.saved_filters(user_id, position);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

create trigger tasks_set_updated_at
before update on public.tasks
for each row execute function public.set_updated_at();

create trigger saved_filters_set_updated_at
before update on public.saved_filters
for each row execute function public.set_updated_at();

alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.saved_filters enable row level security;

create policy "projects_select_own"
on public.projects for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "projects_insert_own"
on public.projects for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "projects_update_own"
on public.projects for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "projects_delete_own"
on public.projects for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy "tasks_select_own"
on public.tasks for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "tasks_insert_own"
on public.tasks for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "tasks_update_own"
on public.tasks for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "tasks_delete_own"
on public.tasks for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy "saved_filters_select_own"
on public.saved_filters for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "saved_filters_insert_own"
on public.saved_filters for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "saved_filters_update_own"
on public.saved_filters for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "saved_filters_delete_own"
on public.saved_filters for delete
to authenticated
using ((select auth.uid()) = user_id);

revoke all on public.projects, public.tasks, public.saved_filters from anon;
grant select, insert, update, delete on public.projects, public.tasks, public.saved_filters to authenticated;

revoke all on function public.set_updated_at() from public, anon, authenticated;

create or replace function public.search_tasks(search_text text)
returns setof public.tasks
language sql
stable
security invoker
set search_path = ''
as $$
  select task.*
  from public.tasks as task
  where task.user_id = (select auth.uid())
    and task.status <> 'archived'
    and task.search_vector @@ websearch_to_tsquery('english', search_text)
  order by ts_rank(task.search_vector, websearch_to_tsquery('english', search_text)) desc,
    task.updated_at desc;
$$;

revoke all on function public.search_tasks(text) from public, anon;
grant execute on function public.search_tasks(text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'projects'
  ) then
    alter publication supabase_realtime add table public.projects;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'saved_filters'
  ) then
    alter publication supabase_realtime add table public.saved_filters;
  end if;
end;
$$;
