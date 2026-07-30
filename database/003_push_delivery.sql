create table public.push_delivery (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null unique references public.notification(id) on delete cascade,
  user_id uuid not null references public.app_user(id) on delete cascade,
  push_token text not null,
  status text not null check (status in ('queued', 'sent', 'delivered', 'failed')),
  receipt_id text,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);

create index push_delivery_due_idx
  on public.push_delivery(status, next_attempt_at);

alter table public.push_delivery enable row level security;
