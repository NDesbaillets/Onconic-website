-- Absences : vue d'ensemble d'une clinique sur une période (carte de chaleur annuelle du planning).
-- Pour chaque jour : nombre de membres de la clinique absents (demandes en cours comprises), seuil de la clinique et noms visibles
-- de l'appelant (absence_can_see : un cadre qui a choisi de ne pas apparaître reste compté dans l'effectif mais pas nommé).
-- Accès : membres de la clinique, validateurs de la clinique, direction et admin ; aucun autre.
-- À exécuter après absences_visibilite.sql. Sans danger si relancé.

create or replace function public.absence_load(p_clinic text, p_from date, p_to date)
returns table(day date, n integer, max_absent integer, names text[])
language plpgsql stable security definer set search_path = public as $$
declare v uuid := auth.uid(); lim int;
begin
  perform public.absence_guard();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Période invalide.'; end if;
  select s.max_absent into lim from public.absence_clinic_settings s where s.clinic = p_clinic;
  if not found then raise exception 'Clinique inconnue.'; end if;
  if not (public.is_direction_admin()
          or p_clinic = any (coalesce(public.member_clinics(v), '{}'))
          or exists (select 1 from public.absence_validators av join public.profiles q on q.id = av.user_id
                     where av.user_id = v and av.clinic = p_clinic and q.absence_validator and q.role in ('cadre', 'direction'))) then
    raise exception 'Clinique non accessible.' using errcode = '42501';
  end if;
  return query
    with days as (select g::date as d from generate_series(p_from, p_to, interval '1 day') g),
    occ as (
      select days.d, a.user_id
      from days
      join public.absences a on a.status in ('requested', 'approved') and days.d between a.start_date and a.end_date
      where p_clinic = any (coalesce(public.member_clinics(a.user_id, days.d, days.d), '{}'))
    )
    select days.d,
           count(distinct occ.user_id)::int,
           lim,
           coalesce(array_agg(distinct public.member_name(occ.user_id)) filter (where occ.user_id is not null and public.absence_can_see(occ.user_id, days.d, days.d)), '{}')
    from days left join occ on occ.d = days.d
    group by days.d order by days.d;
end;
$$;
revoke execute on function public.absence_load(text, date, date) from public, anon;
grant execute on function public.absence_load(text, date, date) to authenticated;
