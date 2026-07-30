alter table public.commission
  add column status_before_dispute public.commission_status;

alter table public.commission
  add constraint commission_status_before_dispute_check
  check (
    status_before_dispute is null or
    status_before_dispute <> 'disputed'
  );

update public.commission
set status_before_dispute = 'active'
where status = 'disputed';
