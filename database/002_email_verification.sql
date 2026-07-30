alter table public.app_user
  add column if not exists email_verified_at timestamptz;

-- Accounts created before email verification existed remain usable.
update public.app_user
set email_verified_at = created_at
where email_verified_at is null;
