import { createClient } from 'npm:@supabase/supabase-js@2.111.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function env(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function encodeBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function encryptionKey() {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env('GOOGLE_TOKEN_ENCRYPTION_KEY')));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(), encoder.encode(value)));
  return `${encodeBase64(iv)}.${encodeBase64(encrypted)}`;
}

async function decrypt(value: string) {
  const [iv, encrypted] = value.split('.').map(decodeBase64);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await encryptionKey(), encrypted);
  return decoder.decode(plain);
}

async function googleRequest(url: string, accessToken: string) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Google Calendar returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function refreshAccessToken(refreshToken: string) {
  const body = new URLSearchParams({
    client_id: env('GOOGLE_CLIENT_ID'),
    client_secret: env('GOOGLE_CLIENT_SECRET'),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`Google token refresh failed: ${await response.text()}`);
  return response.json();
}

function eventRow(userId: string, calendarId: string, event: Record<string, any>) {
  const allDay = Boolean(event.start?.date);
  return {
    user_id: userId,
    calendar_id: calendarId,
    external_id: event.id,
    title: event.summary || '(Untitled event)',
    description: event.description || '',
    location: event.location || '',
    starts_at: event.start?.dateTime || (event.start?.date ? `${event.start.date}T00:00:00Z` : null),
    ends_at: event.end?.dateTime || (event.end?.date ? `${event.end.date}T00:00:00Z` : null),
    all_day: allDay,
    status: event.status || 'confirmed',
    html_link: event.htmlLink || null,
    meeting_url: event.hangoutLink || event.conferenceData?.entryPoints?.find((point: any) => point.entryPointType === 'video')?.uri || null,
    etag: event.etag || null,
    source_updated_at: event.updated || null,
  };
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let failureAdmin: ReturnType<typeof createClient> | null = null;
  let failureUserId: string | null = null;
  try {
    const authorization = request.headers.get('Authorization');
    if (!authorization) throw new Error('Missing authorization');

    const supabaseUrl = env('SUPABASE_URL');
    const userClient = createClient(supabaseUrl, env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const admin = createClient(supabaseUrl, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    failureAdmin = admin;
    failureUserId = user.id;
    const body = await request.json().catch(() => ({}));
    const action = body.action || 'sync';
    const { data: existing } = await admin.from('calendar_connections').select('*').eq('user_id', user.id).maybeSingle();

    if (action === 'sync' && existing) {
      const now = new Date().toISOString();
      const lockUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      const { data: claim, error: claimError } = await admin
        .from('calendar_connections')
        .update({ next_sync_at: lockUntil, last_error: null })
        .eq('user_id', user.id)
        .lte('next_sync_at', now)
        .select('user_id,last_synced_at')
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claim) return new Response(JSON.stringify({ connected: true, skipped: true, lastSyncedAt: existing.last_synced_at }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let refreshToken = body.providerRefreshToken || (existing?.refresh_token_ciphertext ? await decrypt(existing.refresh_token_ciphertext) : null);
    let accessToken = body.providerAccessToken || (existing?.access_token_ciphertext ? await decrypt(existing.access_token_ciphertext) : null);

    if (action === 'connect') {
      if (!refreshToken) throw new Error('Google did not return a refresh token. Reconnect and approve calendar access again.');
      if (!accessToken) throw new Error('Google did not return an access token.');
      const profile = await googleRequest('https://www.googleapis.com/oauth2/v3/userinfo', accessToken);
      const { error } = await admin.from('calendar_connections').upsert({
        user_id: user.id,
        google_email: profile.email || user.email,
        access_token_ciphertext: await encrypt(accessToken),
        refresh_token_ciphertext: await encrypt(refreshToken),
        token_expires_at: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
        scopes: ['calendar.events', 'calendar.calendarlist.readonly'],
        connected_at: existing?.connected_at || new Date().toISOString(),
        next_sync_at: new Date().toISOString(),
        last_error: null,
      }, { onConflict: 'user_id' });
      if (error) throw error;
    }

    if (!refreshToken) return new Response(JSON.stringify({ connected: false }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    if (!accessToken || !existing?.token_expires_at || Date.parse(existing.token_expires_at) < Date.now() + 60_000) {
      const refreshed = await refreshAccessToken(refreshToken);
      accessToken = refreshed.access_token;
      await admin.from('calendar_connections').update({
        access_token_ciphertext: await encrypt(accessToken),
        token_expires_at: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString(),
      }).eq('user_id', user.id);
    }

    const calendars: Record<string, any>[] = [];
    let calendarPageToken: string | undefined;
    do {
      const listQuery = new URLSearchParams({ minAccessRole: 'reader', maxResults: '250' });
      if (calendarPageToken) listQuery.set('pageToken', calendarPageToken);
      const list = await googleRequest(`https://www.googleapis.com/calendar/v3/users/me/calendarList?${listQuery}`, accessToken);
      calendars.push(...(list.items || []));
      calendarPageToken = list.nextPageToken;
    } while (calendarPageToken);
    let imported = 0;
    for (const calendar of calendars) {
      if (calendar.deleted || calendar.hidden) continue;
      const calendarId = calendar.id;
      const { data: state } = await admin.from('calendar_sync_state').select('sync_token').eq('user_id', user.id).eq('calendar_id', calendarId).maybeSingle();
      let pageToken: string | undefined;
      let nextSyncToken: string | undefined;
      let resetSync = false;

      do {
        const query = new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', maxResults: '2500' });
        if (pageToken) query.set('pageToken', pageToken);
        if (state?.sync_token && !resetSync) query.set('syncToken', state.sync_token);
        else {
          query.set('timeMin', new Date(Date.now() - 30 * 86400000).toISOString());
          query.set('timeMax', new Date(Date.now() + 366 * 86400000).toISOString());
        }
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${query}`;
        let response: any;
        try {
          response = await googleRequest(url, accessToken);
        } catch (error) {
          if (String(error).includes('410') && state?.sync_token && !resetSync) {
            resetSync = true;
            pageToken = undefined;
            continue;
          }
          throw error;
        }
        const rows = (response.items || []).map((event: Record<string, any>) => eventRow(user.id, calendarId, event));
        if (rows.length) {
          const { error } = await admin.from('calendar_events').upsert(rows, { onConflict: 'user_id,calendar_id,external_id' });
          if (error) throw error;
          imported += rows.length;
        }
        pageToken = response.nextPageToken;
        nextSyncToken = response.nextSyncToken || nextSyncToken;
      } while (pageToken);

      if (nextSyncToken) {
        await admin.from('calendar_sync_state').upsert({ user_id: user.id, calendar_id: calendarId, sync_token: nextSyncToken }, { onConflict: 'user_id,calendar_id' });
      }
    }

    await admin.from('calendar_connections').update({
      last_synced_at: new Date().toISOString(),
      next_sync_at: new Date(Date.now() + 60 * 1000).toISOString(),
      last_error: null,
    }).eq('user_id', user.id);

    return new Response(JSON.stringify({ connected: true, imported }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (failureAdmin && failureUserId) {
      await failureAdmin.from('calendar_connections').update({
        last_error: message.slice(0, 1000),
        next_sync_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      }).eq('user_id', failureUserId);
    }
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
