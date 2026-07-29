import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Pool } from 'pg';

const migrationPattern = /^\d+_[a-z0-9_]+\.sql$/;
const migrationLockId = 1_947_741_201;

export async function runMigrations(
  connectionString: string,
  directory = join(process.cwd(), 'database'),
  runtimeRole?: string,
): Promise<string[]> {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const appliedNow: string[] = [];

  try {
    await client.query('select pg_advisory_lock($1)', [migrationLockId]);
    await client.query(
      `create table if not exists public.ruffl_schema_migration (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );

    const applied = new Set<string>(
      (
        await client.query<{ name: string }>(
          'select name from public.ruffl_schema_migration order by name',
        )
      ).rows.map((row) => row.name),
    );
    const files = (await readdir(directory))
      .filter((file) => migrationPattern.test(file))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      if (file === '001_initial.sql') {
        const existingInitialTables = await client.query<{ count: string }>(
          `select count(*)::text as count
           from information_schema.tables
           where table_schema = 'public'
             and table_name = any($1::text[])`,
          [[
            'app_user',
            'maker_profile',
            'commission',
            'negotiation_entry',
            'milestone',
            'milestone_update',
            'conversation',
            'conversation_participant',
            'message',
            'review',
            'material_entry',
            'waitlist_entry',
            'dispute',
            'dispute_evidence',
            'admin_warning',
            'notification',
          ]],
        );
        if (existingInitialTables.rows[0]?.count === '16') {
          await client.query(
            'insert into public.ruffl_schema_migration (name) values ($1)',
            [file],
          );
          applied.add(file);
          continue;
        }
      }
      const sql = await readFile(join(directory, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(
          'insert into public.ruffl_schema_migration (name) values ($1)',
          [file],
        );
        await client.query('commit');
        appliedNow.push(file);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }

    if (runtimeRole) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(runtimeRole)) {
        throw new Error('DATABASE_RUNTIME_ROLE is not a valid Postgres role name.');
      }
      const identifier = `"${runtimeRole.replaceAll('"', '""')}"`;
      await client.query(`grant usage on schema public to ${identifier}`);
      const tableRows = await client.query<{ table_name: string }>(
        `select table_name
         from information_schema.tables
         where table_schema = 'public'
           and table_name <> 'ruffl_schema_migration'`,
      );
      for (const row of tableRows.rows) {
        const table = `"${row.table_name.replaceAll('"', '""')}"`;
        await client.query(
          `grant select, insert, update, delete on table public.${table} to ${identifier}`,
        );
        const policy = await client.query(
          `select 1
           from pg_policies
           where schemaname = 'public'
             and tablename = $1
             and policyname = 'ruffl_backend_access'`,
          [row.table_name],
        );
        if (policy.rowCount === 0) {
          await client.query(
            `create policy ruffl_backend_access
             on public.${table}
             for all
             to ${identifier}
             using (true)
            with check (true)`,
          );
        } else {
          await client.query(
            `alter policy ruffl_backend_access
             on public.${table}
             to ${identifier}
             using (true)
             with check (true)`,
          );
        }
      }
    }

    return appliedNow;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [migrationLockId]).catch(() => {});
    client.release();
    await pool.end();
  }
}
