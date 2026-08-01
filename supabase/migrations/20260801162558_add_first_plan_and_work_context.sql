alter table public.onboarding_preferences
  add column if not exists first_plan_date date,
  add column if not exists work_context text not null default '',
  add column if not exists first_day_goal text not null default '',
  add column if not exists automation_settings jsonb not null default '{"conflict_aware_planning":true,"workday_boundaries":true,"duration_suggestions":true,"project_suggestions":true}'::jsonb;

alter table public.onboarding_preferences
  drop constraint if exists onboarding_preferences_work_context_length,
  add constraint onboarding_preferences_work_context_length check (char_length(work_context) <= 2000),
  drop constraint if exists onboarding_preferences_first_day_goal_length,
  add constraint onboarding_preferences_first_day_goal_length check (char_length(first_day_goal) <= 2000),
  drop constraint if exists onboarding_preferences_automation_settings_object,
  add constraint onboarding_preferences_automation_settings_object check (jsonb_typeof(automation_settings) = 'object');
