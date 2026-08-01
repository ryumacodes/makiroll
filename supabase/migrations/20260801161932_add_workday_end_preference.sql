alter table public.onboarding_preferences
add column workday_end time not null default '17:00';

alter table public.onboarding_preferences
add constraint onboarding_preferences_workday_window
check (workday_end > workday_start);
