create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if (
    select count(distinct name)
    from vault.decrypted_secrets
    where name in ('maki_project_url', 'maki_publishable_key', 'maki_google_sync_cron_secret')
  ) <> 3 then
    raise exception 'Calendar Cron Vault secrets must be configured before this migration runs';
  end if;

  if exists (select 1 from cron.job where jobname = 'maki-google-calendar-sync-every-30-minutes') then
    perform cron.unschedule('maki-google-calendar-sync-every-30-minutes');
  end if;
end;
$$;

select cron.schedule(
  'maki-google-calendar-sync-every-30-minutes',
  '*/30 * * * *',
  $job$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'maki_project_url'
    ) || '/functions/v1/google-calendar-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'maki_publishable_key'
      ),
      'x-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'maki_google_sync_cron_secret'
      )
    ),
    body := '{"action":"sync-due"}'::jsonb,
    timeout_milliseconds := 60000
  ) as request_id;
  $job$
);
