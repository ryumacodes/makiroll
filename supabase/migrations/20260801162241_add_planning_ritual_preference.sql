alter table public.onboarding_preferences
add column planning_ritual text not null default 'start_of_day'
check (planning_ritual in ('start_of_day', 'night_before'));
