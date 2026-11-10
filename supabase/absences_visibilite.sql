-- Absences : chacun ne voit que les membres de ses cliniques ; un cadre peut choisir de ne pas apparaître.
-- Règle (absence_can_see) : on se voit toujours soi-même ; l'admin et la direction voient tout le monde ; un validateur voit tous les
-- membres des cliniques qu'il valide, cadres compris ; tout autre usager voit les membres qui partagent au moins une de ses cliniques
-- (sur la période concernée), sauf les médecins cadres qui ont décoché « Apparaître dans le planning de ma clinique » (Mon compte).
-- Appliquée au planning (absence_people, absence_grid) et aux noms cités dans l'avertissement de chevauchement (absence_conflicts :
-- les effectifs restent comptés, seuls les noms masqués disparaissent). Les appels du serveur (sans utilisateur) ne sont pas filtrés.
-- À exécuter après admin_direction.sql et absences_soldes.sql. Sans danger si relancé.

alter table public.profiles add column if not exists absence_visible boolean not null default true;

create or replace function public.absence_can_see(p_target uuid, p_from date default null, p_to date default null)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v uuid := auth.uid(); vc text[]; tc text[]; hidden boolean;
begin
  if v is null or v = p_target or public.is_direction_admin() then return true; end if;
  if p_from is null then
    vc := coalesce(public.member_clinics(v), '{}');
    tc := coalesce(public.member_clinics(p_target), '{}');
  else
    vc := coalesce(public.member_clinics(v, p_from, coalesce(p_to, p_from)), '{}');
    tc := coalesce(public.member_clinics(p_target, p_from, coalesce(p_to, p_from)), '{}');
  end if;
  -- Un validateur voit tous les membres des cliniques qu'il valide
  if exists (select 1 from public.absence_validators av join public.profiles q on q.id = av.user_id
             where av.user_id = v and q.absence_validator and q.role in ('cadre', 'direction') and av.clinic = any (tc)) then
    return true;
  end if;
  if not (vc && tc) then return false; end if;
  select (p.role = 'cadre' and not p.absence_visible) into hidden from public.profiles p where p.id = p_target;
  return not coalesce(hidden, false);
end;
$$;
revoke execute on function public.absence_can_see(uuid, date, date) from public, anon;
grant execute on function public.absence_can_see(uuid, date, date) to authenticated;

create or replace function public.absence_people()
returns table(id uuid, name text, role text, clinics text[], is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  return query
    select p.id, public.member_name(p.id), p.role, public.member_clinics(p.id), p.id = auth.uid()
    from public.profiles p
    where p.role <> 'member' and public.tool_allowed(p.id, 'absences') and public.absence_can_see(p.id)
    order by lower(public.member_name(p.id));
end;
$$;

create or replace function public.absence_grid(p_from date, p_to date)
returns table(id bigint, user_id uuid, kind text, status text, start_date date, end_date date, note text, change_type text, change_start date, change_end date)
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
      and public.absence_can_see(a.user_id, public.absence_lo(a), public.absence_hi(a))
    order by a.start_date;
end;
$$;

create or replace function public.absence_conflicts(p_user uuid, p_start date, p_end date)
returns table(clinic text, max_absent integer, peak integer, first_day date, last_day date, others text[])
language sql stable security definer set search_path = public as $$
  with days as (select d::date as d from generate_series(p_start, p_end, interval '1 day') d),
  occ as (
    select m.clinic, days.d, a.user_id
    from days
    cross join lateral unnest(public.member_clinics(p_user, days.d, days.d)) as m (clinic)
    join public.absences a on a.status in ('requested', 'approved') and a.user_id <> p_user and days.d between a.start_date and a.end_date
    where m.clinic = any (public.member_clinics(a.user_id, days.d, days.d))
  ),
  per_day as (select o.clinic, o.d, count(distinct o.user_id)::int as n from occ o group by o.clinic, o.d),
  over_days as (
    select pd.clinic, pd.d, pd.n, s.max_absent
    from per_day pd join public.absence_clinic_settings s on s.clinic = pd.clinic where pd.n + 1 > s.max_absent
  )
  select od.clinic, od.max_absent, max(od.n) + 1, min(od.d), max(od.d),
    (select array_agg(distinct public.member_name(o.user_id)) from occ o
       where o.clinic = od.clinic and o.d in (select x.d from over_days x where x.clinic = od.clinic)
         and public.absence_can_see(o.user_id, o.d, o.d))
  from over_days od group by od.clinic, od.max_absent;
$$;

-- Réglage du cadre (Mon compte) : apparaître ou non dans le planning de ma clinique, pour les usagers ordinaires
create or replace function public.my_absence_visibility() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); r text; v boolean;
begin
  if uid is null then raise exception 'Connexion requise.' using errcode = '42501'; end if;
  select role, absence_visible into r, v from public.profiles where id = uid;
  return jsonb_build_object('role', r, 'editable', r = 'cadre', 'visible', coalesce(v, true));
end;
$$;

create or replace function public.my_set_absence_visible(p_visible boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); r text;
begin
  select role into r from public.profiles where id = uid;
  if r is distinct from 'cadre' then raise exception 'Réglage réservé aux médecins cadres.' using errcode = '42501'; end if;
  update public.profiles set absence_visible = coalesce(p_visible, true) where id = uid;
  return coalesce(p_visible, true);
end;
$$;
revoke execute on function public.my_absence_visibility() from public, anon;
revoke execute on function public.my_set_absence_visible(boolean) from public, anon;
grant execute on function public.my_absence_visibility() to authenticated;
grant execute on function public.my_set_absence_visible(boolean) to authenticated;
