import { Pool } from 'pg';

import { hashPassword } from '../services/auth-service.js';

const connectionString =
  process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_MIGRATION_URL;
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const displayName = process.env.ADMIN_DISPLAY_NAME?.trim() || 'Ruffl Support';

if (!connectionString) {
  throw new Error('ADMIN_DATABASE_URL or DATABASE_MIGRATION_URL is required.');
}
if (!email || !email.includes('@')) {
  throw new Error('ADMIN_EMAIL must contain a valid email address.');
}
if (!password || password.length < 12 || password.length > 128) {
  throw new Error('ADMIN_PASSWORD must contain between 12 and 128 characters.');
}

const pool = new Pool({ connectionString, max: 1 });
try {
  const roleCheck = await pool.query<{ allowed: boolean }>(
    `select pg_has_role(
       current_user,
       'ruffl_admin_role_manager',
       'member'
     ) as allowed`,
  );
  if (!roleCheck.rows[0]?.allowed) {
    throw new Error(
      'The admin database user is not a member of ruffl_admin_role_manager.',
    );
  }

  const passwordHash = await hashPassword(password);
  const result = await pool.query<{ id: string; email: string }>(
    `insert into public.app_user (
       email, password_hash, display_name, role, status, email_verified_at
     ) values ($1, $2, $3, 'admin', 'active', now())
     on conflict (email) do update set
       password_hash = excluded.password_hash,
       display_name = excluded.display_name,
       role = 'admin',
       status = 'active',
       suspended_until = null,
       suspension_reason = null,
       email_verified_at = now(),
       updated_at = now()
     returning id, email`,
    [email, passwordHash, displayName],
  );
  console.log(`Admin account is ready: ${result.rows[0]?.email}`);
} finally {
  await pool.end();
}
