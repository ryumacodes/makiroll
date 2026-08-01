alter table public.onboarding_preferences
add column workday_start time not null default '09:00';
