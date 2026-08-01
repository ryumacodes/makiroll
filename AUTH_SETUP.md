# Maki production auth + calendar setup

## 1. Google Auth Platform — the screen you are on

Create a **Web application** client named `makirolls`.

### Authorized JavaScript origins

Add these as separate entries:

- `https://makiroll.xyz`
- `http://localhost:5173`

Add `https://www.makiroll.xyz` only if that hostname will actually serve the app. Do not put a path or trailing slash in an origin.

### Authorized redirect URIs

Replace `https://www.example.com` with exactly:

- `https://lcnzxpfmpahmndzdupba.supabase.co/auth/v1/callback`

This is the Google → Supabase callback. Do **not** put `https://makiroll.xyz/auth/callback` in this Google field; that URL belongs in Supabase's redirect allow-list.

After creating the client, copy its **Client ID** and **Client secret**.

## 2. Google APIs and consent screen

Enable **Google Calendar API** for the same Google Cloud project.

In Google Auth Platform → **Data Access**, add:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`

Calendar scopes are sensitive. While the app is in Testing, add your own Google account under **Audience → Test users**. Production access for the public will require Google OAuth verification, a privacy policy, and a verified domain.

## 3. Supabase Dashboard

In **Authentication → Sign In / Providers → Google**:

1. Enable Google.
2. Paste the Google Client ID and Client secret.
3. Enable manual identity linking. This lets someone who entered through a magic link attach Google Calendar without creating a second Maki account.

In **Authentication → URL Configuration** set:

- Site URL: `https://makiroll.xyz`
- Redirect URLs:
  - `https://makiroll.xyz/auth/callback`
  - `https://makiroll.xyz/auth/confirm`
  - `http://localhost:5173/auth/callback`
  - `http://localhost:5173/auth/confirm`

Add an exact Vercel preview URL only when you need to test a preview. Avoid a broad wildcard in production.

Email auth / magic links are enabled by default. Because Maki uses PKCE, update **Authentication → Email Templates → Magic Link** to:

```html
<h2>Sign in to Maki</h2>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">Open Maki</a></p>
```

For production delivery, configure custom SMTP; Supabase's default sender is rate-limited and intended for testing.

## 4. Vercel variables

Set these for Production, Preview, and Development:

- `VITE_SUPABASE_URL=https://lcnzxpfmpahmndzdupba.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...`

Only the publishable key belongs in browser code. Never put a secret or `service_role` key in a `VITE_` variable.

## 5. Calendar sync backend

Deploy the migration and Edge Function after Google credentials are saved:

```sh
supabase db push
supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_TOKEN_ENCRYPTION_KEY=...
supabase functions deploy google-calendar-sync
```

`GOOGLE_TOKEN_ENCRYPTION_KEY` should be a long random secret (at least 32 random bytes). Keep it out of Git and Vercel's public variables.

The browser asks the Edge Function to sync at startup, every 60 seconds while visible, when the tab regains focus, and when the network reconnects. Google incremental sync tokens keep those checks efficient. Events then fan out to every open Maki client through Supabase Realtime. The Google refresh token is encrypted before being stored and is never persisted in browser storage.

For closed-browser background freshness, schedule the same server-side sync flow every five minutes after the first production deploy. Google push notification channels can be layered on later for near-instant changes, but they still require periodic channel renewal and incremental-sync fallback.
