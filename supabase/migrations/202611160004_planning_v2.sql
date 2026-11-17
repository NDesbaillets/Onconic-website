-- Planning admin V2 (16.11.2026). Transactionnel et réexécutable. Suppose 202611160003.
--
-- 1. Lien avec l'app Absences : pour une ligne reliée à un compte, les absences demandées ou validées de ce compte
--    sont renvoyées par plan_grid (tableau « absences ») et s'affichent là où aucune case n'a été posée à la main.
--    vacances → V, congrès → CONG, autre → CA (privé). Le motif reste masqué (« ABS ») pour les lecteurs, comme les cases.
--    Pour un lecteur, une absence n'apparaît que si la personne l'a rendue visible dans Absences (profiles.absence_visible).
-- 2. Historique : chaque changement de case est journalisé (plan_cells_log), consultable par les éditeurs (plan_history).
-- 3. « Mon planning » : abonnement agenda personnel (plan_calendar_token, flux servi par l'Edge Function plan-feed),
--    avec le même jeton secret que les autres flux personnels (calendar_tokens).
begin;

insert into public.plan_codes (code, label, grp, bg, fg, kind, private, position)
values ('CONG', 'Congrès', 'Absences', '#CCFF99', '#000000', 'absence', false, 85)
on conflict (code) do nothing;

-- ----- Historique des cases -----
create table if not exists public.plan_cells_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid references auth.users (id) on delete set null,
  staff_id bigint not null references public.plan_staff (id) on delete cascade,
  day date not null,
  half smallint not null,
  old_code text,
  new_code text
);
create index if not exists plan_cells_log_staff on public.plan_cells_log (staff_id, at desc);
alter table public.plan_cells_log enable row level security;
revoke all on public.plan_cells_log from anon, authenticated;

create or replace function public.plan_cells_audit() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if tg_op = 'DELETE' then
    insert into public.plan_cells_log (actor, staff_id, day, half, old_code, new_code) values (auth.uid(), old.staff_id, old.day, old.half, old.code, null);
    return old;
  elsif tg_op = 'UPDATE' then
    if old.code is distinct from new.code then
      insert into public.plan_cells_log (actor, staff_id, day, half, old_code, new_code) values (auth.uid(), new.staff_id, new.day, new.half, old.code, new.code);
    end if;
  else
    insert into public.plan_cells_log (actor, staff_id, day, half, old_code, new_code) values (auth.uid(), new.staff_id, new.day, new.half, null, new.code);
  end if;
  return new;
end;
$$;
revoke execute on function public.plan_cells_audit() from public, anon, authenticated;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'plan_cells_audit' and tgrelid = 'public.plan_cells'::regclass) then
    create trigger plan_cells_audit after insert or update or delete on public.plan_cells for each row execute function public.plan_cells_audit();
  end if;
end $$;

create or replace function public.plan_history(p_staff bigint, p_limit integer default 100) returns table (
  at timestamptz, actor text, day date, half smallint, old_code text, new_code text)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.can_edit_planning() then raise exception 'Réservé aux cadres administratifs.' using errcode = '42501'; end if;
  return query select l.at, coalesce(public.member_name(l.actor), 'import ou système'), l.day, l.half, l.old_code, l.new_code
    from public.plan_cells_log l where l.staff_id = p_staff
    order by l.at desc, l.id desc limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

-- ----- Absences reliées : une ligne par jour ouvrable -----
create or replace function public.plan_absence_days(p_from date, p_to date, p_edit boolean, p_me uuid) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_array(s.id, d::date, x.code, a.status) order by s.id, d), '[]'::jsonb)
  from public.plan_staff s
  join public.profiles p on p.id = s.user_id
  join public.absences a on a.user_id = s.user_id and a.status in ('requested', 'approved')
       and a.start_date <= p_to and a.end_date >= p_from
  cross join lateral (select case a.kind when 'vacances' then 'V' when 'congres' then 'CONG' else 'CA' end as raw) k
  join public.plan_codes c on c.code = k.raw
  cross join lateral (select case when c.private and not p_edit and s.user_id is distinct from p_me then 'ABS' else k.raw end as code) x
  cross join lateral generate_series(greatest(a.start_date, p_from), least(a.end_date, p_to), interval '1 day') d
  where extract(isodow from d) <= 5
    and (s.start_date is null or d::date >= s.start_date) and (s.end_date is null or d::date <= s.end_date)
    and (p_edit or s.user_id = p_me or coalesce(p.absence_visible, true));
$$;
revoke execute on function public.plan_absence_days(date, date, boolean, uuid) from public, anon, authenticated;

create or replace function public.plan_grid(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare v_edit boolean; v_me uuid := auth.uid();
begin
  if not public.tool_allowed(auth.uid(), 'planning') then raise exception 'Réservé aux membres ayant l''outil Planning.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 400 then raise exception 'Fenêtre trop longue (400 jours au plus).'; end if;
  v_edit := public.can_edit_planning();
  return jsonb_build_object(
    'editor', v_edit,
    'codes', coalesce((select jsonb_agg(jsonb_build_object('code', c.code, 'label', c.label, 'grp', c.grp, 'bg', c.bg, 'fg', c.fg,
        'kind', c.kind, 'private', c.private, 'position', c.position, 'active', c.active) order by c.position, c.code) from public.plan_codes c), '[]'::jsonb),
    'coverage', (select s.coverage from public.plan_settings s where s.id = 1),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'first_name', s.first_name, 'last_name', s.last_name, 'team', s.team,
        'bloc', s.bloc, 'pct', s.pct, 'resp', s.resp, 'status', s.status, 'start_date', s.start_date, 'end_date', s.end_date,
        'off', s.off_slots, 'week', case when v_edit then to_jsonb(s.week) end, 'me', s.user_id = v_me, 'linked', s.user_id is not null,
        'user_id', case when v_edit then s.user_id end, 'account', case when v_edit then public.member_name(s.user_id) end)
        order by s.position, lower(s.last_name), lower(s.first_name))
      from public.plan_staff s
      where (s.start_date is null or s.start_date <= p_to) and (s.end_date is null or s.end_date >= p_from)), '[]'::jsonb),
    'cells', coalesce((select jsonb_agg(jsonb_build_array(x.staff_id, x.day, x.half,
        case when c.private and not v_edit and s.user_id is distinct from v_me then 'ABS' else x.code end))
      from public.plan_cells x join public.plan_codes c on c.code = x.code join public.plan_staff s on s.id = x.staff_id
      where x.day between p_from and p_to), '[]'::jsonb),
    'absences', public.plan_absence_days(p_from, p_to, v_edit, v_me)
  );
end;
$$;

-- ----- « Mon planning » : abonnement agenda -----
create or replace function public.plan_calendar_token(p_reset boolean default false) returns text
language plpgsql security definer set search_path to 'public' as $$
declare t text;
begin
  if auth.uid() is null or not public.tool_allowed(auth.uid(), 'planning') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.plan_staff where user_id = auth.uid()) then
    raise exception 'Aucune ligne du planning n''est reliée à votre compte : demandez-le à un cadre administratif.';
  end if;
  if p_reset then delete from public.calendar_tokens where user_id = auth.uid(); end if;
  insert into public.calendar_tokens (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  select token into t from public.calendar_tokens where user_id = auth.uid();
  return t;
end;
$$;

-- Flux du service plan-feed : les cases (et absences reliées) de la ligne du membre, de J-30 à J+180
create or replace function public.plan_calendar_feed(p_token text) returns table (day date, half smallint, code text, label text, source text, status text)
language sql stable security definer set search_path to 'public' as $$
  with me as (
    select t.user_id, s.id as staff_id from public.calendar_tokens t join public.plan_staff s on s.user_id = t.user_id
    where t.token = p_token and public.tool_allowed(t.user_id, 'planning')
  ), win as (select public.ch_date() - 30 as f, public.ch_date() + 180 as t)
  select x.day, x.half, x.code, c.label, 'planning', null::text
    from me join public.plan_cells x on x.staff_id = me.staff_id join public.plan_codes c on c.code = x.code, win
    where x.day between win.f and win.t
  union all
  select (a->>1)::date, h::smallint, a->>2, c.label, 'absences', a->>3
    from me, win, jsonb_array_elements(public.plan_absence_days(win.f, win.t, true, me.user_id)) a
    cross join generate_series(0, 1) h
    join public.plan_codes c on c.code = a->>2
    where (a->>0)::bigint = me.staff_id
      and not exists (select 1 from public.plan_cells y where y.staff_id = me.staff_id and y.day = (a->>1)::date and y.half = h)
  order by 1, 2;
$$;
revoke execute on function public.plan_calendar_feed(text) from public, anon, authenticated;
grant execute on function public.plan_calendar_feed(text) to service_role;

revoke execute on function public.plan_history(bigint, integer), public.plan_calendar_token(boolean) from public, anon;
grant execute on function public.plan_history(bigint, integer), public.plan_calendar_token(boolean) to authenticated;

do $$
begin
  if to_regclass('public.onconic_migrations') is not null then
    insert into public.onconic_migrations(version) values ('202611160004') on conflict do nothing;
  end if;
end $$;

commit;
