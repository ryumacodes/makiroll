import { getAuthState, getSupabaseClient } from './supabase.js';

let syncTimer = null;
let syncInFlight = null;
let stopRealtime = () => {};

export async function saveGoogleGrant(providerAccessToken, providerRefreshToken) {
  const client = getSupabaseClient();
  if (!client || !providerAccessToken) return { connected: false };
  const { data, error } = await client.functions.invoke('google-calendar-sync', {
    body: { action: 'connect', providerAccessToken, providerRefreshToken },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function syncGoogleCalendar() {
  if (syncInFlight) return syncInFlight;
  const client = getSupabaseClient();
  if (!client) return { connected: false };
  syncInFlight = client.functions.invoke('google-calendar-sync', { body: { action: 'sync' } })
    .then(({ data, error }) => {
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    })
    .finally(() => { syncInFlight = null; });
  return syncInFlight;
}

export async function loadCalendarEvents(rangeStart, rangeEnd) {
  const client = getSupabaseClient();
  const { user } = getAuthState();
  if (!client || !user) return [];
  const { data, error } = await client
    .from('calendar_events')
    .select('*')
    .eq('user_id', user.id)
    .neq('status', 'cancelled')
    .lt('starts_at', rangeEnd.toISOString())
    .gt('ends_at', rangeStart.toISOString())
    .order('starts_at');
  if (error) throw error;
  return data || [];
}

export function startCalendarSync(userId, { onSync, onChange, onError }) {
  stopCalendarSync();
  const run = async () => {
    if (document.hidden || !navigator.onLine) return;
    try {
      const result = await syncGoogleCalendar();
      onSync?.(result);
    } catch (error) {
      onError?.(error);
    }
  };
  const refreshNow = () => { if (!document.hidden && navigator.onLine) run(); };
  window.addEventListener('online', refreshNow);
  window.addEventListener('focus', refreshNow);
  document.addEventListener('visibilitychange', refreshNow);

  const client = getSupabaseClient();
  const channel = client?.channel(`calendar-events-${userId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_events', filter: `user_id=eq.${userId}` }, () => onChange?.())
    .subscribe();

  syncTimer = window.setInterval(run, 60_000);
  run();
  stopRealtime = () => {
    window.removeEventListener('online', refreshNow);
    window.removeEventListener('focus', refreshNow);
    document.removeEventListener('visibilitychange', refreshNow);
    if (channel) client.removeChannel(channel);
  };
}

export function stopCalendarSync() {
  if (syncTimer) window.clearInterval(syncTimer);
  syncTimer = null;
  stopRealtime();
  stopRealtime = () => {};
}
