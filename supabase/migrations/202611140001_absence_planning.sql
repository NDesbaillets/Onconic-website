-- Absences : planning exportable (grille calendaire) avec l'effectif complet des cliniques (14.11.2026).
-- Nouvelle fonction en lecture seule absence_planning(p_from, p_to). Aucune donnée n'est modifiée. Réexécutable.
--
-- Renvoie un objet JSON :
--   members  : effectif du périmètre, y compris les personnes sans absence (id, name, role, clinics sur la fenêtre) ;
--   absences : absences validées ou en cours de validation qui chevauchent la fenêtre (les brouillons, refus et annulations sont exclus).
-- Périmètre, identique aux exports existants :
--   admin et direction : tous les membres CHUV ayant l'outil Absences ;
--   cadre validateur : les membres rattachés, sur la fenêtre, à l'une des cliniques qu'il valide, lui compris.
-- Confidentialité : la précision d'une absence confidentielle n'est rendue qu'à la direction et à la personne concernée.
begin;

create or replace function public.absence_planning(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_dir boolean;
  v_clinics text[];
  v_result jsonb;
begin
  perform public.absence_guard();
  if not public.absence_export_allowed() then raise exception 'Réservé aux administrateurs et aux validateurs des absences.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 800 then raise exception 'Fenêtre trop longue (800 jours au plus).'; end if;
  v_dir := public.is_direction_admin();
  select coalesce(array_agg(distinct av.clinic), '{}') into v_clinics
    from public.absence_validators av
    join public.profiles v on v.id = av.user_id and v.role in ('cadre', 'direction') and v.absence_validator
   where av.user_id = v_me;

  with scope as (
    select p.id, public.member_name(p.id) as name, p.role, public.member_clinics(p.id, p_from, p_to) as clinics
      from public.profiles p
     where p.role <> 'member' and coalesce(p.institution, '') = 'CHUV' and public.tool_allowed(p.id, 'absences')
  ), members as (
    select s.* from scope s where v_dir or s.clinics && v_clinics
  )
  select jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'role', m.role, 'clinics', m.clinics) order by lower(m.name)) from members m), '[]'::jsonb),
    'absences', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', a.user_id, 'kind', a.kind,
               'note', case when not a.confidential or v_dir or a.user_id = v_me then a.note end,
               'start_date', a.start_date, 'end_date', a.end_date, 'status', a.status, 'stage', a.stage, 'change_type', a.change_type)
             order by a.start_date, a.id)
        from public.absences a
       where a.status in ('requested', 'approved') and a.start_date <= p_to and a.end_date >= p_from
         and a.user_id in (select m.id from members m)), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke execute on function public.absence_planning(date, date) from public, anon;
grant execute on function public.absence_planning(date, date) to authenticated;

do $$
begin
  if to_regclass('public.onconic_migrations') is not null then
    insert into public.onconic_migrations(version) values ('202611140001') on conflict do nothing;
  end if;
end $$;

commit;
