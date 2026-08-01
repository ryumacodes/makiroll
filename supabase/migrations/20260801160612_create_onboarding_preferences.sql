create table public.onboarding_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  selected_providers text[] not null default '{}',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onboarding_preferences_provider_limit check (cardinality(selected_providers) <= 24)
);

alter table public.onboarding_preferences enable row level security;
alter table public.onboarding_preferences force row level security;

create policy "Users can read their onboarding preferences" on public.onboarding_preferences
for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create their onboarding preferences" on public.onboarding_preferences
for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update their onboarding preferences" on public.onboarding_preferences
for update to authenticated using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

revoke all on table public.onboarding_preferences from public, anon, authenticated;
grant select, insert, update on table public.onboarding_preferences to authenticated;
