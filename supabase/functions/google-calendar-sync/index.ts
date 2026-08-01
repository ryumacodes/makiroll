import { createClient } from 'npm:@supabase/supabase-js@2.111.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type AdminClient = ReturnType<typeof createClient>;

function env(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function encodeBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function secretsMatch(expected: string, supplied: string) {
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
  ]);
  const left = new Uint8Array(expectedHash);
  const right = new Uint8Array(suppliedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
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

async function recordFailure(admin: AdminClient, userId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await admin.from('calendar_connections').update({
    last_error: message.slice(0, 1000),
    next_sync_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
  }).eq('user_id', userId);
}

async function claimConnection(admin: AdminClient, userId: string) {
  const now = new Date().toISOString();
  const lockUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('calendar_connections')
    .update({ next_sync_at: lockUntil, last_error: null })
    .eq('user_id', userId)
    .lte('next_sync_at', now)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function syncConnection(
  admin: AdminClient,
  userId: string,
  existing: Record<string, any> | null,
  providerAccessToken?: string,
  providerRefreshToken?: string,
) {
  let connection = existing;
  let refreshToken = providerRefreshToken || (connection?.refresh_token_ciphertext ? await decrypt(connection.refresh_token_ciphertext) : null);
  let accessToken = providerAccessToken || (connection?.access_token_ciphertext ? await decrypt(connection.access_token_ciphertext) : null);

  if (providerAccessToken || providerRefreshToken) {
    if (!refreshToken) throw new Error('Google did not return a refresh token. Reconnect and approve calendar access again.');
    if (!accessToken) throw new Error('Google did not return an access token.');
    const profile = await googleRequest('https://www.googleapis.com/oauth2/v3/userinfo', accessToken);
    const { data, error } = await admin.from('calendar_connections').upsert({
      user_id: userId,
      google_email: profile.email || null,
      access_token_ciphertext: await encrypt(accessToken),
      refresh_token_ciphertext: await encrypt(refreshToken),
      token_expires_at: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
      scopes: ['calendar.events', 'calendar.calendarlist.readonly'],
      connected_at: connection?.connected_at || new Date().toISOString(),
      next_sync_at: new Date().toISOString(),
      last_error: null,
    }, { onConflict: 'user_id' }).select('*').single();
    if (error) throw error;
    connection = data;
  }

  if (!refreshToken) return { connected: false, imported: 0 };

  if (!accessToken || !connection?.token_expires_at || Date.parse(connection.token_expires_at) < Date.now() + 60_000) {
    const refreshed = await refreshAccessToken(refreshToken);
    accessToken = refreshed.access_token;
    const { error } = await admin.from('calendar_connections').update({
      access_token_ciphertext: await encrypt(accessToken),
      token_expires_at: new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString(),
    }).eq('user_id', userId);
    if (error) throw error;
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
    const { data: state, error: stateError } = await admin.from('calendar_sync_state').select('sync_token').eq('user_id', userId).eq('calendar_id', calendarId).maybeSingle();
    if (stateError) throw stateError;
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
      const rows = (response.items || []).map((event: Record<string, any>) => eventRow(userId, calendarId, event));
      if (rows.length) {
        const { error } = await admin.from('calendar_events').upsert(rows, { onConflict: 'user_id,calendar_id,external_id' });
        if (error) throw error;
        imported += rows.length;
      }
      pageToken = response.nextPageToken;
      nextSyncToken = response.nextSyncToken || nextSyncToken;
    } while (pageToken);

    if (nextSyncToken) {
      const { error } = await admin.from('calendar_sync_state').upsert({ user_id: userId, calendar_id: calendarId, sync_token: nextSyncToken }, { onConflict: 'user_id,calendar_id' });
      if (error) throw error;
    }
  }

  const lastSyncedAt = new Date().toISOString();
  const { error: connectionError } = await admin.from('calendar_connections').update({
    last_synced_at: lastSyncedAt,
    next_sync_at: new Date(Date.now() + 60 * 1000).toISOString(),
    last_error: null,
  }).eq('user_id', userId);
  if (connectionError) throw connectionError;

  return { connected: true, imported, lastSyncedAt };
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = env('SUPABASE_URL');
  const admin = createClient(supabaseUrl, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const body = await request.json().catch(() => ({}));
  const action = body.action || 'sync';

  if (action === 'sync-due') {
    const suppliedSecret = request.headers.get('x-cron-secret') || '';
    if (!await secretsMatch(env('GOOGLE_SYNC_CRON_SECRET'), suppliedSecret)) return json({ error: 'Unauthorized' }, 401);

    const now = new Date().toISOString();
    const { data: due, error } = await admin
      .from('calendar_connections')
      .select('*')
      .lte('next_sync_at', now)
      .order('next_sync_at')
      .limit(10);
    if (error) return json({ error: error.message }, 500);

    let synced = 0;
    let failed = 0;
    for (const candidate of due || []) {
      try {
        const claimed = await claimConnection(admin, candidate.user_id);
        if (!claimed) continue;
        await syncConnection(admin, candidate.user_id, claimed);
        synced += 1;
      } catch (syncError) {
        failed += 1;
        await recordFailure(admin, candidate.user_id, syncError);
      }
    }
    return json({ attempted: due?.length || 0, synced, failed });
  }

  let userId: string | null = null;
  try {
    const authorization = request.headers.get('Authorization');
    if (!authorization) return json({ error: 'Unauthorized' }, 401);
    const userClient = createClient(supabaseUrl, env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return json({ error: 'Unauthorized' }, 401);
    userId = user.id;

    const { data: existing, error: existingError } = await admin.from('calendar_connections').select('*').eq('user_id', user.id).maybeSingle();
    if (existingError) throw existingError;

    if (action === 'connect') {
      return json(await syncConnection(admin, user.id, existing, body.providerAccessToken, body.providerRefreshToken));
    }
    if (!existing) return json({ connected: false });

    const claimed = await claimConnection(admin, user.id);
    if (!claimed) return json({ connected: true, skipped: true, lastSyncedAt: existing.last_synced_at });
    return json(await syncConnection(admin, user.id, claimed));
  } catch (error) {
    if (userId) await recordFailure(admin, userId, error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
