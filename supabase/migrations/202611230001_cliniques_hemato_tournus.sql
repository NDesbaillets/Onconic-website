-- Deux nouvelles cliniques, « Hématologie » et « Tournus / Autre » (23.11.2026), et circuit de validation des absences visible
-- en lecture pour les médecins cadres, avec « Mon circuit de validation » pour chaque membre.
--   1. Cliniques : réglages d'absences (positions 14 et 15, Plateforme et Administration en 16 et 17), contraintes check qui listent
--      les cliniques (trainings_clinic_check...), admin_set_cdc_clinics. Les autres contrôles (admin_set_clinics, my_set_clinics,
--      validateurs, Oncoodle) lisent absence_clinic_settings.
--   2. Lecture du circuit : absence_circuit_can_view() = direction/admin, ou rôle cadre avec l'outil Absences. Les fonctions de lecture
--      (get, list, who, overview, simulate) l'acceptent ; toutes les fonctions d'écriture restent réservées à la direction et à
--      l'administration, et la simulation d'un brouillon (p_steps) aussi.
--   3. absence_circuit_mine : circuit qui s'applique à un membre (soi, ou le cadre d'une secrétaire), avec noms tronqués à 12 par étape
--      pour un non-administrateur. Le cœur du simulateur devient absence_circuit_simulate_core (interne, sans contrôle d'accès).
-- Réexécutable.
begin;

create table if not exists public.onconic_migrations(version text primary key, applied_at timestamptz not null default now());
revoke all on public.onconic_migrations from anon, authenticated;

-- 1. Cliniques ----------------------------------------------------------------------------------------------------------------

do $mig$
declare r record; def text;
begin
  -- réglages d'absences : les deux cliniques avant Plateforme et Administration
  if to_regclass('public.absence_clinic_settings') is not null then
    insert into public.absence_clinic_settings (clinic, pos) values ('Hématologie', 14), ('Tournus / Autre', 15) on conflict (clinic) do nothing;
    update public.absence_clinic_settings set pos = 16 where clinic = 'Plateforme' and pos is distinct from 16;
    update public.absence_clinic_settings set pos = 17 where clinic = 'Administration' and pos is distinct from 17;
  end if;
  -- contraintes check qui listent les cliniques (repérées par 'UTOH') : recréées avec les deux libellés
  for r in
    select c.conrelid::regclass::text as tbl, c.conname, pg_get_constraintdef(c.oid) as d
    from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace s on s.oid = t.relnamespace
    where c.contype = 'c' and s.nspname = 'public'
      and pg_get_constraintdef(c.oid) like '%''UTOH''%' and pg_get_constraintdef(c.oid) not like '%Hématologie%'
  loop
    def := replace(r.d, '''UTOH''', '''UTOH'', ''Hématologie'', ''Tournus / Autre''');
    execute format('alter table %s drop constraint %I, add constraint %I %s', r.tbl, r.conname, r.conname, def);
  end loop;
end;
$mig$;

-- Fonction qui liste les cliniques en dur (définition de 202611180003, seule la liste change)
create or replace function public.admin_set_cdc_clinics(p_user uuid, p_clinics text[])
returns text[] language plpgsql security definer set search_path = public, pg_temp as $$
declare r text; bad text;
begin
  if not public.is_direction_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select role into r from public.profiles where id = p_user;
  if r is null or r not in ('cdc', 'cadre') then raise exception 'Réservé aux membres du rôle CDC ou Cadre.'; end if;
  select c into bad from unnest(coalesce(p_clinics, '{}')) c
    where c not in ('Sénologie', 'Gynécologie', 'Urologie', 'Thoracique', 'Neuro-oncologie', 'Mélanome',
                    'GI tube', 'GI solide', 'ORL', 'Sarcomes', 'Rad-Inter', 'ION', 'UTOH', 'Hématologie', 'Tournus / Autre') limit 1;
  if bad is not null then raise exception 'Clinique inconnue : %', bad; end if;
  update public.profiles set cdc_clinics = coalesce(array(select distinct c from unnest(coalesce(p_clinics, '{}')) c order by c), '{}')
    where id = p_user;
  return (select cdc_clinics from public.profiles where id = p_user);
end;
$$;
revoke execute on function public.admin_set_cdc_clinics(uuid, text[]) from public, anon;
grant execute on function public.admin_set_cdc_clinics(uuid, text[]) to authenticated;

-- 2. Lecture du circuit ----------------------------------------------------------------------------------------------------------

-- Peut consulter le circuit : direction, administration, ou médecin cadre ayant l'outil Absences (aucun droit d'écriture)
create or replace function public.absence_circuit_can_view() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public.is_direction_admin(), false)
      or (coalesce(public.current_role_name() = 'cadre', false) and coalesce(public.tool_allowed(auth.uid(), 'absences'), false));
$$;

-- Fonctions de lecture : identiques à 202611180001, seul le contrôle d'accès change

create or replace function public.absence_circuit_get(p_circuit bigint default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare cid bigint; c public.absence_circuits;
begin
  if not public.absence_circuit_can_view() then raise exception 'Réservé à l''administration et aux médecins cadres.' using errcode = '42501'; end if;
  cid := public.absence_circuit_check_id(p_circuit);
  select * into c from public.absence_circuits where id = cid;
  return jsonb_build_object(
    'circuit', jsonb_build_object('id', c.id, 'name', c.name, 'is_default', c.is_default),
    'steps', public.absence_circuit_steps_named(cid),
    'assignments', public.absence_circuit_assignments_json(cid),
    'log', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'at', l.changed_at, 'by', l.changed_by, 'by_name', public.member_name(l.changed_by), 'action', l.action,
        'summary', case l.action
          when 'create' then 'Circuit créé'
          when 'rename' then 'Renommé : « ' || coalesce(l.before ->> 'name', '') || ' » en « ' || coalesce(l.after ->> 'name', '') || ' »'
          when 'delete' then 'Circuit supprimé'
          when 'reorder' then 'Ordre des circuits modifié'
          when 'assign' then 'Attributions (' || case l.after ->> 'type' when 'member' then 'membres' when 'role' then 'rôles' when 'all' then 'tous types' else 'cliniques' end || ') : '
                             || coalesce((select string_agg(x, ', ' order by x) from jsonb_array_elements_text(coalesce(l.after -> 'targets', '[]'::jsonb)) x), 'aucune')
          else 'Étapes actives : ' || coalesce((select string_agg(e ->> 'label', ', ' order by (e ->> 'pos')::int)
                                                from jsonb_array_elements(coalesce(l.after, '[]'::jsonb)) e where (e ->> 'active')::boolean), 'aucune') end)
        order by l.changed_at desc, l.id desc)
      from (select * from public.absence_circuit_log where circuit_id = cid order by changed_at desc, id desc limit 20) l), '[]'::jsonb));
end;
$$;

create or replace function public.absence_circuit_who() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.absence_circuit_can_view() then raise exception 'Réservé à l''administration et aux médecins cadres.' using errcode = '42501'; end if;
  return public.absence_circuit_who_core();
end;
$$;

create or replace function public.absence_circuit_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare who jsonb;
begin
  if not public.absence_circuit_can_view() then raise exception 'Réservé à l''administration et aux médecins cadres.' using errcode = '42501'; end if;
  who := public.absence_circuit_who_core();
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'is_default', c.is_default, 'pos', c.pos,
      'assignments', public.absence_circuit_assignments_json(c.id),
      'active_steps', (select count(*) from public.absence_circuit_steps s where s.circuit_id = c.id and s.active),
      'members', (select count(*) from jsonb_array_elements(who) w where (w ->> 'circuit_id')::bigint = c.id))
      order by c.is_default desc, c.pos, c.id) from public.absence_circuits c), '[]'::jsonb);
end;
$$;

-- Cœur du simulateur : aucun contrôle d'accès (fonction interne), appelé par absence_circuit_simulate et absence_circuit_mine
create or replace function public.absence_circuit_simulate_core(p_user uuid, p_from date, p_to date, p_kind text default 'vacances', p_steps jsonb default null, p_circuit bigint default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r text; cl text[]; selfx boolean; norm jsonb; circ jsonb; pre jsonb; pre_active boolean; fs jsonb; stop_people uuid[]; op uuid[];
  e jsonb; ppl uuid[]; k text; nxt text; note text; steps jsonb := '[]'::jsonb; cols jsonb; excl jsonb := '[]'::jsonb; rule_txt text; vis_admin boolean; resolved jsonb; cid bigint; cinfo jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Les dates sont invalides : la fin précède le début.'; end if;
  select role into r from public.profiles where id = p_user;
  if not found then raise exception 'Membre introuvable.'; end if;
  if p_kind is null or p_kind not in ('vacances', 'congres', 'autre') then raise exception 'Motif inconnu.'; end if;
  resolved := public.absence_circuit_resolve(p_user, p_from, p_to);
  if p_steps is null then
    -- circuit résolu pour ce membre à ces dates
    cid := (resolved ->> 'circuit_id')::bigint;
    norm := public.absence_circuit_steps_json(cid);
    cinfo := jsonb_build_object('id', cid, 'name', resolved ->> 'name', 'reason', resolved ->> 'reason', 'detail', resolved -> 'detail');
  else
    -- brouillon simulé comme le circuit p_circuit (null : le circuit général)
    cid := public.absence_circuit_check_id(p_circuit);
    norm := public.absence_circuit_normalize(p_steps);
    cinfo := jsonb_build_object('id', cid, 'name', (select name from public.absence_circuits where id = cid), 'reason', 'draft', 'detail', null);
  end if;
  cl := public.member_clinics(p_user, p_from, p_to);
  circ := public.absence_circuit_build(p_kind, p_from, p_to, norm);
  pre := (select v from jsonb_array_elements(norm) v where v ->> 'kind' = 'preavis' limit 1);
  pre_active := coalesce((pre ->> 'active')::boolean, false);
  fs := public.absence_first_stop(p_user, p_from, p_to, circ);
  if (fs -> 'step' ->> 'pos')::int = 1000 then circ := circ || jsonb_build_array(fs -> 'step'); end if;
  stop_people := coalesce(array(select x::uuid from jsonb_array_elements_text(coalesce(fs -> 'people', '[]'::jsonb)) x), '{}');
  op := case when pre_active then array(select x from unnest(public.absence_opinion_recipients(p_user)) x where not (x = any (stop_people))) else '{}'::uuid[] end;
  selfx := exists (select 1 from public.absence_validators av join public.profiles p on p.id = av.user_id
    where av.user_id = p_user and av.clinic = any (cl) and p.role in ('cadre', 'direction') and p.absence_validator and public.tool_allowed(p_user, 'absences'));

  steps := jsonb_build_array(jsonb_build_object('key', 'preavis', 'pos', 0, 'col', 0, 'kind', 'preavis', 'label', coalesce(pre ->> 'label', 'Pré-avis de la direction'),
      'rule', 'facultatif', 'rule_code', null, 'blocking', false, 'parallel_with', coalesce(fs -> 'step' ->> 'kind', 'clinique'),
      'people', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by lower(public.member_name(x))) from unnest(op) x), '[]'::jsonb),
      'note', case when not pre_active then 'Pré-avis désactivé'
                   when coalesce(array_length(op, 1), 0) > 0 then null
                   when coalesce(fs -> 'step' ->> 'kind', '') <> 'clinique' then 'Aucun pré-avis : la direction reçoit déjà la demande au visa'
                   else 'Aucun pré-avis demandé' end));

  for e in select value from jsonb_array_elements(circ) order by public.absence_step_col(value), (value ->> 'pos')::int loop
    k := e ->> 'kind';
    ppl := public.absence_step_people_for(p_user, p_from, p_to, e);
    nxt := (select x ->> 'kind' from jsonb_array_elements(circ) x where public.absence_step_col(x) > public.absence_step_col(e) and (x ->> 'blocking')::boolean
             order by public.absence_step_col(x), (x ->> 'pos')::int limit 1);
    vis_admin := k = 'visa' and exists (select 1 from public.profiles p where p.id = any (ppl) and p.role = 'admin');
    rule_txt := case
      when not (e ->> 'blocking')::boolean then 'avis demandé ; la demande n''attend pas cette étape'
      when k = 'visa' then 'un seul visa suffit ; signe le formulaire PDF'
      when k = 'groupe' and e ->> 'rule' = 'any' then 'une seule validation du groupe suffit ; un refus suffit'
      when e ->> 'rule' = 'any' then 'une seule validation suffit ; un refus suffit'
      else 'tous doivent valider ; un refus suffit' end;
    note := case
      when k = 'visa' and coalesce(array_length(ppl, 1), 0) = 0 then 'Aucun membre direction ni administrateur : personne ne peut viser'
      when k = 'visa' and vis_admin then 'Personne de la direction : le visa revient aux administrateurs'
      when k = 'clinique' and coalesce(array_length(ppl, 1), 0) = 0 and nxt = 'visa' then 'Aucun validateur actif : étape sautée, la demande va directement au visa'
      when k = 'clinique' and coalesce(array_length(ppl, 1), 0) = 0 then 'Aucun validateur actif : étape sautée, la demande passe à l''étape suivante'
      when coalesce(array_length(ppl, 1), 0) = 0 and (e ->> 'blocking')::boolean then 'Aucune personne disponible : étape sautée'
      when coalesce(array_length(ppl, 1), 0) = 0 then 'Aucune personne disponible : aucun avis demandé'
      else null end;
    steps := steps || jsonb_build_array(jsonb_build_object('key', k, 'pos', (e ->> 'pos')::int, 'col', public.absence_step_col(e), 'kind', k, 'label', e ->> 'label', 'rule', rule_txt, 'rule_code', e ->> 'rule',
      'blocking', (e ->> 'blocking')::boolean, 'parallel_with', null, 'pdf_slot', e -> 'pdf_slot',
      'people', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by lower(public.member_name(x))) from unnest(ppl) x), '[]'::jsonb),
      'note', note));
  end loop;

  -- étapes groupées par colonne (étapes simultanées) : une colonne sans personne ni visa est sautée
  cols := coalesce((select jsonb_agg(jsonb_build_object('col', g.col, 'steps', g.st,
            'note', case when exists (select 1 from jsonb_array_elements(g.st) z where z ->> 'kind' = 'visa') then null
                         when not exists (select 1 from jsonb_array_elements(g.st) z where (z ->> 'blocking')::boolean and jsonb_array_length(z -> 'people') > 0)
                              and exists (select 1 from jsonb_array_elements(g.st) z where (z ->> 'blocking')::boolean) then 'Aucune personne disponible : colonne sautée'
                         when not exists (select 1 from jsonb_array_elements(g.st) z where (z ->> 'blocking')::boolean) then 'Étapes consultatives seulement : la demande n''attend pas cette colonne' end)
            order by g.col)
          from (select (z ->> 'col')::int as col, jsonb_agg(z order by (z ->> 'pos')::int) as st from jsonb_array_elements(steps) z where z ->> 'kind' <> 'preavis' group by 1) g), '[]'::jsonb);

  select coalesce(jsonb_agg(jsonb_build_object('pos', (v ->> 'pos')::int, 'label', v ->> 'label',
           'reason', case when v -> 'kinds' is not null and jsonb_typeof(v -> 'kinds') = 'array' and not (v -> 'kinds' @> to_jsonb(p_kind)) then 'motif non concerné'
                          else 'durée inférieure au minimum' end) order by (v ->> 'pos')::int), '[]'::jsonb)
    into excl
    from jsonb_array_elements(norm) v
   where (v ->> 'active')::boolean and v ->> 'kind' <> 'preavis'
     and not exists (select 1 from jsonb_array_elements(circ) c where (c ->> 'pos')::int = (v ->> 'pos')::int);

  return jsonb_build_object(
    'member', jsonb_build_object('id', p_user, 'name', public.member_name(p_user), 'role', r),
    'clinics', to_jsonb(cl),
    'kind', p_kind,
    'circuit', cinfo,
    'resolved', jsonb_build_object('id', (resolved ->> 'circuit_id')::bigint, 'name', resolved ->> 'name', 'reason', resolved ->> 'reason', 'detail', resolved -> 'detail'),
    'steps', steps,
    'columns', cols,
    'excluded', excl,
    'admin_override', 'Un administrateur peut valider à toute étape ; sa validation conclut la demande.',
    'self_excluded', selfx);
end;
$$;

create or replace function public.absence_circuit_simulate(p_user uuid, p_from date, p_to date, p_kind text default 'vacances', p_steps jsonb default null, p_circuit bigint default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.absence_circuit_can_view() then raise exception 'Réservé à l''administration et aux médecins cadres.' using errcode = '42501'; end if;
  -- un cadre simule seulement les circuits enregistrés ; le brouillon (p_steps) reste réservé à l'administration
  if p_steps is not null and not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  return public.absence_circuit_simulate_core(p_user, p_from, p_to, p_kind, p_steps, p_circuit);
end;
$$;

-- Vue d'ensemble : appelle absence_circuit_list (même contrôle d'accès)
create or replace function public.absence_circuit_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare res jsonb; warns jsonb := '[]'::jsonb; c record; v record; st record; dir_active int; n_active int; who jsonb; w jsonb; ca record;
begin
  if not public.absence_circuit_can_view() then raise exception 'Réservé à l''administration et aux médecins cadres.' using errcode = '42501'; end if;
  select count(*) into dir_active from public.profiles p where p.role = 'direction' and public.tool_allowed(p.id, 'absences');
  if dir_active = 0 then
    warns := warns || to_jsonb('Visa et pré-avis : aucun membre direction, le visa revient aux administrateurs et aucun pré-avis n''est demandé'::text);
  end if;
  if dir_active = 0 and not exists (select 1 from public.profiles p where p.role = 'admin') then
    warns := warns || to_jsonb('Visa : aucun membre direction ni administrateur, personne ne peut viser les demandes'::text);
  end if;
  for st in select s.label, s.persons, ac.name, ac.is_default from public.absence_circuit_steps s join public.absence_circuits ac on ac.id = s.circuit_id
             where s.kind = 'personnes' and s.active order by ac.is_default desc, ac.pos, ac.id, s.pos loop
    if not exists (select 1 from unnest(st.persons) x where public.tool_allowed(x, 'absences')) then
      warns := warns || to_jsonb(case when st.is_default then '' else 'Circuit « ' || st.name || ' » : ' end
        || 'Étape « ' || st.label || ' » : aucune personne désignée n''a accès à Absences, l''étape sera sautée');
    end if;
  end loop;
  -- étapes « groupe » : aucune personne sollicitée, ou plus de 200 personnes (seules les 200 premières, par identifiant, sont sollicitées)
  for st in select s.label, s.roles, s.scope, ac.name, ac.is_default from public.absence_circuit_steps s join public.absence_circuits ac on ac.id = s.circuit_id
             where s.kind = 'groupe' and s.active order by ac.is_default desc, ac.pos, ac.id, s.pos loop
    if st.scope = 'all' then
      select count(*) into n_active from public.profiles p where p.role = any (st.roles) and public.tool_allowed(p.id, 'absences');
    else
      select coalesce(max(q.n), 0) into n_active from (
        select count(*) as n from public.profiles p, unnest(public.member_clinics(p.id)) cl
         where p.role = any (st.roles) and public.tool_allowed(p.id, 'absences') group by cl) q;
    end if;
    if n_active = 0 then
      warns := warns || to_jsonb(case when st.is_default then '' else 'Circuit « ' || st.name || ' » : ' end
        || 'Étape « ' || st.label || ' » : aucun membre des rôles choisis n''a accès à Absences, l''étape sera sautée');
    elsif n_active > 200 then
      warns := warns || to_jsonb(case when st.is_default then '' else 'Circuit « ' || st.name || ' » : ' end
        || 'Étape « ' || st.label || ' » : plus de 200 personnes concernées, seules les 200 premières (par identifiant) seront sollicitées');
    end if;
  end loop;
  -- circuits alternatifs : membre partagé entre des cliniques à circuits différents, circuit sans attribution, attribution vers un membre sans rôle ou sans accès
  who := public.absence_circuit_who_core();
  for w in select value from jsonb_array_elements(who) where (value ->> 'conflict')::boolean loop
    warns := warns || to_jsonb('Membre ' || coalesce(w ->> 'name', '?') || ' : ses cliniques mènent à des circuits différents, le circuit le mieux placé dans l''ordre (« ' || (w ->> 'circuit_name') || ' ») s''applique');
  end loop;
  for ca in select ac.id, ac.name from public.absence_circuits ac
             where not ac.is_default and not exists (select 1 from public.absence_circuit_assignments a where a.circuit_id = ac.id) order by ac.pos, ac.id loop
    warns := warns || to_jsonb('Circuit « ' || ca.name || ' » : aucune attribution, il ne s''applique à personne');
  end loop;
  for ca in select ac.name, a.target from public.absence_circuit_assignments a join public.absence_circuits ac on ac.id = a.circuit_id
             where a.target_type = 'clinic' and not exists (select 1 from public.absence_clinic_settings s where s.clinic = a.target) order by ac.pos, ac.id, a.target loop
    warns := warns || to_jsonb('Circuit « ' || ca.name || ' » : la clinique « ' || ca.target || ' » n''existe plus, cette attribution ne s''applique à personne');
  end loop;
  for ca in select ac.name, a.target from public.absence_circuit_assignments a join public.absence_circuits ac on ac.id = a.circuit_id
             where a.target_type = 'member' and a.target ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               and not exists (select 1 from public.profiles p where p.id = a.target::uuid and p.role <> 'member' and public.tool_allowed(p.id, 'absences'))
             order by ac.pos, ac.id, a.target loop
    warns := warns || to_jsonb('Circuit « ' || ca.name || ' » : ' || coalesce(public.member_name(ca.target::uuid), 'un membre') || ' est attribué mais n''a plus de rôle ou d''accès à Absences');
  end loop;
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
    'steps', public.absence_circuit_steps_named(),
    'circuits', public.absence_circuit_list(),
    'warnings', warns);
  return res;
end;
$$;

-- 3. « Mon circuit de validation » ---------------------------------------------------------------------------------------------

-- Une étape sans identifiants : 12 noms au plus, `more` = nombre de personnes restantes
create or replace function public.absence_circuit_trim_step(s jsonb, n int) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select s || jsonb_build_object(
    'people', coalesce((select jsonb_agg(jsonb_build_object('name', t.x ->> 'name') order by t.o) from jsonb_array_elements(coalesce(s -> 'people', '[]'::jsonb)) with ordinality t (x, o) where t.o <= n), '[]'::jsonb),
    'more', greatest(jsonb_array_length(coalesce(s -> 'people', '[]'::jsonb)) - n, 0));
$$;

create or replace function public.absence_circuit_trim(p jsonb, n int) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select p || jsonb_build_object(
    'steps', coalesce((select jsonb_agg(public.absence_circuit_trim_step(t.x, n) order by t.o) from jsonb_array_elements(coalesce(p -> 'steps', '[]'::jsonb)) with ordinality t (x, o)), '[]'::jsonb),
    'columns', coalesce((select jsonb_agg(t.c || jsonb_build_object('steps', coalesce((select jsonb_agg(public.absence_circuit_trim_step(u.y, n) order by u.o)
                          from jsonb_array_elements(coalesce(t.c -> 'steps', '[]'::jsonb)) with ordinality u (y, o)), '[]'::jsonb)) order by t.o)
                        from jsonb_array_elements(coalesce(p -> 'columns', '[]'::jsonb)) with ordinality t (c, o)), '[]'::jsonb));
$$;

-- Circuit qui s'appliquerait à une demande de p_days jours ouvrables à partir du prochain lundi ouvrable.
-- p_user null : soi. Un autre membre : seulement une secrétaire de ce cadre, ou la direction, l'administration et les médecins cadres.
create or replace function public.absence_circuit_mine(p_user uuid default null, p_kind text default 'vacances', p_days int default 5) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); target uuid; d1 date; d2 date; wd date[]; res jsonb;
begin
  perform public.absence_guard();
  if p_days is null or p_days < 1 or p_days > 60 then raise exception 'La durée va de 1 à 60 jours ouvrables.'; end if;
  target := coalesce(p_user, me);
  if target <> me and not (public.is_secretary_of(me, target) or public.absence_circuit_can_view()) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  -- prochain lundi (strictement après aujourd'hui), puis jours ouvrables vaudois (hors week-ends et fériés)
  d1 := public.ch_today() + (8 - extract(isodow from public.ch_today())::int);
  select array_agg(d1 + i order by i) into wd from generate_series(0, 150) i
   where extract(isodow from d1 + i) < 6 and not ((d1 + i) = any (public.vd_holiday_dates(extract(year from d1 + i)::int)));
  d2 := wd[p_days];
  d1 := wd[1];
  res := public.absence_circuit_simulate_core(target, d1, d2, p_kind, null, null)
         || jsonb_build_object('from', d1, 'to', d2, 'days', p_days);
  if not public.is_direction_admin() then
    res := public.absence_circuit_trim(res - 'admin_override', 12);
  end if;
  return res;
end;
$$;

-- Droits : fonctions internes fermées, fonctions d'interface réservées aux utilisateurs connectés
revoke execute on function
  public.absence_circuit_can_view(), public.absence_circuit_simulate_core(uuid, date, date, text, jsonb, bigint),
  public.absence_circuit_trim_step(jsonb, int), public.absence_circuit_trim(jsonb, int)
  from public, anon, authenticated;
revoke execute on function
  public.absence_circuit_get(bigint), public.absence_circuit_list(), public.absence_circuit_who(), public.absence_circuit_overview(),
  public.absence_circuit_simulate(uuid, date, date, text, jsonb, bigint), public.absence_circuit_mine(uuid, text, int)
  from public, anon;
grant execute on function
  public.absence_circuit_get(bigint), public.absence_circuit_list(), public.absence_circuit_who(), public.absence_circuit_overview(),
  public.absence_circuit_simulate(uuid, date, date, text, jsonb, bigint), public.absence_circuit_mine(uuid, text, int)
  to authenticated;

insert into public.onconic_migrations(version) values ('202611230001') on conflict do nothing;

commit;
