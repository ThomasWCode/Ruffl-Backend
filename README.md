# Ruffl API

Ruffl API is the backend for the Ruffl mobile app and admin dashboard. It is the single source of truth for accounts, permissions, commissions, messages, reviews, disputes, warnings, suspensions, and deletions.

This project uses:

- **Node.js** to run JavaScript and TypeScript outside a browser.
- **TypeScript** to add type checking to JavaScript.
- **Fastify** to receive HTTP requests and return API responses.
- **npm** to install libraries and run the scripts in `package.json`.
- **Bearer tokens** to identify a signed-in user on later requests.
- **CORS** to control which browser-based websites may call the API.
- **Vitest** to run automated tests.

You do not need prior backend experience to run the development version. Follow the steps below in order.

## What is implemented

- Email/password signup and login with 30-day bearer tokens
- Commissioner/maker-only public signup; admin signup is rejected
- Live suspension/deletion checks on every authenticated request
- Maker profiles, discovery, open-queue filtering, and waitlists
- Request to negotiation to simulated deposit to milestones to shipping to receipt lifecycle
- Unified conversation/message model for commission, direct, dispute, and admin chat
- Five-category reviews, maker materials tracking, warnings, and notifications
- Disputes with evidence, assignment, adjudication, and closure
- Admin user moderation and read-only marketplace context
- Ten-minute CSRF tokens for browser-based admin mutations
- Upload-slot type/size validation and stable avatar/banner object keys
- A Supabase/Postgres migration with row-level security enabled on every application table
- A database trigger that rejects admin-role creation or promotion unless a privileged session explicitly opts in

## Project structure

```text
Ruffl-Backend/
|-- src/
|   |-- domain/       Shared types and business rules
|   |-- services/     Authentication and other service helpers
|   |-- store/        Current in-memory data repository
|   |-- app.ts        Fastify configuration and API routes
|   `-- server.ts     Starts the HTTP server
|-- test/             Automated API tests
|-- database/
|   `-- 001_initial.sql
|-- .env.example      Safe configuration template
|-- Dockerfile        Production container instructions
`-- package.json      Dependencies and runnable commands
```

## 1. Install the required software

- Install **Node.js 22 LTS** from [nodejs.org](https://nodejs.org/). The minimum supported version is Node.js 20.19.
- npm is installed with Node.js; it does not need a separate installer.
- A code editor such as Visual Studio Code is recommended.

Open PowerShell and confirm the installation:

```powershell
node --version
npm --version
```

If `node` is not recognised, close and reopen PowerShell after installing Node.js.

## 2. First-time local setup

Open PowerShell and run:

```powershell
cd C:\Users\thoma\Documents\Ruffl\Ruffl-Backend
npm install
Copy-Item .env.example .env
```

- `npm install` downloads the libraries listed in `package.json`.
- `Copy-Item` creates your private local configuration file.
- Do not commit `.env`. It can contain passwords and service credentials.
- Run `npm install` again after pulling a change to `package.json` or `package-lock.json`.

Generate a suitable development JWT secret:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Open `.env` and replace the `JWT_SECRET` example value with the generated value.

## 3. Understand the environment settings

The development defaults in `.env.example` are enough to run the current in-memory version after replacing `JWT_SECRET`.

| Setting | Purpose |
|---|---|
| `PORT` | Port used by the API. The default is `3000`. |
| `HOST` | `0.0.0.0` lets both this computer and devices on the local network reach the API. |
| `NODE_ENV` | Use `development` locally and `production` on a deployed server. |
| `JWT_SECRET` | Private key used to sign login tokens. Use a long random value and never publish it. |
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API. |
| `SEED_DEMO_DATA` | Creates the demo users when `true`. This must be `false` in production. |
| `DATABASE_URL` | Future Postgres/Supabase connection string. The running API does not use it yet. |
| `R2_*` | Future Cloudflare R2 media-storage configuration. |
| `RESEND_API_KEY` | Future email-service credential. |
| `EXPO_ACCESS_TOKEN` | Future Expo push-notification credential. |
| `SENTRY_DSN` | Future error-monitoring destination. |
| `ADMIN_EMAIL` | Support contact address used by the service. |

An **origin** is only the protocol, hostname, and optional port. It does not include a page path. For example:

```dotenv
CORS_ORIGINS=http://localhost:5173,https://thomaswcode.github.io,https://admin.ruffl.example
```

- Use `http://localhost:5173` for the local admin dashboard.
- Use `https://thomaswcode.github.io` for a GitHub Pages project site. Do not append `/Ruffl-Admin-Dashboard/`.
- Use the exact HTTPS origin if the dashboard has a custom domain.
- Restart the backend after changing `.env`.

The mobile app is not subject to browser CORS, but its API URL must still point to this backend.

## 4. Start the API

```powershell
npm run dev
```

The terminal must stay open. The API restarts automatically when a backend source file changes.

In a second PowerShell window, verify that it is running:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

You can also visit `http://localhost:3000/health` in a browser.

When testing on a real phone, use the development computer's local IPv4 address instead of `localhost` in the mobile app. Run `ipconfig`, find the active network adapter's IPv4 address, and use a URL such as `http://192.168.1.238:3000`. The phone and computer must be on the same network, and Windows Firewall must allow Node.js on that private network.

## Demo accounts

These accounts are created when `SEED_DEMO_DATA=true`:

| Role | Email | Password |
|---|---|---|
| Commissioner | `commissioner@demo.ruffl` | `RufflDemo1!` |
| Maker | `maker@demo.ruffl` | `RufflDemo1!` |
| Admin | `admin@demo.ruffl` | `RufflDemo1!` |

- Demo data is held in memory and resets when the backend restarts.
- Demo accounts are development data and must not be enabled in production.
- Public signup cannot create an admin account.

## Start the complete system locally

Use a separate PowerShell window for each process:

1. Start this backend with `npm run dev`.
2. Start `Ruffl-Frontend` with `npm start`.
3. Start `Ruffl-Admin-Dashboard` with `npm run dev`.
4. Keep all three terminals open while testing.

Starting the backend first makes frontend connection errors easier to understand.

## Available commands

| Command | What it does |
|---|---|
| `npm install` | Installs the exact project dependencies. |
| `npm run dev` | Runs the API in watch mode for development. |
| `npm run typecheck` | Checks TypeScript without generating build files. |
| `npm test` | Runs the automated tests once. |
| `npm run test:watch` | Reruns affected tests while files change. |
| `npm run build` | Creates production JavaScript in `dist`. |
| `npm start` | Runs the already-built production JavaScript. |

Run the full validation set before pushing backend changes:

```powershell
npm run typecheck
npm test
npm run build
```

The tests use Fastify request injection, so they do not open a port or require external services. They cover public admin escalation, browser CORS preflights, immediate suspension/deletion enforcement, lifecycle permissions, and exact milestone payment allocation.

## Rate limits

Rate limits reduce automated abuse. They are applied to the client IP address, so repeated attempts from the same phone or computer share the same allowance.

| Request | Limit |
|---|---|
| All API requests | 100 requests per minute per IP |
| Signup | 5 attempts per hour per IP |
| Login | 10 attempts per 15 minutes per IP |
| Upload slots | 20 attempts per hour per IP |

- A rejected login still counts as an attempt.
- When a limit is reached, the API returns HTTP `429 Too Many Requests`.
- The frontend should show the API's retry message instead of a generic error.
- Restarting the development server clears the current in-memory rate-limit counters. Do not use that as a production solution.

## Suspensions, deletions, and warnings

- The backend checks the account on every authenticated request.
- A suspended or soft-deleted account cannot continue performing protected actions, even if it still has an unexpired token.
- Permanent deletion is intentionally guarded and should only be used when its stricter conditions are satisfied.
- The mobile app also polls account state and checks when returning to the foreground, so warnings and restrictions appear without requiring a manual refresh.
- Backend enforcement is the security boundary; a delayed screen update must never grant permission.

## Database setup

This section is optional for current local development because the running API still uses the in-memory repository.

To inspect or prepare the Postgres schema:

1. Create a new Supabase project or Postgres database.
2. In Supabase, open **SQL Editor**, create a new query, and paste the contents of `database/001_initial.sql`.
3. Review the target project and run the query.
4. Store its connection string in `DATABASE_URL`.

The migration creates a non-login `ruffl_admin_role_manager` role. Do not grant that role to the API's normal database account.

Creating the first production admin is an advanced operator task. Use a separate privileged database role and an application-generated password hash:

```sql
begin;
grant ruffl_admin_role_manager to trusted_operator;
set local role trusted_operator;
insert into public.app_user (email, password_hash, display_name, role)
values ('admin@example.com', '<application-generated-hash>', 'Ruffl Support', 'admin');
commit;
```

Revoke the membership when it is no longer needed. Never expose this operation through a public API endpoint.

## Docker deployment

Docker packages the built API and its runtime into a repeatable container. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) before using these commands:

```powershell
docker build -t ruffl-api .
docker run --env-file .env -p 3000:3000 ruffl-api
```

- `docker build` creates an image named `ruffl-api`.
- `docker run` starts a container and maps computer port `3000` to container port `3000`.
- Use a production `.env`, not the development demo configuration.
- Put the API behind HTTPS using a hosting platform or reverse proxy.

## Production checklist

- Set `NODE_ENV=production`.
- Generate a unique, private `JWT_SECRET`.
- Set `SEED_DEMO_DATA=false`.
- Restrict `CORS_ORIGINS` to the exact deployed dashboard origins.
- Use a public HTTPS API URL.
- Add persistent Postgres storage before accepting real data.
- Add real R2 upload signing before accepting user files.
- Connect email, push notification, and monitoring providers.
- Use a durable/shared rate-limit store when running more than one API instance.
- Back up the database and test restoration.
- Keep the API database account separate from the privileged admin-role operator.

## Troubleshooting

- **`npm` or `node` is not recognised:** Install Node.js 22 LTS and reopen PowerShell.
- **Port 3000 is already in use:** Stop the other backend process or change `PORT` and update both frontend API URLs.
- **The phone cannot connect:** Do not use `localhost` on a physical phone. Use the computer's IPv4 address and check the firewall and Wi-Fi network.
- **The admin dashboard reports a CORS error:** Add the dashboard's exact origin to `CORS_ORIGINS`, ensure methods such as `DELETE` are permitted by the current backend code, and restart the backend.
- **Login returns 403:** Check the credentials and whether the user is suspended or deleted.
- **Login returns 429:** The IP exceeded the login-attempt limit. Wait for the window to expire; during local development, a server restart clears the in-memory counter.
- **Changes disappeared after restart:** This is expected while the in-memory repository is in use.
- **`npm install` fails:** Confirm the Node version, then run `npm install` again from this repository directory. Do not copy another repository's `node_modules`.

## Honest implementation boundary

- The application and tests currently run against an in-memory repository. The SQL migration defines the intended production structure, but a Postgres repository adapter still needs to replace the in-memory store before launch.
- Upload slots return clearly marked development URLs until Cloudflare R2 signing credentials and an S3-compatible presigner are wired in.
- Resend, Expo Push, and Sentry have environment boundaries but do not send external events yet.
- No payment processor is integrated. Deposit and milestone actions are symbolic.
- These are material production gaps, not optional polish.
