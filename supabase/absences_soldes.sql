-- Absences : soldes de vacances et de congrès, absences « autres » confidentielles saisies par la direction, périmètre CHUV.
-- À exécuter après absences_export.sql. Sans danger si relancé.
--
-- Soldes (jamais bloquants : un solde insuffisant ne produit qu'un avertissement, pour la personne et pour la direction)
--  * Droits par année civile : 25 jours de vacances pour chacun ; congrès et formation : 3 jours (médecin assistant), 5 (CDC),
--    sans limite pour les médecins cadres et les autres rôles. Décompte des jours ouvrables (lundi à vendredi, fériés vaudois déduits)
--    des absences « vacances » et « congrès » demandées ou validées (les brouillons comptent pour leur auteur).
--  * La direction peut inscrire le solde restant (vacances, congrès) pour une année : absence_balances. La valeur vaut à la date de saisie
--    (as_of) : seuls les jours posés après cette date sont déduits ; une case vide revient au droit par défaut.
-- Absences « autres » : le type est un texte libre (maladie, congé maternité, service militaire, RTT, rendez-vous médical...), affiché
--    « Autre » aux autres membres ; absences.confidential cache aussi le texte aux validateurs (maladie, accident, maternité, médical).
--    Une absence confidentielle saisie par la direction ne génère pas de formulaire PDF.
-- Périmètre : la direction gère les membres de l'institution CHUV ; l'admin n'est pas limité.

-- ===== 1. Colonnes et table =====
alter table public.absences add column if not exists confidential boolean not null default false;
alter table public.absence_decision_log add column if not exists confidential boolean not null default false;

create table if not exists public.absence_balances (
  user_id uuid not null references auth.users (id) on delete cascade,
  year int not null check (year between 2000 and 2100),
  vacation_remaining numeric(5, 1),
  congress_remaining numeric(5, 1),
  as_of date not null default current_date,
  set_by uuid references auth.users (id) on delete set null,
  set_at timestamptz not null default now(),
  primary key (user_id, year)
);
alter table public.absence_balances enable row level security;
revoke all on public.absence_balances from anon, authenticated;

-- Le journal garde la confidentialité de chaque décision
create or replace function public.absence_log_decision() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.decision is null or new.decided_at is null or new.status = 'draft' then return new; end if;
  if tg_op = 'UPDATE' and new.decided_at is not distinct from old.decided_at then return new; end if;
  insert into public.absence_decision_log (absence_id, user_id, decision, kind, start_date, end_date, note, decided_by, decided_at, comment, confidential)
    values (new.id, new.user_id, new.decision, new.kind, new.start_date, new.end_date, new.note, new.decided_by, new.decided_at, new.decision_comment, new.confidential);
  return new;
end;
$$;
revoke execute on function public.absence_log_decision() from public, anon, authenticated;

-- ===== 2. Jours ouvrables vaudois =====
create or replace function public.vd_holiday_dates(p_year int) returns date[]
language plpgsql immutable set search_path = public as $$
declare a int := p_year % 19; b int := p_year / 100; c int := p_year % 100; d int := b / 4; e int := b % 4; f int := (b + 8) / 25;
  g int := (b - f + 1) / 3; h int := (19 * a + b - d - g + 15) % 30; i int := c / 4; k int := c % 4; l int := (32 + 2 * e + 2 * i - h - k) % 7;
  m int := (a + 11 * h + 22 * l) / 451; easter date; sep1 int; first_sunday int;
begin
  easter := make_date(p_year, (h + l - 7 * m + 114) / 31, ((h + l - 7 * m + 114) % 31) + 1);
  sep1 := extract(dow from make_date(p_year, 9, 1))::int;
  first_sunday := 1 + ((7 - sep1) % 7);
  return array[make_date(p_year, 1, 1), make_date(p_year, 1, 2), easter - 2, easter + 1, easter + 39, easter + 50,
               make_date(p_year, 8, 1), make_date(p_year, 9, first_sunday + 15), make_date(p_year, 12, 25)];
end;
$$;

create or replace function public.absence_workdays(p_from date, p_to date) returns int
language sql stable set search_path = public as $$
  select count(*)::int from generate_series(p_from, p_to, interval '1 day') g (d)
  where extract(isodow from g.d) < 6 and not (g.d::date = any (public.vd_holiday_dates(extract(year from g.d)::int)));
$$;

-- ===== 3. Calcul et lecture des soldes =====
create or replace function public.absence_balance_calc(p_user uuid, p_year int, p_exclude bigint default null, p_drafts boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r text; b public.absence_balances; ys date := make_date(p_year, 1, 1); ye date := make_date(p_year, 12, 31);
  vac_allow numeric := 25; cong_allow numeric; vused numeric := 0; cused numeric := 0; vfrom date; cfrom date; vbase numeric; cbase numeric;
begin
  select role into r from public.profiles where id = p_user;
  cong_allow := case r when 'clinician' then 3 when 'cdc' then 5 else null end;
  select * into b from public.absence_balances where user_id = p_user and year = p_year;
  vfrom := case when b.vacation_remaining is not null then greatest(ys, b.as_of + 1) else ys end;
  cfrom := case when b.congress_remaining is not null then greatest(ys, b.as_of + 1) else ys end;
  select coalesce(sum(public.absence_workdays(greatest(a.start_date, vfrom), least(a.end_date, ye))) filter (where a.kind = 'vacances'), 0),
         coalesce(sum(public.absence_workdays(greatest(a.start_date, cfrom), least(a.end_date, ye))) filter (where a.kind = 'congres'), 0)
    into vused, cused
    from public.absences a
    where a.user_id = p_user and a.kind in ('vacances', 'congres') and a.id is distinct from p_exclude
      and a.start_date <= ye and a.end_date >= ys
      and (a.status in ('requested', 'approved') or (p_drafts and a.status = 'draft'));
  vbase := coalesce(b.vacation_remaining, vac_allow);
  cbase := coalesce(b.congress_remaining, cong_allow);
  return jsonb_build_object('year', p_year,
    'vacation', jsonb_build_object('allowance', vac_allow, 'used', vused, 'remaining', vbase - vused, 'manual', b.vacation_remaining is not null,
                                   'as_of', case when b.vacation_remaining is not null then b.as_of end, 'from', vfrom, 'baseline', b.vacation_remaining),
    'congress', jsonb_build_object('allowance', cong_allow, 'used', cused, 'remaining', case when cbase is null then null else cbase - cused end,
                                   'unlimited', cbase is null, 'manual', b.congress_remaining is not null,
                                   'as_of', case when b.congress_remaining is not null then b.as_of end, 'from', cfrom, 'baseline', b.congress_remaining));
end;
$$;
revoke execute on function public.absence_balance_calc(uuid, int, bigint, boolean) from public, anon, authenticated;

-- Solde d'un membre : lui-même, ses validateurs et la direction
create or replace function public.absence_balance(p_user uuid default null, p_year int default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); u uuid := coalesce(p_user, auth.uid());
begin
  perform public.absence_guard();
  if u <> uid and not (public.can_validate_absence(uid, u) or public.is_direction_admin()) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  return public.absence_balance_calc(u, coalesce(p_year, extract(year from public.ch_today())::int), null, u = uid);
end;
$$;

-- Avertissement (jamais un blocage) avant d'enregistrer une absence : solde après cette absence, année par année
create or replace function public.absence_balance_check(p_user uuid, p_kind text, p_start date, p_end date, p_exclude bigint default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); u uuid := coalesce(p_user, auth.uid()); y int; bal jsonb; part jsonb; need int; rem numeric; res jsonb := '[]'::jsonb;
begin
  perform public.absence_guard();
  if u <> uid and not (public.can_validate_absence(uid, u) or public.is_direction_admin()) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  if p_kind not in ('vacances', 'congres') or p_start is null or p_end is null or p_end < p_start or p_end - p_start > 400 then return res; end if;
  for y in extract(year from p_start)::int .. extract(year from p_end)::int loop
    bal := public.absence_balance_calc(u, y, p_exclude, u = uid);
    part := bal -> case when p_kind = 'vacances' then 'vacation' else 'congress' end;
    if (part ->> 'remaining') is null then continue; end if;
    need := public.absence_workdays(greatest(p_start, (part ->> 'from')::date), least(p_end, make_date(y, 12, 31)));
    rem := (part ->> 'remaining')::numeric - need;
    if need > 0 and rem < 0 then
      res := res || jsonb_build_array(jsonb_build_object('year', y, 'kind', p_kind, 'needed', need, 'remaining_before', (part ->> 'remaining')::numeric, 'remaining_after', rem));
    end if;
  end loop;
  return res;
end;
$$;

-- ===== 4. Direction : membres CHUV, soldes =====
create or replace function public.absence_is_chuv(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = p_user and institution = 'CHUV');
$$;
revoke execute on function public.absence_is_chuv(uuid) from public, anon, authenticated;

create or replace function public.absence_manageable_members() returns table (id uuid, name text, role text, clinics text[], institution text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  return query
    select p.id, public.member_name(p.id), p.role, public.member_clinics(p.id), p.institution
    from public.profiles p
    where p.role <> 'member' and p.institution = 'CHUV' and public.tool_allowed(p.id, 'absences')
    order by lower(public.member_name(p.id));
end;
$$;

create or replace function public.absence_balances_overview(p_year int default null)
returns table (user_id uuid, name text, role text, clinics text[], vac_allowance numeric, vac_used numeric, vac_remaining numeric, vac_manual boolean,
  cong_allowance numeric, cong_used numeric, cong_remaining numeric, cong_unlimited boolean, cong_manual boolean, as_of date,
  vac_baseline numeric, cong_baseline numeric)
language plpgsql stable security definer set search_path = public as $$
declare y int := coalesce(p_year, extract(year from public.ch_today())::int); m record; b jsonb;
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  for m in select p.id, public.member_name(p.id) as nm, p.role as rl, public.member_clinics(p.id) as cl from public.profiles p
           where p.role <> 'member' and p.institution = 'CHUV' and public.tool_allowed(p.id, 'absences') order by lower(public.member_name(p.id)) loop
    b := public.absence_balance_calc(m.id, y, null, false);
    user_id := m.id; name := m.nm; role := m.rl; clinics := m.cl;
    vac_allowance := (b -> 'vacation' ->> 'allowance')::numeric; vac_used := (b -> 'vacation' ->> 'used')::numeric;
    vac_remaining := (b -> 'vacation' ->> 'remaining')::numeric; vac_manual := (b -> 'vacation' ->> 'manual')::boolean;
    cong_allowance := (b -> 'congress' ->> 'allowance')::numeric; cong_used := (b -> 'congress' ->> 'used')::numeric;
    cong_remaining := (b -> 'congress' ->> 'remaining')::numeric; cong_unlimited := (b -> 'congress' ->> 'unlimited')::boolean;
    cong_manual := (b -> 'congress' ->> 'manual')::boolean;
    as_of := coalesce((b -> 'vacation' ->> 'as_of')::date, (b -> 'congress' ->> 'as_of')::date);
    vac_baseline := (b -> 'vacation' ->> 'baseline')::numeric; cong_baseline := (b -> 'congress' ->> 'baseline')::numeric;
    return next;
  end loop;
end;
$$;

-- Inscrire le solde restant (une case vide revient au droit par défaut) ; la valeur vaut à la date du jour
create or replace function public.absence_balance_set(p_user uuid, p_year int, p_vacation numeric, p_congress numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  if p_year is null or p_year < 2000 or p_year > 2100 then raise exception 'Année invalide.'; end if;
  if not exists (select 1 from public.profiles where id = p_user and role <> 'member') then raise exception 'Membre introuvable.'; end if;
  if public.current_role_name() = 'direction' and not public.absence_is_chuv(p_user) then raise exception 'Seuls les membres de l''institution CHUV se gèrent ici.' using errcode = '42501'; end if;
  if (p_vacation is not null and (p_vacation < -100 or p_vacation > 200)) or (p_congress is not null and (p_congress < -100 or p_congress > 200)) then raise exception 'Nombre de jours invalide.'; end if;
  if p_vacation is null and p_congress is null then
    delete from public.absence_balances where user_id = p_user and year = p_year;
  else
    insert into public.absence_balances (user_id, year, vacation_remaining, congress_remaining, as_of, set_by, set_at)
      values (p_user, p_year, p_vacation, p_congress, public.ch_today(), uid, now())
      on conflict (user_id, year) do update set vacation_remaining = excluded.vacation_remaining, congress_remaining = excluded.congress_remaining,
        as_of = excluded.as_of, set_by = excluded.set_by, set_at = excluded.set_at;
  end if;
  return public.absence_balance_calc(p_user, p_year, null, false);
end;
$$;

-- ===== 5. Absences saisies par la direction : périmètre CHUV, type libre, confidentialité, avertissement de solde =====
drop function if exists public.absence_direction_add(uuid, text, text, date, date);
create or replace function public.absence_direction_add(p_user uuid, p_kind text, p_note text, p_start date, p_end date, p_confidential boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); new_id bigint; conf boolean := coalesce(p_confidential, false) and p_kind = 'autre';
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  if p_user is null or not exists (select 1 from public.profiles where id = p_user and role <> 'member') or not public.tool_allowed(p_user, 'absences') then
    raise exception 'Membre introuvable ou sans accès à Absences.';
  end if;
  if public.current_role_name() = 'direction' and not public.absence_is_chuv(p_user) then raise exception 'Seuls les membres de l''institution CHUV se gèrent ici.' using errcode = '42501'; end if;
  if p_user = uid and public.current_role_name() <> 'admin' then raise exception 'Vous ne pouvez pas valider vos propres absences.' using errcode = '42501'; end if;
  perform public.absence_check(p_user, null, p_kind, n, p_start, p_end);
  insert into public.absences (user_id, kind, note, start_date, end_date, status, submitted_at, decision, decided_by, decided_at, direction_by, direction_at, stage, confidential, form_queued_at)
    values (p_user, p_kind, n, p_start, p_end, 'approved', now(), 'approved', uid, now(), uid, now(), 1, conf, case when conf then now() end) returning id into new_id;
  if p_user <> uid then
    perform public.absence_enqueue('direction_change', p_user, array[new_id], jsonb_build_object('action', 'added', 'by', public.member_name(uid)));
  end if;
  perform public.absence_form_after(new_id);
  return jsonb_build_object('id', new_id, 'conflicts', public.absence_conflicts_json(p_user, p_start, p_end),
                            'balance', public.absence_balance_check(p_user, p_kind, p_start, p_end, new_id));
end;
$$;

drop function if exists public.absence_direction_update(bigint, text, text, date, date);
create or replace function public.absence_direction_update(p_id bigint, p_kind text, p_note text, p_start date, p_end date, p_confidential boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); a public.absences; conf boolean;
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if a.status <> 'approved' then raise exception 'Seule une absence validée se modifie ici (une demande en cours se décide dans « À valider »).'; end if;
  if public.current_role_name() = 'direction' and not public.absence_is_chuv(a.user_id) then raise exception 'Seuls les membres de l''institution CHUV se gèrent ici.' using errcode = '42501'; end if;
  if a.user_id = uid and public.current_role_name() <> 'admin' then raise exception 'Vous ne pouvez pas modifier vos propres absences validées.' using errcode = '42501'; end if;
  perform public.absence_check(a.user_id, p_id, p_kind, n, p_start, p_end);
  conf := case when p_kind <> 'autre' then false else coalesce(p_confidential, a.confidential) end;
  update public.absences set kind = p_kind, note = n, start_date = p_start, end_date = p_end, confidential = conf,
    change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null, change_requested_at = null,
    stage = 1, direction_by = uid, direction_at = now(), notified_at = null where id = p_id;
  update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
  if a.user_id <> uid then
    perform public.absence_enqueue('direction_change', a.user_id, array[p_id], jsonb_build_object('action', 'edited', 'by', public.member_name(uid)));
  end if;
  return jsonb_build_object('id', p_id, 'conflicts', public.absence_conflicts_json(a.user_id, p_start, p_end),
                            'balance', public.absence_balance_check(a.user_id, p_kind, p_start, p_end, p_id));
end;
$$;

create or replace function public.absence_direction_cancel(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); a public.absences;
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  select * into a from public.absences where id = p_id for update;
  if not found or a.status not in ('approved', 'requested') then raise exception 'Absence introuvable ou déjà décidée.'; end if;
  if public.current_role_name() = 'direction' and not public.absence_is_chuv(a.user_id) then raise exception 'Seuls les membres de l''institution CHUV se gèrent ici.' using errcode = '42501'; end if;
  if a.user_id = uid and public.current_role_name() <> 'admin' then raise exception 'Vous annulez vos propres absences par la demande de suppression.' using errcode = '42501'; end if;
  update public.absences set status = 'cancelled', change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null,
    change_requested_at = null, stage = 1 where id = p_id;
  update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
  if a.user_id <> uid then
    perform public.absence_enqueue('direction_change', a.user_id, array[p_id], jsonb_build_object('action', 'cancelled', 'by', public.member_name(uid)));
  end if;
end;
$$;

create or replace function public.absence_grid(p_from date, p_to date)
returns table (id bigint, user_id uuid, kind text, status text, start_date date, end_date date, note text, change_type text, change_start date, change_end date)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Période invalide.'; end if;
  return query
    select a.id, a.user_id, a.kind, a.status, a.start_date, a.end_date,
           case when a.user_id = auth.uid() or public.is_direction_admin() or (not a.confidential and public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a))) then a.note end,
           a.change_type, a.change_start, a.change_end
    from public.absences a
    where a.status in ('requested', 'approved') and a.start_date <= p_to and a.end_date >= p_from
    order by a.start_date;
end;
$$;

create or replace function public.absence_list(p_user uuid default null) returns setof public.absences
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid and not (public.can_validate_absence(uid, p_user) or public.is_direction_admin()) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  return query select (jsonb_populate_record(null::public.absences, to_jsonb(a) || case when a.confidential and a.user_id <> uid and not public.is_direction_admin() then jsonb_build_object('note', null) else '{}'::jsonb end)).*
    from public.absences a where a.user_id = coalesce(p_user, uid)
    and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
    and (a.status <> 'draft' or a.user_id = uid)
    order by a.start_date desc;
end;
$$;

create or replace function public.absence_export(p_from date, p_to date)
returns table (id bigint, user_id uuid, name text, role text, clinics text[], kind text, note text, start_date date, end_date date, status text, stage int,
  change_type text, change_kind text, change_note text, change_start date, change_end date, submitted_at timestamptz, decided_at timestamptz,
  decided_by_name text, decision_comment text, approvers text, direction_name text, direction_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if not public.absence_export_allowed() then raise exception 'Réservé aux administrateurs et aux validateurs des absences.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 800 then raise exception 'Fenêtre trop longue (800 jours au plus).'; end if;
  return query
    select a.id, a.user_id, public.member_name(a.user_id), (select p.role from public.profiles p where p.id = a.user_id),
           public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, case when not a.confidential or public.is_direction_admin() then a.note end, a.start_date, a.end_date, a.status, a.stage::int,
           a.change_type, a.change_kind, a.change_note, a.change_start, a.change_end, a.submitted_at, a.decided_at,
           case when a.decided_by is null then null else public.member_name(a.decided_by) end, a.decision_comment,
           (select string_agg(public.member_name(x.validator_id) || ' (' || to_char(x.decided_at at time zone 'Europe/Zurich', 'DD.MM.YYYY HH24:MI') || ')', ', ' order by x.decided_at)
              from public.absence_approvals x where x.absence_id = a.id and x.decision = 'approved' and x.decided_at is not null),
           case when a.direction_by is null then null else public.member_name(a.direction_by) end, a.direction_at
    from public.absences a
    where a.status <> 'draft' and a.start_date <= p_to and a.end_date >= p_from
      and (public.is_direction_admin() or public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a)))
    order by public.member_name(a.user_id), a.start_date, a.id;
end;
$$;

create or replace function public.absence_decisions(p_from date, p_to date)
returns table (user_id uuid, name text, role text, clinics text[], decision text, kind text, note text, start_date date, end_date date,
  decided_at timestamptz, decided_by_name text, comment text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if not public.absence_export_allowed() then raise exception 'Réservé aux administrateurs et aux validateurs des absences.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 800 then raise exception 'Fenêtre trop longue (800 jours au plus).'; end if;
  return query
    select l.user_id, public.member_name(l.user_id), (select p.role from public.profiles p where p.id = l.user_id),
           public.member_clinics(l.user_id, l.start_date, l.end_date), l.decision, l.kind, case when not l.confidential or public.is_direction_admin() then l.note end, l.start_date, l.end_date, l.decided_at,
           case when l.decided_by is null then null else public.member_name(l.decided_by) end, l.comment
    from public.absence_decision_log l
    where l.start_date <= p_to and l.end_date >= p_from
      and (public.is_direction_admin() or public.can_validate_absence(auth.uid(), l.user_id, l.start_date, l.end_date))
    order by public.member_name(l.user_id), l.decided_at;
end;
$$;

-- ===== 7. Droits d'exécution =====
do $$
declare f text;
begin
  foreach f in array array[
    'absence_balance(uuid, int)', 'absence_balance_check(uuid, text, date, date, bigint)', 'absence_manageable_members()', 'absence_balances_overview(int)',
    'absence_balance_set(uuid, int, numeric, numeric)', 'absence_direction_add(uuid, text, text, date, date, boolean)',
    'absence_direction_update(bigint, text, text, date, date, boolean)', 'absence_direction_cancel(bigint)', 'absence_grid(date, date)', 'absence_list(uuid)',
    'absence_export(date, date)', 'absence_decisions(date, date)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
