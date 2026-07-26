begin;

create extension if not exists pgcrypto;

create type public.user_role as enum ('commissioner', 'maker', 'admin');
create type public.user_status as enum ('active', 'suspended', 'deleted');
create type public.commission_status as enum (
  'pending', 'negotiating', 'price_proposed', 'accepted', 'active',
  'shipping', 'complete', 'cancelled', 'disputed'
);
create type public.milestone_status as enum ('locked', 'active', 'posted', 'complete');
create type public.conversation_kind as enum ('commission', 'direct', 'dispute', 'admin');
create type public.dispute_status as enum ('open', 'under_review', 'resolved', 'closed');

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ruffl_admin_role_manager') then
    create role ruffl_admin_role_manager nologin;
  end if;
end;
$$;

create table public.app_user (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  display_name text not null,
  role public.user_role not null,
  status public.user_status not null default 'active',
  avatar_url text,
  bio text,
  push_token text,
  suspended_until timestamptz,
  suspension_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only a database role explicitly granted membership may create or promote an admin.
create function public.guard_admin_role() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role = 'admin'
    and (tg_op = 'INSERT' or old.role is distinct from new.role)
    and not pg_has_role(current_user, 'ruffl_admin_role_manager', 'member')
  then
    raise exception 'admin role changes require a privileged database session';
  end if;
  return new;
end;
$$;

create trigger app_user_admin_guard
before insert or update of role on public.app_user
for each row execute function public.guard_admin_role();

create table public.maker_profile (
  user_id uuid primary key references public.app_user(id) on delete cascade,
  bio text not null default '',
  location text not null default '',
  specialisms text[] not null default '{}',
  base_prices jsonb not null default '{"head":0,"partial":0,"full":0}',
  add_on_prices jsonb not null default '{"movingJaw":0,"followMeEyes":0,"coolingFan":0}',
  turnaround_weeks integer not null default 0 check (turnaround_weeks >= 0),
  queue_open boolean not null default true,
  verified boolean not null default false,
  trusted boolean not null default false,
  banner_url text
);

create table public.commission (
  id uuid primary key default gen_random_uuid(),
  commissioner_id uuid not null references public.app_user(id),
  maker_id uuid not null references public.app_user(id),
  title text not null,
  suit_type text not null check (suit_type in ('head', 'partial', 'full', 'custom')),
  species text not null,
  description text not null,
  reference_notes text not null default '',
  budget numeric(12,2) not null check (budget > 0),
  proposed_price numeric(12,2),
  agreed_total numeric(12,2),
  deposit_amount numeric(12,2),
  deposit_paid boolean not null default false,
  status public.commission_status not null default 'pending',
  tracking_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (commissioner_id <> maker_id)
);

create table public.negotiation_entry (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null references public.commission(id) on delete cascade,
  author_id uuid not null references public.app_user(id),
  action text not null check (action in ('proposal', 'accepted', 'rejected')),
  amount numeric(12,2),
  note text,
  created_at timestamptz not null default now()
);

create table public.milestone (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null references public.commission(id) on delete cascade,
  position integer not null check (position >= 0),
  title text not null,
  status public.milestone_status not null default 'locked',
  payment_amount numeric(12,2) not null default 0,
  unique (commission_id, position)
);

create table public.milestone_update (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references public.milestone(id) on delete cascade,
  author_id uuid not null references public.app_user(id),
  notes text not null default '',
  attachments jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table public.conversation (
  id uuid primary key default gen_random_uuid(),
  kind public.conversation_kind not null,
  commission_id uuid references public.commission(id) on delete cascade,
  dispute_id uuid,
  created_at timestamptz not null default now()
);

create table public.conversation_participant (
  conversation_id uuid not null references public.conversation(id) on delete cascade,
  user_id uuid not null references public.app_user(id) on delete cascade,
  primary key (conversation_id, user_id)
);

create table public.message (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversation(id) on delete cascade,
  sender_id uuid not null references public.app_user(id),
  body text not null default '',
  attachments jsonb not null default '[]',
  created_at timestamptz not null default now(),
  check (length(body) > 0 or jsonb_array_length(attachments) > 0)
);

create table public.review (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null references public.commission(id) on delete cascade,
  reviewer_id uuid not null references public.app_user(id),
  reviewee_id uuid not null references public.app_user(id),
  quality smallint not null check (quality between 1 and 5),
  communication smallint not null check (communication between 1 and 5),
  accuracy smallint not null check (accuracy between 1 and 5),
  packaging smallint not null check (packaging between 1 and 5),
  timeline smallint not null check (timeline between 1 and 5),
  comment text not null default '',
  created_at timestamptz not null default now(),
  unique (commission_id, reviewer_id),
  check (reviewer_id <> reviewee_id)
);

create table public.material_entry (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null references public.commission(id) on delete cascade,
  maker_id uuid not null references public.app_user(id),
  item text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit text not null,
  cost_per_unit numeric(12,2) not null check (cost_per_unit >= 0),
  created_at timestamptz not null default now()
);

create table public.waitlist_entry (
  id uuid primary key default gen_random_uuid(),
  maker_id uuid not null references public.app_user(id) on delete cascade,
  commissioner_id uuid not null references public.app_user(id) on delete cascade,
  message text not null default '',
  created_at timestamptz not null default now(),
  unique (maker_id, commissioner_id)
);

create table public.dispute (
  id uuid primary key default gen_random_uuid(),
  commission_id uuid not null unique references public.commission(id),
  raised_by_id uuid not null references public.app_user(id),
  status public.dispute_status not null default 'open',
  assigned_admin_id uuid references public.app_user(id),
  explanation text not null,
  outcome text check (
    outcome is null or outcome in (
      'maker_favoured', 'commissioner_favoured', 'split_decision',
      'commission_cancelled', 'no_resolution'
    )
  ),
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.conversation
  add constraint conversation_dispute_fk
  foreign key (dispute_id) references public.dispute(id) on delete cascade;

create table public.dispute_evidence (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.dispute(id) on delete cascade,
  author_id uuid not null references public.app_user(id),
  message text not null default '',
  attachments jsonb not null default '[]',
  created_at timestamptz not null default now(),
  check (length(message) > 0 or jsonb_array_length(attachments) > 0)
);

create table public.admin_warning (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_user(id) on delete cascade,
  admin_id uuid not null references public.app_user(id),
  message text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.notification (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_user(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index commission_commissioner_idx on public.commission(commissioner_id, status);
create index commission_maker_idx on public.commission(maker_id, status);
create index message_conversation_created_idx on public.message(conversation_id, created_at);
create index notification_user_created_idx on public.notification(user_id, created_at desc);
create index dispute_status_created_idx on public.dispute(status, created_at);

alter table public.app_user enable row level security;
alter table public.maker_profile enable row level security;
alter table public.commission enable row level security;
alter table public.negotiation_entry enable row level security;
alter table public.milestone enable row level security;
alter table public.milestone_update enable row level security;
alter table public.conversation enable row level security;
alter table public.conversation_participant enable row level security;
alter table public.message enable row level security;
alter table public.review enable row level security;
alter table public.material_entry enable row level security;
alter table public.waitlist_entry enable row level security;
alter table public.dispute enable row level security;
alter table public.dispute_evidence enable row level security;
alter table public.admin_warning enable row level security;
alter table public.notification enable row level security;

commit;
