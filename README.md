# maki

A calm, calendar-native place to decide what matters, make time for it, and get it done.

> Early-stage software — Maki is under active development. Expect bugs, unfinished flows, and breaking changes.

## Features

- **Plan the day** — Turn tasks into a focused timeline with durations and scheduled times.
- **Keep work organized** — Move between Today, Upcoming, All tasks, project boards, and a weekly calendar.
- **Capture quickly** — Create tasks without leaving the current view and keep working with keyboard-friendly controls.
- **Shape the view** — Search, combine filters, and save useful task views for later.
- **Work visually** — Drag tasks across project board columns and see scheduled work beside calendar events.
- **Use it without an account** — Preview data and edits are saved to local storage.
- **Sync when signed in** — Account-backed workspaces support durable persistence, live updates, and incremental Google Calendar sync.
- **Stay comfortable** — Responsive layouts, dark and light themes, and reduced-motion support are built into the interface.

## Built With

- [Vite](https://vite.dev/) — development server and production build
- [PostgreSQL](https://www.postgresql.org/) — synced workspace storage
- [Google Calendar API](https://developers.google.com/calendar/api) — external calendar synchronization
- Vanilla JavaScript and CSS — the application interface

## Quick Start

Requirements: Node.js 20.19+ and [pnpm](https://pnpm.io/).

```sh
git clone <your-repository-url>
cd maki
pnpm install
pnpm dev
```

Open `http://localhost:5173`. No environment variables are required for the local preview; tasks and saved filters remain in your browser.

## Development

```sh
pnpm dev       # Start the Vite development server
pnpm build     # Create a production build in dist/
pnpm preview   # Serve the production build locally
```

The production build can run without backend configuration, so UI work remains easy to preview. Account persistence and calendar sync activate when a compatible backend is connected.

## Project Structure

```text
.
├── index.html                         # Application shell and accessible markup
├── app.js                             # Views, interactions, and UI state
├── data.js                            # Local and remote persistence layer
├── calendar.js                        # Calendar sync client and Realtime updates
├── styles.css                         # Responsive theme and component styles
└── public/maki.svg                    # App icon
```

## How Persistence Works

Maki has two runtime modes:

| Mode | When it is used | Where data lives |
| --- | --- | --- |
| Local preview | The user is signed out | Browser local storage |
| Synced workspace | The user is signed in | PostgreSQL |

Google provider tokens belong in encrypted server-side storage. They should never be written to local storage.

## Product Direction

Maki is aiming for the calm planning flow of Sunsama, the task depth of Todoist, and a genuinely first-class calendar—without turning the interface into a control panel.

The guiding rules are simple:

- Capture should be fast; planning should be deliberate.
- Tasks, meetings, and scheduled work sessions should remain distinct.
- Calendar sync should be observable, reversible, and trustworthy.
- Mobile, keyboard, and touch workflows all count as primary experiences.
- User data should remain portable and easy to remove.
