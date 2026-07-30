import { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { runMigrations } from '../src/database/migration-service.js';
import { hashPassword } from '../src/services/auth-service.js';
import { PostgresStore } from '../src/store/postgres-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const runtimeDatabaseUrl = databaseUrl
  ? (() => {
      const url = new URL(databaseUrl);
      url.username = 'ruffl_runtime';
      url.password = 'runtime-password';
      return url.toString();
    })()
  : undefined;

describe.skipIf(!databaseUrl)('PostgresStore integration', () => {
  beforeAll(async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await pool.query(
        `do $$
         begin
           if not exists (
             select 1 from pg_roles where rolname = 'ruffl_runtime'
           ) then
             create role ruffl_runtime login password 'runtime-password';
           end if;
         end
         $$`,
      );
      await runMigrations(databaseUrl!, undefined, 'ruffl_runtime');
      await pool.query(
        `truncate table
           public.admin_audit_event,
           public.push_delivery,
           public.notification,
           public.admin_warning,
           public.dispute_evidence,
           public.conversation_participant,
           public.message,
           public.conversation,
           public.dispute,
           public.waitlist_entry,
           public.material_entry,
           public.review,
           public.milestone_update,
           public.milestone,
           public.negotiation_entry,
           public.commission,
           public.maker_profile,
           public.app_user
         restart identity cascade`,
      );
      await pool.query(
        `insert into public.app_user (
           email, password_hash, display_name, role, status, email_verified_at
         ) values ($1, $2, 'Test Admin', 'admin', 'active', now())`,
        ['admin@example.com', await hashPassword('AdminPassword1!')],
      );
    } finally {
      await pool.end();
    }
  });

  it('retains accounts and direct messages across an API restart', async () => {
    const firstStore = await PostgresStore.connect(runtimeDatabaseUrl!);
    const firstApp = await buildApp({
      store: firstStore,
      jwtSecret: 'integration-test-secret',
    });

    const commissionerSignup = await firstApp.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'commissioner@example.com',
        password: 'Password1!',
        displayName: 'Commissioner',
        role: 'commissioner',
      },
    });
    const makerSignup = await firstApp.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        email: 'maker@example.com',
        password: 'Password1!',
        displayName: 'Maker',
        role: 'maker',
      },
    });
    expect(commissionerSignup.statusCode).toBe(201);
    expect(makerSignup.statusCode).toBe(201);

    const commissioner = commissionerSignup.json() as {
      token: string;
      user: { id: string };
    };
    const maker = makerSignup.json() as { user: { id: string } };
    const conversationResponse = await firstApp.inject({
      method: 'POST',
      url: '/conversations/direct',
      headers: { authorization: `Bearer ${commissioner.token}` },
      payload: { participantId: maker.user.id },
    });
    expect(conversationResponse.statusCode).toBe(201);
    const conversationId = conversationResponse.json().conversation.id as string;

    const messageResponse = await firstApp.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${commissioner.token}` },
      payload: { text: 'This survives a restart.' },
    });
    expect(messageResponse.statusCode).toBe(201);

    const adminLogin = await firstApp.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'admin@example.com',
        password: 'AdminPassword1!',
      },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminToken = adminLogin.json().token as string;
    const csrfToken = (
      await firstApp.inject({
        method: 'GET',
        url: '/admin/csrf',
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json().csrfToken as string;
    const warning = await firstApp.inject({
      method: 'POST',
      url: `/admin/users/${maker.user.id}/warn`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-csrf-token': csrfToken,
      },
      payload: { message: 'Persistent audit test warning.' },
    });
    expect(warning.statusCode).toBe(201);
    await firstApp.close();

    const secondStore = await PostgresStore.connect(runtimeDatabaseUrl!);
    const secondApp = await buildApp({
      store: secondStore,
      jwtSecret: 'integration-test-secret',
    });
    try {
      const makerLogin = await secondApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'maker@example.com',
          password: 'Password1!',
        },
      });
      expect(makerLogin.statusCode).toBe(200);
      const makerToken = makerLogin.json().token as string;

      const messages = await secondApp.inject({
        method: 'GET',
        url: `/conversations/${conversationId}/messages`,
        headers: { authorization: `Bearer ${makerToken}` },
      });
      expect(messages.statusCode).toBe(200);
      expect(messages.json().messages).toEqual([
        expect.objectContaining({ text: 'This survives a restart.' }),
      ]);

      const secondAdminLogin = await secondApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: {
          email: 'admin@example.com',
          password: 'AdminPassword1!',
        },
      });
      const audit = await secondApp.inject({
        method: 'GET',
        url: '/admin/audit',
        headers: {
          authorization: `Bearer ${secondAdminLogin.json().token as string}`,
        },
      });
      expect(audit.statusCode).toBe(200);
      expect(audit.json().events).toEqual([
        expect.objectContaining({
          action: 'user_warned',
          targetUserId: maker.user.id,
        }),
      ]);
    } finally {
      await secondApp.close();
    }
  });
});
