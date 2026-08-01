alter table public.tasks
  add column if not exists subtasks jsonb not null default '[]'::jsonb;

alter table public.tasks
  drop constraint if exists tasks_subtasks_array,
  add constraint tasks_subtasks_array check (
    jsonb_typeof(subtasks) = 'array'
    and jsonb_array_length(subtasks) <= 100
  );
