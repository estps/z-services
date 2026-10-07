-- ============================================================================
-- add_message_rotation
-- Applied as Supabase migration `add_message_rotation` on 2026-10-07
-- (project dwstivxwyqdogzgxnidm).
--
-- Keeps public.messages bounded: when the table's physical size
-- (pg_total_relation_size) exceeds 90% of _target_bytes (default 15 GiB =
-- 16106127360 bytes), the oldest messages are deleted in 5,000-row batches
-- until the estimated live size is under the threshold.
--
-- Why an estimate in the loop: DELETE does not shrink the relation until
-- VACUUM runs, so pg_total_relation_size is a high-water mark. Stopping on
-- physical size alone would delete down to the hard floor on the first
-- over-budget run. The loop subtracts (deleted rows x average physical bytes
-- per row) from the starting size and stops at the threshold. The hard floor
-- (newest 50,000 rows are never deleted) caps any misconfiguration.
--
-- FK handling: the schema already declares
--   message_receipts.message_id  -> messages.id ON DELETE CASCADE
--   message_reports.message_id   -> messages.id ON DELETE CASCADE
--   messages.reply_to_message_id -> messages.id ON DELETE SET NULL
-- so child rows need no manual handling: receipts (transient delivery state)
-- and reports are deleted with the message, and replies are detached
-- (reply_to_message_id = NULL) instead of breaking.
--
-- Caller privileges: SECURITY DEFINER owned by postgres; EXECUTE revoked from
-- PUBLIC/anon/authenticated so it is not reachable through PostgREST.
-- pg_cron runs it weekly as postgres (job `rotate-messages`, '0 4 * * 0').
-- ============================================================================

create extension if not exists pg_cron;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create table if not exists public.message_rotation_log (
  id            bigint generated always as identity primary key,
  run_at        timestamptz not null default now(),
  deleted_count bigint      not null default 0,
  bytes_before  bigint      not null,
  bytes_after   bigint      not null
);

alter table public.message_rotation_log enable row level security;
revoke all on public.message_rotation_log from anon, authenticated;
grant select on public.message_rotation_log to service_role;

-- Rotation orders by created_at globally; existing indexes only cover
-- (conversation_id, created_at) and reply_to_message_id.
create index if not exists messages_created_at_idx
  on public.messages (created_at);
-- Supports the ON DELETE CASCADE from message_reports.
create index if not exists message_reports_message_id_idx
  on public.message_reports (message_id);

create or replace function public.rotate_messages(_target_bytes bigint default 16106127360)
returns table (deleted_count bigint, bytes_before bigint, bytes_after bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  _floor_rows    constant bigint  := 50000;   -- hard floor: never touch the newest 50k messages
  _batch_size    constant integer := 5000;    -- rows per pass
  _margin        constant numeric := 0.90;    -- rotate at 90% of the budget
  _threshold     bigint;
  _before        bigint;
  _after         bigint;
  _total_rows    bigint;
  _avg_row_cost  numeric;
  _protected_at  timestamptz;
  _victims       uuid[];
  _pass_deleted  bigint;
  _total_deleted bigint := 0;
begin
  if _target_bytes is null or _target_bytes <= 0 then
    raise exception 'rotate_messages: _target_bytes must be positive, got %', _target_bytes;
  end if;

  _threshold := floor(_target_bytes * _margin);
  _before    := pg_total_relation_size('public.messages');

  -- NOOP when already under the soft threshold.
  if _before < _threshold then
    insert into public.message_rotation_log (run_at, deleted_count, bytes_before, bytes_after)
    values (now(), 0, _before, _before);
    return query select 0::bigint, _before, _before;
    return;
  end if;

  select count(*) into _total_rows from public.messages;

  -- Hard floor: never delete any of the newest 50,000 messages.
  if _total_rows <= _floor_rows then
    insert into public.message_rotation_log (run_at, deleted_count, bytes_before, bytes_after)
    values (now(), 0, _before, _before);
    return query select 0::bigint, _before, _before;
    return;
  end if;

  _avg_row_cost := _before::numeric / _total_rows::numeric;

  -- Everything strictly older than the 50,000th newest row is eligible.
  select min(t.created_at) into _protected_at
  from (select m.created_at from public.messages m order by m.created_at desc limit _floor_rows) t;

  loop
    select array_agg(v.id) into _victims
    from (
      select m.id
      from public.messages m
      where m.created_at < _protected_at
      order by m.created_at asc, m.id asc
      limit _batch_size
    ) v;

    exit when _victims is null;

    -- FK rules (CASCADE / SET NULL) clean up message_receipts,
    -- message_reports and reply_to_message_id references automatically.
    delete from public.messages m where m.id = any(_victims);
    get diagnostics _pass_deleted = row_count;
    exit when coalesce(_pass_deleted, 0) = 0;

    _total_deleted := _total_deleted + _pass_deleted;

    -- Physical size lags deletes until VACUUM, so stop on the live-size estimate.
    exit when (_before::numeric - (_total_deleted * _avg_row_cost)) < _threshold;
  end loop;

  _after := pg_total_relation_size('public.messages');

  insert into public.message_rotation_log (run_at, deleted_count, bytes_before, bytes_after)
  values (now(), _total_deleted, _before, _after);

  return query select _total_deleted, _before, _after;
end;
$$;

-- Not a public API endpoint.
revoke all on function public.rotate_messages(bigint) from public, anon, authenticated;
grant execute on function public.rotate_messages(bigint) to service_role;

-- Weekly rotation: Sunday 04:00 UTC.
select cron.schedule('rotate-messages', '0 4 * * 0', 'select public.rotate_messages();');
