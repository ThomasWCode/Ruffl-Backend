# Ruffl API

Ruffl API is the backend for the Ruffl mobile app and admin dashboard. It is the single source of truth for accounts, permissions, commissions, messages, reviews, disputes, warnings, suspensions, and deletions.

This project uses:

- **Node.js** to run JavaScript and TypeScript outside a browser.
- **TypeScript** to add type checking to JavaScript.
- **Fastify** to receive HTTP requests and return API responses.
- **npm** to install libraries and run the scripts in `package.json`.
- **Bearer tokens** to identify a signed-in user on later requests.
- **CORS** to control which browser-based websites may call the API.
- **PostgreSQL** to keep production data across container restarts and deployments.
- **Zod** to reject malformed request bodies before they reach business logic.
- **Cloudflare R2** to issue short-lived, signed media upload URLs.
- **Sentry** to record unexpected backend errors and performance traces.
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
- PostgreSQL migrations, a persistent store, request-level commit/rollback, and readiness checks
- Real Cloudflare R2 upload signing; development returns a clear 503 when R2 is not configured
- Sentry error reporting with environment, release, and trace sampling controls
- Schema validation for authentication, profiles, commissions, messages, uploads, and admin actions
- A database trigger that rejects admin-role creation or promotion unless a privileged session explicitly opts in

## Project structure

```text
Ruffl-Backend/
|-- src/
|   |-- domain/       Shared types and business rules
|   |-- services/     Authentication and other service helpers
|   |-- database/     Migration runner and first-admin operator command
|   |-- store/        Development memory store and production PostgreSQL store
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
| `DATABASE_URL` | Normal application PostgreSQL connection. It is required in production. |
| `DATABASE_MIGRATION_URL` | Optional privileged migration connection. If blank, migrations use `DATABASE_URL`. |
| `DATABASE_RUNTIME_ROLE` | Optional restricted PostgreSQL role that receives table grants and RLS policies. |
| `DATABASE_POOL_MAX` | Maximum PostgreSQL connections held by this one API process. Default: `10`. |
| `R2_ACCOUNT_ID` | Cloudflare account identifier used by the R2 S3-compatible endpoint. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token credentials with object read/write access only to the Ruffl bucket. |
| `R2_BUCKET` | R2 bucket name, normally `ruffl-media`. |
| `R2_PUBLIC_URL` | HTTPS custom domain or public-bucket origin used to read uploaded media. |
| `RESEND_API_KEY` | Future email-service credential. |
| `EXPO_ACCESS_TOKEN` | Future Expo push-notification credential. |
| `SENTRY_DSN` | Backend project DSN. It is required in production. A DSN is not the Sentry auth token. |
| `SENTRY_ENVIRONMENT` | Environment label such as `development`, `staging`, or `production`. |
| `SENTRY_RELEASE` | Release identifier, ideally the deployed Git commit SHA. |
| `SENTRY_TRACES_SAMPLE_RATE` | Fraction from `0` to `1` of performance transactions sent to Sentry. |
| `ADMIN_EMAIL` | Email used by the one-time admin bootstrap command. |

An **origin** is only the protocol, hostname, and optional port. It does not include a page path. For example:

```dotenv
CORS_ORIGINS=http://localhost:5173,https://thomaswcode.github.io,https://admin.ruffl.example
```

- Use `http://localhost:5173` for the local admin dashboard.
- Use `https://thomaswcode.github.io` for a GitHub Pages project site. Do not append `/Ruffl-Admin-Dashboard/`.
- Use the exact HTTPS origin if the dashboard has a custom domain.
- Restart the backend after changing `.env`.

The mobile app is not subject to browser CORS, but its API URL must still point to this backend.

### Oracle VPS production `.env`

Use this shape in `~/Ruffl-Backend/.env` on the VPS. Replace every placeholder; do not copy literal example passwords or keys:

```dotenv
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
JWT_SECRET=<at-least-48-random-bytes>
CORS_ORIGINS=https://admin.ruffl.thomaswhite.me
SEED_DEMO_DATA=false

DATABASE_URL=postgresql://ruffl_runtime:<runtime-password>@<database-host>:5432/ruffl?sslmode=require
DATABASE_MIGRATION_URL=postgresql://ruffl_migrator:<migration-password>@<database-host>:5432/ruffl?sslmode=require
DATABASE_RUNTIME_ROLE=ruffl_runtime
DATABASE_POOL_MAX=10

R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_BUCKET=ruffl-media
R2_PUBLIC_URL=https://media.ruffl.thomaswhite.me

SENTRY_DSN=<ruffl-backend-project-dsn>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=ruffl-backend@<git-sha>
SENTRY_TRACES_SAMPLE_RATE=0.1

RESEND_API_KEY=
EXPO_ACCESS_TOKEN=
ADMIN_EMAIL=support@ruffl.thomaswhite.me
```

- `PORT=3000` is the port inside the container.
- `HOST=0.0.0.0` is required inside Docker; Compose publishes it only to VPS loopback as `127.0.0.1:3000`.
- Nginx or Caddy should proxy `https://backend.ruffl.thomaswhite.me` to `http://127.0.0.1:3000`. Do not expose port 3000 through the Oracle firewall.
- `NODE_ENV=production` activates fail-closed configuration checks.
- `JWT_SECRET` signs sessions. Generate it with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and never rotate it without intentionally signing everyone out.
- Only the browser-hosted admin origin belongs in `CORS_ORIGINS`. The native mobile app does not need a CORS entry.
- `SEED_DEMO_DATA=false` is mandatory in production.
- `DATABASE_URL` is the restricted runtime login. `DATABASE_MIGRATION_URL` is the more privileged schema owner used briefly at container startup.
- If the same database login must do both jobs, leave `DATABASE_MIGRATION_URL` and `DATABASE_RUNTIME_ROLE` blank, but understand that this gives the API broader database authority.
- `R2_PUBLIC_URL` must be the HTTPS read origin attached to the exact bucket in `R2_BUCKET`.
- `SENTRY_DSN` is a public ingestion address from the backend Sentry project. Do not put the `sntryu_...` API auth token here.
- `RESEND_API_KEY` and `EXPO_ACCESS_TOKEN` remain blank because those delivery adapters are not implemented yet.
- `ADMIN_EMAIL` does not create an admin by itself; use the bootstrap command below with a temporary `ADMIN_PASSWORD`.

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

- Demo data is available only with the in-memory development store and resets when the backend restarts.
- Do not set `DATABASE_URL` while using `SEED_DEMO_DATA=true`; database-backed demo seeding is deliberately rejected.
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
| `npm run db:migrate` | Applies pending SQL files and records each migration once. Run `npm run build` first. |
| `npm run db:bootstrap-admin` | Creates or resets the first admin through a privileged database connection. |
| `npm start` | Runs the already-built production JavaScript without applying migrations. |
| `npm run start:production` | Applies migrations, then starts the API; this is the Docker command. |

Run the full validation set before pushing backend changes:

```powershell
npm run typecheck
npm test
npm run build
```

Most tests use Fastify request injection and do not open a port. They cover public admin escalation, malformed input, browser CORS preflights, commit/rollback, immediate suspension/deletion enforcement, private cross-account communication, notification acknowledgement, lifecycle permissions, and exact milestone payment allocation. `postgres-store.integration.test.ts` runs against the PostgreSQL 17 service in GitHub Actions and proves that accounts and messages survive an API restart; it is skipped locally when `TEST_DATABASE_URL` is absent.

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

## Production database setup

Use PostgreSQL 15 or newer. A managed database is easier to back up and patch than running PostgreSQL in the same VPS container. Create two login roles when your provider permits it:

- A migration/operator role that owns the schema and can create the `ruffl_admin_role_manager` role.
- A restricted runtime role used only by `DATABASE_URL`.

Set the migration connection in `DATABASE_MIGRATION_URL`, the runtime connection in `DATABASE_URL`, and the runtime PostgreSQL role name in `DATABASE_RUNTIME_ROLE`. The migration runner grants that role only schema usage plus CRUD access and creates an RLS policy for each application table. Leave `DATABASE_RUNTIME_ROLE` blank only when one database owner connection must perform both jobs.

Build and apply migrations:

```powershell
npm run build
npm run db:migrate
```

The runner:

- takes a PostgreSQL advisory lock so two deployments cannot migrate concurrently;
- applies numbered files from `database/` in filename order;
- records completed files in `public.ruffl_schema_migration`;
- wraps each migration and its tracking record in one transaction;
- applies runtime grants and RLS policies when `DATABASE_RUNTIME_ROLE` is set.

Do not edit a migration after it has run in production. Add `002_description.sql`, then `003_description.sql`, and so on.

### Create the first production admin

Public signup can never create an admin. Use a temporary privileged shell session:

```powershell
$env:ADMIN_DATABASE_URL='postgresql://trusted_operator:password@host:5432/ruffl?sslmode=require'
$env:ADMIN_EMAIL='support@ruffl.thomaswhite.me'
$env:ADMIN_PASSWORD='use-a-long-unique-password'
$env:ADMIN_DISPLAY_NAME='Ruffl Support'
npm run db:bootstrap-admin
Remove-Item Env:ADMIN_PASSWORD
Remove-Item Env:ADMIN_DATABASE_URL
```

The database user in `ADMIN_DATABASE_URL` must be a member of `ruffl_admin_role_manager` and must be able to pass RLS, normally by being the schema owner. The command hashes the password inside the application and never prints it. Do not store `ADMIN_PASSWORD` in `.env`, GitHub, shell history, or this repository.

## Cloudflare R2 setup

1. Create a private bucket named `ruffl-media`.
2. Create an R2 API token restricted to object read/write for that bucket; do not use a global Cloudflare API key.
3. Attach a custom read domain such as `media.ruffl.thomaswhite.me` and require HTTPS.
4. Put the account ID, token credentials, bucket, and read domain into the five `R2_*` variables.
5. Configure bucket CORS for `PUT` with the `Content-Type` header from clients that perform browser uploads. Native Android/iOS requests are not browser CORS requests, but the web build and future browser tools are.
6. Call `POST /uploads/slot`, upload one small permitted image to the returned `uploadUrl` with the returned headers, and confirm `publicUrl` serves that exact object.

The API allows JPEG, PNG, WebP, and GIF images up to 10 MiB; MP4, QuickTime, and WebM videos up to 100 MiB; and the listed document types up to 25 MiB. Signed URLs expire after five minutes. The API never returns development placeholder upload URLs.

## Docker deployment

Docker packages the built API and its runtime into a repeatable container. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) before using these commands:

```powershell
docker build -t ruffl-api .
docker run --env-file .env -p 3000:3000 ruffl-api
```

- `docker build` creates an image named `ruffl-api`.
- `docker run` starts a container and maps computer port `3000` to container port `3000`.
- The image runs `npm run db:migrate` before `npm start`; an invalid migration stops the new container instead of starting against an unknown schema.
- Use a production `.env`, not the development demo configuration.
- Put the API behind HTTPS using a hosting platform or reverse proxy.

## Production checklist

- Set `NODE_ENV=production`.
- Generate a unique, private `JWT_SECRET`.
- Set `SEED_DEMO_DATA=false`.
- Restrict `CORS_ORIGINS` to the exact deployed dashboard origins.
- Use a public HTTPS API URL.
- Confirm `/ready` returns `"storage":"postgres"` before routing traffic.
- Create the first admin with `npm run db:bootstrap-admin`.
- Configure and test R2 upload CORS, object access, and lifecycle rules.
- Set a backend Sentry DSN and verify a test error appears in the correct environment.
- Connect email and push-notification providers before relying on out-of-app alerts.
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
- **`relation ... does not exist`:** Build the image with the `database/` directory and run `npm run db:migrate` using a role allowed to create the schema.
- **`new row violates row-level security`:** Set `DATABASE_RUNTIME_ROLE` to the exact runtime PostgreSQL role and rerun migrations with the privileged migration connection.
- **`Cloudflare R2 configuration is required`:** Production requires all five `R2_*` settings. Partial R2 settings are rejected.
- **`MEDIA_NOT_CONFIGURED` locally:** Add R2 development credentials or test non-upload flows; fake upload URLs are no longer returned.
- **Changes disappeared after restart:** `/ready` will report `"storage":"memory"` when local development is not using `DATABASE_URL`.
- **`npm install` fails:** Confirm the Node version, then run `npm install` again from this repository directory. Do not copy another repository's `node_modules`.

## Honest implementation boundary

- PostgreSQL persistence, R2 signing, and backend Sentry reporting are implemented, but the production credentials and first admin must still be provisioned by the operator.
- The PostgreSQL adapter keeps an in-process cache and serializes writes. Run exactly one API replica. Horizontal scaling requires replacing this cache/diff adapter with query-based repositories or coordinated cache invalidation.
- Resend email and Expo Push delivery are not implemented. Users receive in-app notifications and polling, but no password-reset email or out-of-app push alert exists yet.
- Media upload signing exists, but the current mobile screens do not yet contain a native file-picker/upload experience.
- No payment processor is integrated. Deposit and milestone actions are symbolic.
- Database backups, restore drills, VPS firewalling, reverse-proxy configuration, and secret rotation are operator responsibilities and must be completed before accepting real user data.
