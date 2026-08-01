import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const configured = Boolean(supabaseUrl && supabasePublishableKey);

let client = null;
let currentUser = null;
// Google provider tokens are deliberately kept in memory only. Background sync
// will move them into a server-side encrypted store, never localStorage.
let googleProviderToken = null;

if (configured) {
  client = createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
}

export function getAuthState() {
  return { configured, user: currentUser, hasGoogleAccess: Boolean(googleProviderToken) };
}

export function getSupabaseClient() {
  return client;
}

export async function initAuth({ onReady }) {
  if (!configured) {
    onReady({ configured: false, user: null, error: null });
    return;
  }

  client.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
    if (session?.provider_token) googleProviderToken = session.provider_token;
    onReady({ configured: true, user: currentUser, error: null });
  });

  const { data, error } = await client.auth.getSession();
  currentUser = data.session?.user || null;
  if (data.session?.provider_token) googleProviderToken = data.session.provider_token;

  if (currentUser && window.location.pathname === '/auth/callback') {
    window.history.replaceState({}, document.title, '/');
  }

  onReady({ configured: true, user: currentUser, error });
}

export async function signInWithGoogle() {
  if (!client) return new Error('Supabase is not configured.');

  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth/callback`,
      scopes: [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
      ].join(' '),
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true'
      }
    }
  });

  return error;
}

export async function signOut() {
  if (!client) return;
  googleProviderToken = null;
  await client.auth.signOut();
}
