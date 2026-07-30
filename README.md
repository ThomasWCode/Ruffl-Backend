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

- Email/password signup, verified-email activation, password recovery, and 30-day bearer tokens
- Commissioner/maker-only public signup; admin signup is rejected
- Live suspension/deletion checks on every authenticated request
- User-initiated deletion with active-commission protection, push-token removal, and immediate session revocation
- Maker profiles, discovery, open-queue filtering, and waitlists
- Request to negotiation to simulated deposit to milestones to shipping to receipt lifecycle
- Party cancellation before a recorded deposit; later cancellation requires a dispute and human adjudication
- Unified conversation/message model for commission, direct, dispute, and admin chat
- Five-category reviews, maker materials tracking, warnings, and notifications
- Disputes with evidence, assignment, adjudication, and closure
- Repeat dispute history for later independent issues, with the newest case shown on the commission
- Admin user moderation and read-only marketplace context
- Append-only PostgreSQL audit events for high-impact moderation and dispute actions
- Ten-minute CSRF tokens for browser-based admin mutations
- Upload-slot type/size validation, account-owned attachment URLs, and stable avatar/banner object keys
- PostgreSQL migrations, a persistent store, request-level commit/rollback, and readiness checks
- Real Cloudflare R2 upload signing; development returns a clear 503 when R2 is not configured
- Resend transactional delivery for one-use email-verification and password-reset links
- Sentry error reporting with environment, release, and trace sampling controls
- Schema validation for authentication, profiles, commissions, messages, uploads, and admin actions
- Scrypt password hashing, timing-balanced unknown-account login checks, and strict stored-hash validation
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

The development defaults in `.env.example` are enough to run the current in-memory version after replacing `JWT_SECRET`. Integration values such as `DATABASE_URL`, `R2_BUCKET`, `R2_PUBLIC_URL`, and `EMAIL_FROM` are deliberately blank locally; filling only part of an integration configuration is treated as an error instead of silently using a fake service.

| Setting | Purpose |
|---|---|
| `PORT` | Port used by the API. The default is `3000`. |
| `HOST` | `0.0.0.0` lets both this computer and devices on the local network reach the API. |
| `NODE_ENV` | Use `development` locally and `production` on a deployed server. |
| `JWT_SECRET` | Private key used to sign login tokens. Use a long random value and never publish it. |
| `BACKEND_PUBLIC_URL` | Exact public origin used in secure account links. Use `http://localhost:3000` locally and the HTTPS backend origin in production. |
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
| `RESEND_API_KEY` | Resend sending credential. It is required in production. |
| `EMAIL_FROM` | Verified sender in `Friendly name <address@domain>` form. It is required with `RESEND_API_KEY`. |
| `EXPO_ACCESS_TOKEN` | Expo account access token used to authenticate push-ticket and receipt requests. It is required in production. |
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
BACKEND_PUBLIC_URL=https://backend.ruffl.thomaswhite.me
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

RESEND_API_KEY=<resend-sending-api-key>
EMAIL_FROM=Ruffl <notifications@ruffl.thomaswhite.me>
EXPO_ACCESS_TOKEN=<expo-account-access-token>
ADMIN_EMAIL=support@ruffl.thomaswhite.me
```

- `PORT=3000` is the port inside the container.
- `HOST=0.0.0.0` is required inside Docker; Compose publishes it only to VPS loopback as `127.0.0.1:3000`.
- Nginx or Caddy should proxy `https://backend.ruffl.thomaswhite.me` to `http://127.0.0.1:3000`. Do not expose port 3000 through the Oracle firewall.
- `NODE_ENV=production` activates fail-closed configuration checks.
- `JWT_SECRET` signs sessions. Generate it with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and never rotate it without intentionally signing everyone out.
- `BACKEND_PUBLIC_URL` must be exactly `https://backend.ruffl.thomaswhite.me`; verification and reset emails open pages on this origin.
- Only the browser-hosted admin origin belongs in `CORS_ORIGINS`. The native mobile app does not need a CORS entry.
- `SEED_DEMO_DATA=false` is mandatory in production.
- `DATABASE_URL` is the restricted runtime login. `DATABASE_MIGRATION_URL` is the more privileged schema owner used briefly at container startup.
- If the same database login must do both jobs, leave `DATABASE_MIGRATION_URL` and `DATABASE_RUNTIME_ROLE` blank, but understand that this gives the API broader database authority.
- `R2_PUBLIC_URL` must be the HTTPS read origin attached to the exact bucket in `R2_BUCKET`.
- `SENTRY_DSN` is a public ingestion address from the backend Sentry project. Do not put the `sntryu_...` API auth token here.
- `RESEND_API_KEY` must be a restricted sending key. `EMAIL_FROM` must use a domain verified in Resend.
- `EXPO_ACCESS_TOKEN` authenticates backend requests to the Expo Push Service. Create it in the Expo account that owns the Ruffl EAS project and keep it only on the backend.
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

## Email verification and password recovery

Production requires verified email ownership:

- A public signup creates an unverified account and sends a 24-hour verification link.
- The API does not issue a login token until the user confirms that link.
- **Resend verification email** sends a replacement link without revealing whether an address is registered.
- **Forgot password** always returns the same message. A matching non-deleted account receives a 30-minute reset link.
- Verification, reset, and admin CSRF tokens are scoped and cannot be used as bearer sessions.
- Every bearer session is bound to the current password credential. A successful password reset immediately invalidates that link, every older reset link, and every previously issued 30-day session.
- Account-link tokens are stored in the URL fragment, removed from the address bar by the account page, and are not included in the backend request URL or normal access logs.

Local development does not require real email. With `NODE_ENV=development` and no Resend settings, new accounts are automatically verified so the basic demo remains quick to use. Recovery requests return a clearly labelled development-only link that the mobile app can open. This development convenience is never returned in production or tests.

To configure production email:

1. Create a Resend account.
2. In **Domains**, add a domain or transactional subdomain you control. Add the SPF and DKIM DNS records shown by Resend and wait until the domain is verified.
3. Create a sending-only API key.
4. Set `RESEND_API_KEY` on the VPS.
5. Set `EMAIL_FROM`, for example `Ruffl <notifications@ruffl.thomaswhite.me>`. The address must belong to the verified domain.
6. Set `BACKEND_PUBLIC_URL=https://backend.ruffl.thomaswhite.me`.
7. Restart the backend and create a non-demo test account using an inbox you control.
8. Verify signup, resend, forgot-password, successful reset, expired/reused-link rejection, and login with the new password.

Do not put the Resend API key in the mobile app, admin dashboard, GitHub Pages variables, or an `EXPO_PUBLIC_*` value.

## Expo push notifications

The backend converts new in-app notifications into Expo push deliveries when the recipient has enabled notifications on a Ruffl development, preview, or production build:

- The notification and delivery record are committed in the same database mutation.
- The worker sends queued deliveries to Expo and stores the returned ticket ID.
- It checks Expo receipts after fifteen minutes instead of treating an accepted ticket as final delivery.
- Temporary HTTP and Expo rate-limit errors are retried with exponential backoff, up to five attempts.
- `DeviceNotRegistered` permanently fails that delivery and removes the rejected token so later activity does not repeatedly target an uninstalled app.
- Completed delivery records are retained for thirty days for diagnosis.

Configure production delivery:

1. In `Ruffl-Frontend`, run `npx eas-cli@latest login` and `npx eas-cli@latest init` so `app.json` contains the EAS project ID.
2. In the Expo account settings, create an access token for the account that owns that project.
3. Enable enhanced push security for the Expo project.
4. Set the token as `EXPO_ACCESS_TOKEN` only in the backend VPS `.env`.
5. Configure Android FCM v1 and iOS APNs credentials through EAS, then create a development or preview build. Expo Go cannot verify Ruffl's remote-notification integration.
6. Sign in on that build, open **Profile**, and select **Enable push notifications**.
7. Background the app and send a direct message from the other demo role.
8. Confirm the device receives the alert and inspect the `push_delivery` row if it does not.

The current account model stores one active Expo token per user. Enabling notifications on another device replaces the previous device token. Multi-device delivery requires a separate device-registration table and is not yet implemented.

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

Most tests use Fastify request injection and do not open a port. They cover public admin escalation, malformed input, one-use email verification and password recovery, browser CORS preflights, commit/rollback, immediate suspension/deletion enforcement, private cross-account communication, notification acknowledgement, push queuing/tickets/receipts, lifecycle permissions, and exact milestone payment allocation. `postgres-store.integration.test.ts` runs against the PostgreSQL 17 service in GitHub Actions and proves that accounts, verified-email state, and messages survive an API restart; it is skipped locally when `TEST_DATABASE_URL` is absent.

`npm run dev` loads the repository's ignored `.env` file automatically. If development startup unexpectedly tries to connect to PostgreSQL, R2, or Resend, remove placeholder values from those integration settings rather than using example hostnames or credentials.

## Rate limits

Rate limits reduce automated abuse. They are applied to the client IP address, so repeated attempts from the same phone or computer share the same allowance.

| Request | Limit |
|---|---|
| All API requests | 100 requests per minute per IP |
| Signup | 5 attempts per hour per IP |
| Login | 10 attempts per 15 minutes per IP |
| Resend verification email | 3 attempts per hour per IP |
| Forgot password | 3 attempts per hour per IP |
| Submit password reset | 5 attempts per hour per IP |
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
5. Configure bucket CORS for `PUT` with the `Content-Type` header from the exact browser origins that may upload. Native Android/iOS requests are not browser CORS requests. Do not use a wildcard origin with authenticated production tools.
6. In the mobile app, open a message, milestone update, dispute, or profile and select an image. The app calls `POST /uploads/slot`, uploads the file directly to R2 using the returned headers, and sends the resulting attachment URL with the next API mutation.
7. Confirm the image appears for the other conversation participant and that an attempted URL from another account is rejected with `INVALID_MEDIA_URL`.

The API allows JPEG, PNG, WebP, and GIF images up to 10 MiB; MP4, QuickTime, and WebM videos up to 100 MiB; and the listed document types up to 25 MiB. The current mobile picker intentionally exposes images only. Signed upload URLs expire after five minutes and bind both the declared byte length and content type, so changing either makes R2 reject the PUT. The API never returns development placeholder upload URLs and rejects attachment/avatar/banner URLs outside the authenticated user's issued object path.

## Docker deployment

Docker packages the built API and its runtime into a repeatable container. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) before using these commands:

```powershell
docker build -t ruffl-api .
docker run --env-file .env -p 3000:3000 ruffl-api
```

- `docker build` creates an image named `ruffl-api`.
- `docker run` starts a container and maps computer port `3000` to container port `3000`.
- The image runs `npm run db:migrate` before `npm start`; an invalid migration stops the new container instead of starting against an unknown schema.
- Migration `004_dispute_resume.sql` records the commission status that existed before a dispute. Non-cancellation decisions restore that exact status so work can continue; a cancellation decision remains cancelled.
- Migration `005_repeat_disputes.sql` removes the original one-case-per-commission constraint so a later independent issue can be reviewed without a database error.
- Migration `006_admin_audit.sql` adds the durable moderation/dispute audit trail shown in the admin dashboard.
- Docker Compose checks `/ready`, and the deployment workflow waits up to three minutes for the new container to become healthy. A failed migration, database connection, or startup configuration therefore fails the GitHub deployment job and prints the latest API logs.
- Use a production `.env`, not the development demo configuration.
- Put the API behind HTTPS using a hosting platform or reverse proxy.

## GitHub Actions deployment to the Oracle VPS

The included workflows make `main` the production source of truth:

- **CI** runs for every pull request and every push to `main`. It installs the lockfile, starts PostgreSQL 17, runs the real persistence test, type-checks, tests, and builds.
- **Deploy Backend** listens for a successful **CI** run caused by a push to `main`. Pull-request CI can never deploy.
- Deployments are serialized, use a read-only GitHub token, and pin the third-party SSH action to the reviewed `v1.2.2` commit rather than a mutable tag.
- The VPS checks out the exact commit that passed CI, builds the image, applies migrations, and waits for `/ready` before the job succeeds.

### 1. Prepare the VPS deployment user

Install Git, Docker Engine, and the Docker Compose plugin. Follow [Docker's current operating-system installation guide](https://docs.docker.com/engine/install/) for the VPS instead of pasting an unverified third-party install script.

The deployment user must:

- be able to connect with an SSH key;
- own `~/Ruffl-Backend`;
- be able to run `docker compose` without an interactive password prompt;
- not be the `root` user;
- have the production `.env` at `~/Ruffl-Backend/.env`.

Membership of the Docker group is effectively root-level host access. Use this account and key only for Ruffl deployment, restrict who can change the `main` branch/workflows, and do not run untrusted pull-request code through this SSH key.

Clone the repository once:

```bash
cd ~
git clone https://github.com/ThomasWCode/Ruffl-Backend.git
cd Ruffl-Backend
cp .env.example .env
```

Edit `.env` directly on the VPS and complete every production value from the earlier Oracle VPS section. `.env` is ignored by Git, so the workflow's exact-commit checkout does not replace it.

Confirm the installed Compose version supports deployment health waiting:

```bash
docker compose version
```

Use Docker Compose 2.20 or newer.

### 2. Create a dedicated SSH key

On your own computer, create a key used only by GitHub Actions:

```powershell
ssh-keygen -t ed25519 -C "ruffl-github-deploy" -f .\ruffl-github-deploy
```

- Add the contents of `ruffl-github-deploy.pub` to the deployment user's `~/.ssh/authorized_keys` on the VPS.
- Keep `ruffl-github-deploy` private. Do not commit either key to a Ruffl repository.
- Test the public key before adding it to GitHub.

### 3. Add GitHub Actions secrets

In **Ruffl-Backend > Settings > Secrets and variables > Actions > Secrets**, add:

| Secret | Value |
|---|---|
| `HOST` | The Oracle VPS public IP address or SSH hostname |
| `USERNAME` | The limited deployment user's Linux username |
| `SSH_PRIVATE_KEY` | The complete multiline contents of the private deployment key |

Do not add the VPS `.env`, JWT secret, database URL, R2 keys, Resend key, Expo token, or Sentry DSN as workflow secrets. The workflow never needs those values; Docker reads them from the protected `.env` already on the VPS.

### 4. Run and verify the first deployment

1. Open the repository's **Actions** tab and confirm **CI** and **Deploy Backend** are listed.
2. Push a reviewed commit to `main`.
3. Wait for **CI** to pass. **Deploy Backend** then starts automatically.
4. Open the deployment log and confirm `docker compose ps` reports the API as healthy.
5. Check `https://backend.ruffl.thomaswhite.me/health`.
6. Check `https://backend.ruffl.thomaswhite.me/ready`; production must report `"storage":"postgres"` and `"pushDelivery":"configured"`.

There is no Pages source or starter workflow to select for the backend. GitHub discovers the two existing YAML files automatically. If Actions are disabled, enable them under **Settings > Actions > General**.

If a deployment fails, the job prints the latest 100 API log lines and leaves a red Actions result. Fix or revert through a new reviewed commit on `main`; do not force-push production history or manually point the VPS at an untested commit.

## HTTPS reverse proxy and Oracle firewall

Compose exposes the container only at `127.0.0.1:3000`, so the public domain needs one HTTPS reverse proxy. A minimal Nginx site looks like:

```nginx
server {
    listen 80;
    server_name backend.ruffl.thomaswhite.me;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

- Save the site using the path/convention for the VPS operating system, validate it with `sudo nginx -t`, then reload Nginx.
- Obtain and renew a trusted TLS certificate using [Certbot's current Nginx instructions](https://certbot.eff.org/instructions) or another maintained ACME client.
- Redirect HTTP to HTTPS after certificate setup.
- In both the Oracle Cloud network security list and the operating-system firewall, allow public TCP 80/443. Restrict TCP 22 to trusted administration addresses where practical. Do not expose TCP 3000 publicly.
- Fastify trusts one proxy hop. The example deliberately overwrites `X-Forwarded-For` with Nginx's observed client address so a direct client cannot choose the rate-limit identity.
- If the DNS record is proxied through Cloudflare, Nginx sees Cloudflare rather than the original client. Configure Cloudflare's authenticated real-IP handling before relying on per-IP rate limits, or initially use a DNS-only record. Do not simply trust arbitrary incoming `CF-Connecting-IP` headers.

After TLS is active:

```bash
curl --fail https://backend.ruffl.thomaswhite.me/health
curl --fail https://backend.ruffl.thomaswhite.me/ready
```

The first checks that the process responds. The second also checks the database connection and reports the active storage/push configuration.

## Production checklist

- Set `NODE_ENV=production`.
- Generate a unique, private `JWT_SECRET`.
- Set `SEED_DEMO_DATA=false`.
- Restrict `CORS_ORIGINS` to the exact deployed dashboard origins.
- Use a public HTTPS API URL.
- Confirm `/ready` returns `"storage":"postgres"` before routing traffic.
- Confirm the VPS has Docker Compose 2.20 or newer so the deployment's `--wait` and `--wait-timeout` checks are available.
- Create the first admin with `npm run db:bootstrap-admin`.
- Configure and test R2 upload CORS, object access, and lifecycle rules.
- Set a backend Sentry DSN and verify a test error appears in the correct environment.
- Verify the Resend sending domain and test signup verification and password recovery end to end.
- Configure an Expo access token, EAS project ID, FCM/APNs credentials, and a real-device push test before relying on out-of-app commission or support alerts.
- Use a durable/shared rate-limit store when running more than one API instance.
- Back up the database and test restoration.
- Keep the API database account separate from the privileged admin-role operator.

## Troubleshooting

- **`npm` or `node` is not recognised:** Install Node.js 22 LTS and reopen PowerShell.
- **Port 3000 is already in use:** Stop the other backend process or change `PORT` and update both frontend API URLs.
- **The phone cannot connect:** Do not use `localhost` on a physical phone. Use the computer's IPv4 address and check the firewall and Wi-Fi network.
- **The admin dashboard reports a CORS error:** Add the dashboard's exact origin to `CORS_ORIGINS`, ensure methods such as `DELETE` are permitted by the current backend code, and restart the backend.
- **Login returns 403:** Check whether the email is unverified or the user is suspended/deleted. `EMAIL_NOT_VERIFIED` means the user should request another verification email.
- **Login returns 429:** The IP exceeded the login-attempt limit. Wait for the window to expire; during local development, a server restart clears the in-memory counter.
- **`relation ... does not exist`:** Build the image with the `database/` directory and run `npm run db:migrate` using a role allowed to create the schema.
- **`new row violates row-level security`:** Set `DATABASE_RUNTIME_ROLE` to the exact runtime PostgreSQL role and rerun migrations with the privileged migration connection.
- **`Cloudflare R2 configuration is required`:** Production requires all five `R2_*` settings. Partial R2 settings are rejected.
- **`Resend email configuration is required`:** Production requires both `RESEND_API_KEY` and `EMAIL_FROM`, and the sender domain must be verified in Resend.
- **`Expo Push access configuration is required`:** Production requires `EXPO_ACCESS_TOKEN`; use an access token from the Expo account that owns the Ruffl project, not a device push token.
- **Push is enabled but no alert arrives:** Confirm the mobile build has an EAS project ID and platform credentials, the user has granted notification permission, `/ready` reports `"pushDelivery":"configured"`, and the latest `push_delivery` record has not failed with `DeviceNotRegistered`.
- **Verification/reset email never arrives:** Confirm the Resend domain is verified, inspect the Resend email log, check spam, and verify `BACKEND_PUBLIC_URL` uses the public HTTPS backend origin.
- **`MEDIA_NOT_CONFIGURED` locally:** Add R2 development credentials or test non-upload flows; fake upload URLs are no longer returned.
- **`INVALID_MEDIA_URL`:** Request a fresh upload slot while signed in and submit the returned `publicUrl`. Arbitrary websites, a different account's R2 path, query strings, and fragments are rejected.
- **Changes disappeared after restart:** `/ready` will report `"storage":"memory"` when local development is not using `DATABASE_URL`.
- **`npm install` fails:** Confirm the Node version, then run `npm install` again from this repository directory. Do not copy another repository's `node_modules`.

## Honest implementation boundary

- PostgreSQL persistence, R2 signing, Resend account email, Expo push delivery, and backend Sentry reporting are implemented, but production credentials, DNS verification, EAS platform credentials, and the first admin must still be provisioned by the operator.
- The PostgreSQL adapter keeps an in-process cache and serializes writes. Run exactly one API replica. Horizontal scaling requires replacing this cache/diff adapter with query-based repositories or coordinated cache invalidation.
- Email verification and password reset use Resend. Expo push ticket/receipt handling is implemented, but it still needs a real EAS development build and provisioned FCM/APNs credentials before delivery can be claimed on physical devices.
- Push registration currently supports one device per account; signing in and enabling notifications on another device replaces the earlier token.
- Native image selection/upload is implemented for messages, milestone progress, disputes, and profile images. Video and document selection are not exposed yet.
- Uploaded objects use unguessable paths on the configured public read domain. Anyone who obtains a complete media URL can read it, and canceling after upload can leave an unreferenced object. A future upload registry/private download-authorisation layer is required before Ruffl should accept highly sensitive identity documents.
- No payment processor is integrated. Deposit and milestone actions are symbolic.
- Database backups, restore drills, VPS firewalling, reverse-proxy configuration, and secret rotation are operator responsibilities and must be completed before accepting real user data.
