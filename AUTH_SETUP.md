# Maki auth setup

## 1. Google Auth Platform

Create a **Web application** OAuth client and configure:

- Authorized JavaScript origins:
  - `http://localhost:5173`
  - `https://YOUR_PRODUCTION_DOMAIN`
- Authorized redirect URI:
  - `https://lcnzxpfmpahmndzdupba.supabase.co/auth/v1/callback`

Enable the Google Calendar API and add these Data Access scopes:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`

The two Calendar scopes are sensitive scopes, so production use may require Google verification.

## 2. Supabase Dashboard

In **Authentication → Sign In / Providers → Google**, enable Google and add the OAuth Client ID and Client Secret.

In **Authentication → URL Configuration**:

- Site URL: `https://YOUR_PRODUCTION_DOMAIN`
- Redirect URLs:
  - `http://localhost:5173/auth/callback`
  - `https://YOUR_PRODUCTION_DOMAIN/auth/callback`
  - `https://*-YOUR_VERCEL_TEAM.vercel.app/auth/callback` for previews

Use an exact production callback. Keep the wildcard only for preview deployments.

## 3. Environment variables

Copy `.env.example` to `.env.local`, then add the same variables in Vercel for Production, Preview, and Development:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Only the publishable key belongs in browser code. Never add a secret or `service_role` key to a `VITE_` variable.

## 4. Token handling

The browser uses PKCE and requests `access_type=offline` with `prompt=consent`. Maki keeps the short-lived Google provider token in memory only. Before background calendar sync is implemented, the Google refresh token must be sent once to a trusted server-side function and encrypted at rest. Supabase does not refresh Google provider tokens automatically.
