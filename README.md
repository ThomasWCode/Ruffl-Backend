# Ruffl API

The Ruffl API is the single source of truth for marketplace permissions and commission state. It is a Fastify/TypeScript service designed to run on the operator's own server.

## What is implemented

- Email/password signup and login with 30-day bearer tokens
- Commissioner/maker-only public signup; admin signup is rejected
- Live suspension/deletion checks on every authenticated request
- Maker profiles, discovery, open-queue filtering, and waitlists
- Request → negotiation → simulated deposit → milestones → shipping → receipt lifecycle
- Unified conversation/message model for commission, direct, dispute, and admin chat
- Five-category reviews, maker materials tracking, warnings, and notifications
- Disputes with evidence, assignment, adjudication, and closure
- Admin user moderation and read-only marketplace context
- Ten-minute CSRF tokens for browser-based admin mutations
- Upload-slot type/size validation and stable avatar/banner object keys
- A Supabase/Postgres migration with RLS enabled on every application table
- A database trigger that rejects admin-role creation/promotion unless a privileged session explicitly opts in

## Install and run

Requirements: Node.js 20.19 or newer (Node 22 LTS recommended) and npm.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

The API starts at `http://localhost:3000`. Check `GET /health`.

The local data store seeds these accounts when `SEED_DEMO_DATA=true`:

| Role | Email | Password |
|---|---|---|
| Commissioner | `commissioner@demo.ruffl` | `RufflDemo1!` |
| Maker | `maker@demo.ruffl` | `RufflDemo1!` |
| Admin | `admin@demo.ruffl` | `RufflDemo1!` |

Demo accounts are development data and must not be enabled in production.

## Test

```powershell
npm run typecheck
npm test
npm run build
```

The tests use Fastify request injection, so they do not open a port or need external services. They cover public admin escalation, immediate suspension enforcement, lifecycle permissions, and exact milestone payment allocation.

## Database setup

Run [`database/001_initial.sql`](database/001_initial.sql) against a new Supabase/Postgres database. The migration creates a non-login `ruffl_admin_role_manager` role. Do not grant that role to the API's database account. To create the first admin, use a separate privileged operator role:

```sql
begin;
grant ruffl_admin_role_manager to trusted_operator;
set local role trusted_operator;
insert into public.app_user (email, password_hash, display_name, role)
values ('admin@example.com', '<application-generated-hash>', 'Ruffl Support', 'admin');
commit;
```

Revoke the membership when it is not needed. Never expose this operation through an API endpoint.

## Production deployment

Build the included container:

```powershell
docker build -t ruffl-api .
docker run --env-file .env -p 3000:3000 ruffl-api
```

Terminate TLS at a reverse proxy and restrict `CORS_ORIGINS` to the real admin and application origins.

## Honest implementation boundary

The application and tests currently run against an in-memory repository. The SQL migration is production-ready structure, but a Postgres repository adapter still needs to replace the in-memory store before launch. Likewise, upload slots return clearly marked development URLs until Cloudflare R2 signing credentials and an S3-compatible presigner are wired in. Resend, Expo Push, and Sentry are represented by environment boundaries but do not send external events yet. No payment processor is integrated; all deposit and milestone actions are symbolic.
