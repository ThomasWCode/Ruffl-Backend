create table public.admin_audit_event (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.app_user(id),
  target_user_id uuid references public.app_user(id),
  action text not null check (length(action) between 1 and 100),
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index admin_audit_created_idx
  on public.admin_audit_event(created_at desc);

alter table public.admin_audit_event enable row level security;

create function public.guard_admin_audit_immutable() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not pg_has_role(current_user, 'ruffl_admin_role_manager', 'member') then
    raise exception 'admin audit events are immutable to the runtime role';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger admin_audit_immutable_guard
before update or delete on public.admin_audit_event
for each row execute function public.guard_admin_audit_immutable();
