import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const configured = Boolean(supabaseUrl && supabasePublishableKey);

let client = null;
let currentUser = null;
// Google provider tokens are deliberately kept in memory only. Background sync
// will move them into a server-side encrypted store, never localStorage.
let googleProviderToken = null;
let googleProviderRefreshToken = null;
const calendarConsentPending = () => sessionStorage.getItem('maki-google-calendar-consent') === 'pending';

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
  const hasGoogleIdentity = currentUser?.identities?.some(identity => identity.provider === 'google') || false;
  return { configured, user: currentUser, hasGoogleIdentity, hasGoogleAccess: Boolean(googleProviderToken) };
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
    if (calendarConsentPending() && session?.provider_token) googleProviderToken = session.provider_token;
    if (calendarConsentPending() && session?.provider_refresh_token) googleProviderRefreshToken = session.provider_refresh_token;
    onReady({
      configured: true,
      user: currentUser,
      providerToken: googleProviderToken,
      providerRefreshToken: googleProviderRefreshToken,
      error: null
    });
  });

  const params = new URLSearchParams(window.location.search);
  const tokenHash = params.get('token_hash');
  if (window.location.pathname === '/auth/confirm' && tokenHash) {
    const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
    if (error) {
      onReady({ configured: true, user: null, error });
      return;
    }
  }

  const { data, error } = await client.auth.getSession();
  currentUser = data.session?.user || null;
  if (calendarConsentPending() && data.session?.provider_token) googleProviderToken = data.session.provider_token;
  if (calendarConsentPending() && data.session?.provider_refresh_token) googleProviderRefreshToken = data.session.provider_refresh_token;

  if (currentUser && ['/auth/callback', '/auth/confirm'].includes(window.location.pathname)) {
    window.history.replaceState({}, document.title, '/app');
  }

  onReady({
    configured: true,
    user: currentUser,
    providerToken: googleProviderToken,
    providerRefreshToken: googleProviderRefreshToken,
    error
  });
}

const googleOptions = (calendarAccess = false) => ({
  redirectTo: `${window.location.origin}/auth/callback`,
  scopes: (calendarAccess ? [
    'openid', 'email', 'profile',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
  ] : ['openid', 'email', 'profile']).join(' '),
  queryParams: {
    access_type: 'offline',
    prompt: calendarAccess ? 'consent' : 'select_account',
    include_granted_scopes: 'true'
  }
});

export async function signInWithGoogle() {
  if (!client) return new Error('Supabase is not configured.');

  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: googleOptions(false)
  });

  return error;
}

export async function signInWithMagicLink(email) {
  if (!client) return new Error('Supabase is not configured.');
  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${window.location.origin}/auth/confirm`,
      shouldCreateUser: true
    }
  });
  return error;
}

export async function connectGoogleCalendar() {
  if (!client) return new Error('Supabase is not configured.');
  if (!currentUser) return signInWithGoogle();
  sessionStorage.setItem('maki-google-calendar-consent', 'pending');
  const hasGoogleIdentity = currentUser.identities?.some(identity => identity.provider === 'google');
  const method = hasGoogleIdentity ? 'signInWithOAuth' : 'linkIdentity';
  const { error } = await client.auth[method]({ provider: 'google', options: googleOptions(true) });
  if (error) sessionStorage.removeItem('maki-google-calendar-consent');
  return error;
}

export function completeGoogleCalendarConsent() {
  sessionStorage.removeItem('maki-google-calendar-consent');
}

export async function signOut() {
  if (!client) return;
  googleProviderToken = null;
  googleProviderRefreshToken = null;
  sessionStorage.removeItem('maki-google-calendar-consent');
  await client.auth.signOut();
}
