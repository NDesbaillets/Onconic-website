-- Circuit de validation des absences : visualisation et simulateur (phase 1, lecture seule).
-- Réexécutable. Ne modifie aucune fonction existante.
begin;

create or replace function public.absence_circuit_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare res jsonb; warns jsonb := '[]'::jsonb; c record; v record; dir_active int; n_active int;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  select count(*) into dir_active from public.profiles p where p.role = 'direction' and public.tool_allowed(p.id, 'absences');
  if dir_active = 0 then
    warns := warns || to_jsonb('Visa et pré-avis : aucun membre direction, le visa revient aux administrateurs et aucun pré-avis n''est demandé'::text);
  end if;
  if dir_active = 0 and not exists (select 1 from public.profiles p where p.role = 'admin') then
    warns := warns || to_jsonb('Visa : aucun membre direction ni administrateur, personne ne peut viser les demandes'::text);
  end if;
  for c in select s.clinic from public.absence_clinic_settings s order by s.pos loop
    select count(*) into n_active from public.absence_validators av
      join public.profiles p on p.id = av.user_id
      where av.clinic = c.clinic and p.role in ('cadre', 'direction') and p.absence_validator and public.tool_allowed(p.id, 'absences');
    if n_active = 0 then
      warns := warns || to_jsonb('Clinique ' || c.clinic || ' : aucun validateur actif, les demandes vont directement au visa de la direction');
    end if;
    for v in select p.id, p.role, p.absence_validator, public.tool_allowed(p.id, 'absences') as tool_ok
             from public.absence_validators av join public.profiles p on p.id = av.user_id where av.clinic = c.clinic loop
      if not (v.role in ('cadre', 'direction') and v.absence_validator and v.tool_ok) then
        warns := warns || to_jsonb('Clinique ' || c.clinic || ' : ' || public.member_name(v.id) || ' est désigné mais inactif (' ||
          case when v.role not in ('cadre', 'direction') then 'rôle' when not v.absence_validator then 'case Validateur décochée' else 'outil Absences retiré' end || ')');
      end if;
    end loop;
  end loop;

  res := jsonb_build_object(
    'direction', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', public.member_name(p.id), 'has_tool', public.tool_allowed(p.id, 'absences'))
                                            order by lower(public.member_name(p.id))) from public.profiles p where p.role = 'direction'), '[]'::jsonb),
    'admins', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', public.member_name(p.id)) order by lower(public.member_name(p.id)))
                        from public.profiles p where p.role = 'admin'), '[]'::jsonb),
    'visa_fallback_admins', dir_active = 0,
    'clinics', coalesce((select jsonb_agg(x.j order by x.pos) from (
        select s.pos, jsonb_build_object(
          'clinic', s.clinic,
          'members', (select count(*) from public.profiles p where p.role <> 'member' and s.clinic = any (public.member_clinics(p.id))),
          'validators', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', public.member_name(p.id), 'role', p.role,
              'active', (p.role in ('cadre', 'direction') and p.absence_validator and public.tool_allowed(p.id, 'absences')),
              'reason', case when p.role not in ('cadre', 'direction') then 'rôle'
                             when not p.absence_validator then 'case Validateur décochée'
                             when not public.tool_allowed(p.id, 'absences') then 'outil Absences retiré' end)
              order by lower(public.member_name(p.id)))
            from public.absence_validators av join public.profiles p on p.id = av.user_id where av.clinic = s.clinic), '[]'::jsonb),
          'active_count', (select count(*) from public.absence_validators av join public.profiles p on p.id = av.user_id
              where av.clinic = s.clinic and p.role in ('cadre', 'direction') and p.absence_validator and public.tool_allowed(p.id, 'absences')),
          'goes_to', case when exists (select 1 from public.absence_validators av join public.profiles p on p.id = av.user_id
              where av.clinic = s.clinic and p.role in ('cadre', 'direction') and p.absence_validator and public.tool_allowed(p.id, 'absences'))
              then 'validators' else 'direction' end) as j
        from public.absence_clinic_settings s) x), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', public.member_name(p.id), 'role', p.role, 'clinics', to_jsonb(public.member_clinics(p.id)))
                                          order by lower(public.member_name(p.id))) from public.profiles p where p.role <> 'member'), '[]'::jsonb),
    'warnings', warns);
  return res;
end;
$$;

create or replace function public.absence_circuit_simulate(p_user uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare req uuid[]; op uuid[]; vis uuid[]; vis_admin boolean; cl text[]; selfx boolean; steps jsonb; r text;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Les dates sont invalides : la fin précède le début.'; end if;
  select role into r from public.profiles where id = p_user;
  if not found then raise exception 'Membre introuvable.'; end if;
  cl := public.member_clinics(p_user, p_from, p_to);
  req := public.absence_required_validators(p_user, p_from, p_to);
  op := array(select x from unnest(public.absence_opinion_recipients(p_user)) x where not (x = any (public.absence_validator_ids(p_user, p_from, p_to))));
  vis := public.absence_direction_recipients(p_user);
  vis_admin := exists (select 1 from public.profiles p where p.id = any (vis) and p.role = 'admin');
  selfx := exists (select 1 from public.absence_validators av join public.profiles p on p.id = av.user_id
    where av.user_id = p_user and av.clinic = any (cl) and p.role in ('cadre', 'direction') and p.absence_validator and public.tool_allowed(p_user, 'absences'));
  steps := jsonb_build_array(
    jsonb_build_object('key', 'preavis', 'label', 'Pré-avis de la direction', 'rule', 'facultatif', 'blocking', false, 'parallel_with', 'clinique',
      'people', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by lower(public.member_name(x))) from unnest(op) x), '[]'::jsonb),
      'note', case when coalesce(array_length(op, 1), 0) > 0 then null
                   when coalesce(array_length(req, 1), 0) = 0 then 'Aucun pré-avis : la direction reçoit déjà la demande au visa'
                   else 'Aucun pré-avis demandé' end),
    jsonb_build_object('key', 'clinique', 'label', 'Validateurs de clinique', 'rule', 'tous doivent valider ; un refus suffit', 'blocking', true, 'parallel_with', null,
      'people', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by lower(public.member_name(x))) from unnest(req) x), '[]'::jsonb),
      'note', case when coalesce(array_length(req, 1), 0) = 0 then 'Aucun validateur actif : étape sautée, la demande va directement au visa' end),
    jsonb_build_object('key', 'visa', 'label', 'Visa de la direction', 'rule', 'un seul visa suffit ; signe le formulaire PDF', 'blocking', true, 'parallel_with', null,
      'people', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by lower(public.member_name(x))) from unnest(vis) x), '[]'::jsonb),
      'note', case when coalesce(array_length(vis, 1), 0) = 0 then 'Aucun membre direction ni administrateur : personne ne peut viser'
                   when vis_admin then 'Personne de la direction : le visa revient aux administrateurs' end));
  return jsonb_build_object(
    'member', jsonb_build_object('id', p_user, 'name', public.member_name(p_user), 'role', r),
    'clinics', to_jsonb(cl),
    'steps', steps,
    'admin_override', 'Un administrateur peut valider à toute étape ; sa validation conclut la demande.',
    'self_excluded', selfx);
end;
$$;

revoke execute on function public.absence_circuit_overview(), public.absence_circuit_simulate(uuid, date, date) from public, anon;
grant execute on function public.absence_circuit_overview(), public.absence_circuit_simulate(uuid, date, date) to authenticated;

commit;
