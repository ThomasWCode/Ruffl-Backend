alter table public.dispute
  drop constraint if exists dispute_commission_id_key;

create index if not exists dispute_commission_created_idx
  on public.dispute(commission_id, created_at desc);
