-- Absences : étape « cheffe de service » sur décision de la direction, suivi pour la direction, PDF à tout moment.
-- Transactionnel et réexécutable. À appliquer après 202611230001. Reprend les définitions les plus récentes des fonctions modifiées
-- (202611110001, 202611180001, 202611180002, 202611230001), seuls les passages signalés par « on_demand », « escalated » ou « escalation » changent.
--
-- 1. Étape sur décision de la direction (absence_circuit_steps.on_demand)
--    * Une étape « personnes » ou « groupe » bloquante, placée dans une colonne après celle du visa, peut être marquée « sur décision de la direction ».
--      Sans décision, la demande la saute : le visa conclut la demande comme avant (statut final, PDF, file du formulaire, Ultragenda).
--    * absence_visa_escalate(id, note) : la personne qui peut viser la demande enregistre son visa et envoie la demande à l'étape (cheffe de service).
--      absences.escalated_at / escalated_by / escalation_note gardent la trace ; effacés à l'ouverture d'une nouvelle ronde.
--    * L'instantané absences.circuit porte on_demand ; absence_circuit_public masque l'étape tant que la demande n'a pas été envoyée.
--    * Nouveau message de la boîte d'envoi : escalated (information au demandeur).
-- 2. Suivi de la direction : absence_track(du, au) (direction et administration), avec le parcours détaillé de chaque demande.
-- 4. Types de notification (notification_kinds_for) : `escalated` pour les personnes qui reçoivent des décisions, et les personnes désignées dans une étape
--    « personnes » active reçoivent aussi les types to_validate et to_validate_change (préférences de Mon compte).
-- 3. PDF à tout moment : absence_pdf_access / absence_form_current (appelées par notify-absence), absence_document_build.
begin;

-- 1. Colonnes ------------------------------------------------------------------------------------------------------------------

-- Étape par défaut « Validation de la cheffe de service » (inactive, sans personne) : devient une étape sur décision de la direction, active, au seul premier
-- passage (ajout effectif de la colonne). Personne n'est désigné ici : l'administration la désigne dans la page du circuit.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'absence_circuit_steps' and column_name = 'on_demand') then
    alter table public.absence_circuit_steps add column on_demand boolean not null default false;
    update public.absence_circuit_steps s set on_demand = true, active = true
     where s.circuit_id = (select id from public.absence_circuits where is_default) and s.kind = 'personnes' and s.pdf_slot = 'chef_service' and s.pos = 30
       and not s.active and cardinality(s.persons) = 0
       and exists (select 1 from public.absence_circuit_steps v where v.circuit_id = s.circuit_id and v.kind = 'visa' and v.col < s.col);
  end if;
end $$;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.absence_circuit_steps'::regclass and conname = 'absence_circuit_steps_on_demand_kind') then
    alter table public.absence_circuit_steps add constraint absence_circuit_steps_on_demand_kind check (not on_demand or (kind in ('personnes', 'groupe') and blocking));
  end if;
end $$;

alter table public.absences add column if not exists escalated_at timestamptz;
alter table public.absences add column if not exists escalated_by uuid references auth.users (id) on delete set null;
alter table public.absences add column if not exists escalation_note text;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.absences'::regclass and conname = 'absences_escalation_note_len') then
    alter table public.absences add constraint absences_escalation_note_len check (char_length(escalation_note) <= 500);
  end if;
end $$;

-- Boîte d'envoi : nouveau type « escalated »
do $$
declare n text; d text;
begin
  select conname, pg_get_constraintdef(oid) into n, d from pg_constraint where conrelid = 'public.absence_outbox'::regclass and conname = 'absence_outbox_kind_check';
  if n is null or position('escalated' in d) = 0 then
    if n is not null then execute format('alter table public.absence_outbox drop constraint %I', n); end if;
    alter table public.absence_outbox add constraint absence_outbox_kind_check check (kind in
      ('to_validate', 'to_validate_change', 'approved', 'rejected', 'change_approved', 'change_rejected', 'form', 'to_direction', 'direction_change', 'to_opinion', 'peer_rejected', 'on_behalf', 'form_copy', 'agenda_done', 'escalated'));
  end if;
end $$;

-- 2. Étapes d'un circuit : on_demand dans les lectures, l'instantané et l'enregistrement -------------------------------------------

create or replace function public.absence_circuit_steps_json(p_circuit bigint default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('pos', s.pos, 'col', s.col, 'kind', s.kind, 'label', s.label, 'rule', s.rule, 'blocking', s.blocking, 'active', s.active,
    'persons', to_jsonb(s.persons), 'roles', to_jsonb(s.roles), 'scope', s.scope, 'kinds', to_jsonb(s.kinds), 'min_days', s.min_days, 'pdf_slot', s.pdf_slot, 'on_demand', s.on_demand) order by s.col, s.pos), '[]'::jsonb)
  from public.absence_circuit_steps s where s.circuit_id = coalesce(p_circuit, public.absence_circuit_default_id());
$$;

create or replace function public.absence_circuit_steps_named(p_circuit bigint default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'pos', s.pos, 'col', s.col, 'kind', s.kind, 'label', s.label, 'rule', s.rule, 'blocking', s.blocking, 'active', s.active,
    'persons', (select coalesce(jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x), 'has_tool', public.tool_allowed(x, 'absences'))
                                          order by lower(coalesce(public.member_name(x), ''))), '[]'::jsonb) from unnest(s.persons) x),
    'roles', to_jsonb(s.roles), 'scope', s.scope,
    'kinds', to_jsonb(s.kinds), 'min_days', s.min_days, 'pdf_slot', s.pdf_slot, 'on_demand', s.on_demand) order by s.col, s.pos), '[]'::jsonb)
  from public.absence_circuit_steps s where s.circuit_id = coalesce(p_circuit, public.absence_circuit_default_id());
$$;

create or replace function public.absence_circuit_normalize(p_steps jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  e jsonb; res jsonb := '[]'::jsonb; k text; lbl text; rl text; bl boolean; ac boolean; pers uuid[]; ks jsonb; md int; slot text; ps int; cl int; rls text[]; sc text;
  od boolean; seen int[] := '{}'; n_pre int := 0; n_cl int := 0; n_vi int := 0; uncond boolean := false; x text;
begin
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then raise exception 'Le circuit doit être une liste d''étapes.'; end if;
  if jsonb_array_length(p_steps) > 30 then raise exception 'Trop d''étapes (30 au plus).'; end if;
  for e in select value from jsonb_array_elements(p_steps) loop
    if jsonb_typeof(e) <> 'object' then raise exception 'Étape invalide.'; end if;
    k := e ->> 'kind';
    if k is null or k not in ('preavis', 'clinique', 'visa', 'direction', 'personnes', 'groupe') then raise exception 'Type d''étape inconnu.'; end if;
    lbl := btrim(coalesce(e ->> 'label', ''));
    if char_length(lbl) not between 1 and 80 then raise exception 'Le libellé d''une étape compte de 1 à 80 caractères.'; end if;
    if jsonb_typeof(e -> 'pos') is distinct from 'number' or (e ->> 'pos') !~ '^[0-9]{1,4}$' then raise exception 'La position d''une étape est invalide.'; end if;
    ps := (e ->> 'pos')::int;
    if ps = any (seen) then raise exception 'Deux étapes ne peuvent pas avoir la même position.'; end if;
    seen := seen || ps;
    if (k = 'preavis') <> (ps = 0) then raise exception 'La position 0 est réservée au pré-avis, et le pré-avis occupe toujours la position 0.'; end if;
    -- colonne : sans valeur, la position ; le pré-avis reste hors colonnes (0)
    if k = 'preavis' then
      cl := 0;
    elsif e -> 'col' is not null and jsonb_typeof(e -> 'col') <> 'null' then
      if jsonb_typeof(e -> 'col') <> 'number' or (e ->> 'col') !~ '^[0-9]{1,4}$' or (e ->> 'col')::int < 1 then raise exception 'La colonne d''une étape est invalide.'; end if;
      cl := (e ->> 'col')::int;
    else
      cl := ps;
    end if;
    rl := coalesce(e ->> 'rule', 'all');
    if rl not in ('all', 'any') then raise exception 'La règle d''une étape doit être « all » (tous) ou « any » (un seul).'; end if;
    bl := case when jsonb_typeof(e -> 'blocking') = 'boolean' then (e ->> 'blocking')::boolean else true end;
    ac := case when jsonb_typeof(e -> 'active') = 'boolean' then (e ->> 'active')::boolean else true end;
    -- étape sur décision de la direction : « personnes » ou « groupe » seulement, toujours bloquante une fois sollicitée
    od := case when jsonb_typeof(e -> 'on_demand') = 'boolean' then (e ->> 'on_demand')::boolean else false end;
    if od and k not in ('personnes', 'groupe') then raise exception 'Seule une étape « personnes » ou « groupe » peut dépendre d''une décision de la direction.'; end if;
    if od then bl := true; end if;
    if k = 'visa' then rl := 'any'; bl := true; end if;
    if k = 'preavis' then bl := false; rl := 'all'; end if;
    pers := '{}';
    if k = 'personnes' and e -> 'persons' is not null and jsonb_typeof(e -> 'persons') <> 'null' then
      if jsonb_typeof(e -> 'persons') <> 'array' then raise exception 'La liste des personnes d''une étape est invalide.'; end if;
      for x in select value from jsonb_array_elements_text(e -> 'persons') loop
        if x !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then raise exception 'Une personne désignée est invalide.'; end if;
        if not (x::uuid = any (pers)) then pers := pers || x::uuid; end if;
      end loop;
      if exists (select 1 from unnest(pers) u where not exists (select 1 from public.profiles p where p.id = u and p.role <> 'member')) then
        raise exception 'Une personne désignée n''existe pas ou n''a pas encore de rôle.';
      end if;
    end if;
    if k = 'personnes' and ac and not od and coalesce(array_length(pers, 1), 0) = 0 then
      raise exception 'L''étape « % » est active : désignez au moins une personne.', lbl;
    end if;
    -- étape de groupe : rôles (sous-ensemble des rôles de membres) et portée (clinique du demandeur ou tous)
    rls := null; sc := null;
    if k = 'groupe' then
      rls := '{}';
      if e -> 'roles' is not null and jsonb_typeof(e -> 'roles') <> 'null' then
        if jsonb_typeof(e -> 'roles') <> 'array' then raise exception 'Les rôles d''une étape sont invalides.'; end if;
        if exists (select 1 from jsonb_array_elements(e -> 'roles') v
                    where jsonb_typeof(v) <> 'string' or not ((v #>> '{}') = any (array['clinician', 'cdc', 'cadre', 'assistant', 'nurse', 'pharmacist', 'direction', 'admin']))) then
          raise exception 'Rôle inconnu dans une étape de groupe.';
        end if;
        rls := array(select distinct v #>> '{}' from jsonb_array_elements(e -> 'roles') v order by 1);
      end if;
      if ac and cardinality(rls) = 0 then raise exception 'L''étape « % » est active : choisissez au moins un rôle.', lbl; end if;
      sc := coalesce(nullif(e ->> 'scope', ''), 'clinic');
      if sc not in ('clinic', 'all') then raise exception 'La portée d''une étape de groupe est invalide (clinique du demandeur ou tous).'; end if;
    end if;
    ks := null;
    if e -> 'kinds' is not null and jsonb_typeof(e -> 'kinds') <> 'null' then
      if jsonb_typeof(e -> 'kinds') <> 'array' or jsonb_array_length(e -> 'kinds') = 0 then raise exception 'Les motifs d''une étape sont invalides.'; end if;
      if exists (select 1 from jsonb_array_elements(e -> 'kinds') v where jsonb_typeof(v) <> 'string' or (v #>> '{}') not in ('vacances', 'congres', 'autre')) then
        raise exception 'Motif inconnu dans une condition d''étape.';
      end if;
      ks := (select jsonb_agg(distinct v) from jsonb_array_elements(e -> 'kinds') v);
    end if;
    md := null;
    if e -> 'min_days' is not null and jsonb_typeof(e -> 'min_days') <> 'null' then
      if jsonb_typeof(e -> 'min_days') <> 'number' or (e ->> 'min_days') !~ '^[0-9]{1,4}$' or (e ->> 'min_days')::int not between 1 and 365 then
        raise exception 'La durée minimale d''une étape va de 1 à 365 jours ouvrables.';
      end if;
      md := (e ->> 'min_days')::int;
    end if;
    slot := nullif(e ->> 'pdf_slot', '');
    if slot is not null and slot <> 'chef_service' then raise exception 'Case du formulaire PDF inconnue.'; end if;
    if k = 'preavis' then n_pre := n_pre + 1; elsif k = 'clinique' then n_cl := n_cl + 1; elsif k = 'visa' then n_vi := n_vi + 1; end if;
    if k <> 'preavis' and ac and bl and ks is null and md is null and not od then uncond := true; end if;
    res := res || jsonb_build_array(jsonb_build_object('pos', ps, 'col', cl, 'kind', k, 'label', lbl, 'rule', rl, 'blocking', bl, 'active', ac,
      'persons', to_jsonb(pers), 'roles', to_jsonb(rls), 'scope', sc, 'kinds', ks, 'min_days', md, 'pdf_slot', slot, 'on_demand', od));
  end loop;
  if n_pre > 1 then raise exception 'Un seul pré-avis est permis (position 0).'; end if;
  if n_cl > 1 then raise exception 'Une seule étape « Validateurs de clinique » est permise.'; end if;
  if n_vi > 1 then raise exception 'Une seule étape « Visa de la direction » est permise.'; end if;
  -- une étape sur décision de la direction vient après le visa de la direction (colonne postérieure) ; le visa doit être actif
  if exists (select 1 from jsonb_array_elements(res) v where (v ->> 'on_demand')::boolean and (v ->> 'active')::boolean
              and not exists (select 1 from jsonb_array_elements(res) w
                               where w ->> 'kind' = 'visa' and (w ->> 'active')::boolean and (w ->> 'col')::int < (v ->> 'col')::int)) then
    raise exception 'Une étape « sur décision de la direction » doit se trouver dans une colonne après celle du visa de la direction (le visa doit être actif).';
  end if;
  if not uncond then
    raise exception 'Le circuit doit comporter au moins une étape active, bloquante et sans condition de motif ni de durée.';
  end if;
  -- Renumérotation : pré-avis 0 ; colonnes 10, 20, 30... ; positions 10, 20, 30... dans l'ordre (col, pos d'origine) (jamais 1 à 9, réservés à l'ancien stage ; toujours sous le repli 1000)
  return (select jsonb_agg(q.v || jsonb_build_object('col', case when q.pre then 0 else 10 * q.dr end, 'pos', case when q.pre then 0 else 10 * q.rn end) order by q.pre desc, q.c, q.p)
          from (select v, (v ->> 'kind' = 'preavis') as pre, (v ->> 'col')::int as c, (v ->> 'pos')::int as p,
                       dense_rank() over (partition by (v ->> 'kind' = 'preavis') order by (v ->> 'col')::int) as dr,
                       row_number() over (partition by (v ->> 'kind' = 'preavis') order by (v ->> 'col')::int, (v ->> 'pos')::int) as rn
                  from jsonb_array_elements(res) v) q);
end;
$$;

create or replace function public.absence_circuit_build(p_kind text, p_from date, p_to date, p_steps jsonb default null, p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare days int; res jsonb;
begin
  days := public.absence_workdays(p_from, p_to);
  select coalesce(jsonb_agg(jsonb_build_object('pos', s.pos, 'col', coalesce(s.col, s.pos), 'kind', s.kind, 'label', s.label, 'rule', s.rule, 'blocking', s.blocking,
           'persons', coalesce(s.persons, '[]'::jsonb), 'roles', s.roles, 'scope', s.scope, 'pdf_slot', s.pdf_slot, 'on_demand', coalesce(s.on_demand, false)) order by coalesce(s.col, s.pos), s.pos), '[]'::jsonb)
    into res
    from jsonb_to_recordset(coalesce(p_steps, public.absence_circuit_steps_json(case when p_user is null then null else (public.absence_circuit_resolve(p_user, p_from, p_to) ->> 'circuit_id')::bigint end)))
         as s(pos int, col int, kind text, label text, rule text, blocking boolean, active boolean, persons jsonb, roles jsonb, scope text, kinds jsonb, min_days int, pdf_slot text, on_demand boolean)
   where s.active and s.kind <> 'preavis'
     and (s.kinds is null or jsonb_typeof(s.kinds) <> 'array' or s.kinds @> to_jsonb(p_kind))
     and (s.min_days is null or days >= s.min_days);
  if not exists (select 1 from jsonb_array_elements(res) e where (e ->> 'blocking')::boolean) then
    -- garde-fou : sans étape bloquante, on revient au circuit d'origine
    res := '[{"pos":10,"col":10,"kind":"clinique","label":"Validateurs de clinique","rule":"all","blocking":true,"persons":[],"pdf_slot":null},{"pos":20,"col":20,"kind":"visa","label":"Visa de la direction","rule":"any","blocking":true,"persons":[],"pdf_slot":null}]'::jsonb;
  end if;
  return res;
end;
$$;

create or replace function public.absence_first_stop(p_user uuid, p_from date, p_to date, p_circuit jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c int; e jsonb; ppl uuid[]; allp uuid[]; has_visa boolean; other boolean; labels text[]; cs jsonb; fk text; fr text; fpos int;
begin
  for c in select distinct public.absence_step_col(x) from jsonb_array_elements(coalesce(p_circuit, '[]'::jsonb)) x order by 1 loop
    has_visa := false; other := false; allp := '{}'::uuid[]; labels := '{}'; cs := '[]'::jsonb; fk := null; fr := null; fpos := null;
    for e in select value from jsonb_array_elements(p_circuit) where public.absence_step_col(value) = c order by (value ->> 'pos')::int loop
      continue when not (e ->> 'blocking')::boolean or coalesce((e ->> 'on_demand')::boolean, false);
      ppl := public.absence_step_people_for(p_user, p_from, p_to, e);
      if e ->> 'kind' = 'visa' then
        has_visa := true;
      elsif coalesce(array_length(ppl, 1), 0) = 0 then
        continue;
      else
        other := true; fk := coalesce(fk, e ->> 'kind'); fr := coalesce(fr, e ->> 'rule');
      end if;
      fpos := coalesce(fpos, (e ->> 'pos')::int);
      labels := labels || (e ->> 'label');
      cs := cs || jsonb_build_array(e);
      allp := array(select distinct x from unnest(allp || ppl) x order by x);
    end loop;
    if other or has_visa then
      return jsonb_build_object('col', c, 'steps', cs, 'people', to_jsonb(allp),
        'step', jsonb_build_object('pos', fpos, 'col', c, 'kind', case when other then fk else 'visa' end, 'label', array_to_string(labels, ' + '),
                                   'rule', case when other then coalesce(fr, 'all') else 'any' end));
    end if;
  end loop;
  return jsonb_build_object('col', 1000, 'steps', jsonb_build_array(public.absence_circuit_fallback()), 'step', public.absence_circuit_fallback(),
                            'people', to_jsonb(public.absence_direction_recipients(p_user)));
end;
$$;

create or replace function public.absence_advance(p_id bigint, p_by uuid default null, p_comment text default null,
                                                  p_mail_stop boolean default true, p_mail_opinion boolean default true, p_after int default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.absences; s jsonb; ppl uuid[]; r uuid; k text; v_from int; c int; circ jsonb; ops jsonb[] := '{}'; o jsonb;
  has_visa boolean; retained boolean; stops jsonb; st jsonb; mail uuid[];
begin
  select * into a from public.absences where id = p_id for update;
  if not found then return; end if;
  v_from := coalesce(p_after, a.stage);
  for c in select distinct public.absence_step_col(e) from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e
            where public.absence_step_col(e) > v_from order by 1 loop
    has_visa := false; retained := false; stops := '[]'::jsonb;
    for s in select value from jsonb_array_elements(a.circuit) where public.absence_step_col(value) = c order by (value ->> 'pos')::int loop
      -- étape sur décision de la direction : sautée tant que la demande n'a pas été envoyée à cette étape
      if coalesce((s ->> 'on_demand')::boolean, false) and a.escalated_at is null then continue; end if;
      if not (s ->> 'blocking')::boolean then
        ops := ops || s;
        continue;
      end if;
      k := s ->> 'kind';
      if k = 'visa' then has_visa := true; continue; end if;
      ppl := public.absence_step_people(a, s);
      -- étape bloquante sans personne : considérée comme soldée
      if coalesce(array_length(ppl, 1), 0) > 0 then
        retained := true;
        stops := stops || jsonb_build_array(jsonb_build_object('pos', (s ->> 'pos')::int, 'people', to_jsonb(ppl)));
      end if;
    end loop;
    continue when not (retained or has_visa);
    update public.absences set stage = c, stage_at = now() where id = p_id;
    if p_mail_opinion then
      foreach o in array ops loop
        foreach r in array public.absence_step_people(a, o) loop
          perform public.absence_enqueue('to_opinion', r, array[p_id], jsonb_build_object('owner', public.member_name(a.user_id), 'step_label', o ->> 'label'));
        end loop;
      end loop;
    end if;
    mail := '{}'::uuid[];
    for st in select value from jsonb_array_elements(stops) loop
      insert into public.absence_approvals (absence_id, step, validator_id)
        select p_id, (st ->> 'pos')::int, v::uuid from jsonb_array_elements_text(st -> 'people') v on conflict (absence_id, step, validator_id) do nothing;
      mail := mail || array(select v::uuid from jsonb_array_elements_text(st -> 'people') v);
    end loop;
    if p_mail_stop then
      -- un seul message par personne, même si elle figure dans plusieurs étapes de la colonne
      foreach r in array array(select distinct x from unnest(mail) x order by x) loop
        perform public.absence_enqueue(case when a.change_type is not null then 'to_validate_change' else 'to_validate' end, r, array[p_id],
                                       jsonb_build_object('owner', public.member_name(a.user_id)));
      end loop;
      -- les destinataires du visa déjà prévenus par « à valider » (autre étape de la colonne) ne reçoivent pas « à la direction » en plus
      if has_visa then perform public.absence_enqueue_direction(array[p_id], a.user_id, mail); end if;
    end if;
    return;
  end loop;
  -- Fin de chaîne. Jamais d'approbation automatique sans aucune décision humaine : la demande passe à l'étape de repli (visa de la direction, sinon administrateurs).
  if p_by is null and not exists (select 1 from public.absence_approvals where absence_id = p_id and decision = 'approved') then
    circ := coalesce(a.circuit, '[]'::jsonb);
    if not exists (select 1 from jsonb_array_elements(circ) e where (e ->> 'pos')::int = 1000) then circ := circ || jsonb_build_array(public.absence_circuit_fallback()); end if;
    update public.absences set circuit = circ, stage = 1000, stage_at = now() where id = p_id;
    if p_mail_stop then perform public.absence_enqueue_direction(array[p_id], a.user_id); end if;
    return;
  end if;
  perform public.absence_finalize_approve(p_id, p_by, p_comment);
end;
$$;

create or replace function public.absence_open_round_core(p_id bigint, p_notify boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.absences; r jsonb;
begin
  select * into a from public.absences where id = p_id;
  if not found then return; end if;
  delete from public.absence_approvals where absence_id = p_id;
  delete from public.absence_opinions where absence_id = p_id;
  update public.absences set escalated_at = null, escalated_by = null, escalation_note = null where id = p_id;
  -- instantané figé : étapes, identité du circuit et pré-avis (un changement ultérieur de circuit ou d'attribution ne touche pas la demande)
  r := public.absence_circuit_resolve(a.user_id, case when a.change_type = 'modify' then a.change_start else a.start_date end,
                                                 case when a.change_type = 'modify' then a.change_end else a.end_date end);
  update public.absences set circuit = public.absence_circuit_build(case when a.change_type = 'modify' then a.change_kind else a.kind end,
                                         case when a.change_type = 'modify' then a.change_start else a.start_date end,
                                         case when a.change_type = 'modify' then a.change_end else a.end_date end,
                                         public.absence_circuit_steps_json((r ->> 'circuit_id')::bigint)),
    circuit_id = (r ->> 'circuit_id')::bigint, circuit_name = r ->> 'name',
    preavis_active = exists (select 1 from public.absence_circuit_steps s where s.kind = 'preavis' and s.active and s.circuit_id = (r ->> 'circuit_id')::bigint)
    where id = p_id;
  -- les e-mails de la première étape bloquante sont envoyés par l'appelant (envoi, demande de changement)
  perform public.absence_advance(p_id, null, null, false, p_notify, -1);
end;
$$;

create or replace function public.absence_circuit_public(a public.absences) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when a.circuit is null then null else
    (select coalesce(jsonb_agg(((t.e - 'persons') || jsonb_build_object('col', public.absence_step_col(t.e)))
                               || case when public.absence_step_col(t.e) = a.stage then '{"current":true}'::jsonb else '{}'::jsonb end order by t.ord), '[]'::jsonb)
       from jsonb_array_elements(a.circuit) with ordinality t(e, ord)
      where not (coalesce((t.e ->> 'on_demand')::boolean, false) and a.escalated_at is null)) end;
$$;

create or replace function public.absence_in_personnes_step(p_uid uuid, a public.absences) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select (a.status in ('requested', 'rejected') or public.absence_is_open(a))
     and exists (select 1 from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e
                  where e ->> 'kind' = 'personnes' and p_uid = any (public.absence_step_people(a, e))
                    and not (coalesce((e ->> 'on_demand')::boolean, false) and a.escalated_at is null));
$$;

create or replace function public.absence_circuit_save(p_steps jsonb, p_circuit bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare norm jsonb; before jsonb; cid bigint;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  cid := public.absence_circuit_check_id(p_circuit);
  perform 1 from public.absence_circuits where id = cid for update;
  norm := public.absence_circuit_normalize(p_steps);
  before := public.absence_circuit_steps_json(cid);
  delete from public.absence_circuit_steps where circuit_id = cid;
  insert into public.absence_circuit_steps (circuit_id, pos, col, kind, label, rule, blocking, active, persons, roles, scope, kinds, min_days, pdf_slot, on_demand)
    select cid, s.pos, s.col, s.kind, s.label, s.rule, s.blocking, s.active,
           array(select x::uuid from jsonb_array_elements_text(coalesce(s.persons, '[]'::jsonb)) x),
           case when s.roles is null or jsonb_typeof(s.roles) <> 'array' then null else array(select x from jsonb_array_elements_text(s.roles) x) end,
           s.scope,
           case when s.kinds is null or jsonb_typeof(s.kinds) <> 'array' then null else array(select x from jsonb_array_elements_text(s.kinds) x) end,
           s.min_days, s.pdf_slot, coalesce(s.on_demand, false)
      from jsonb_to_recordset(norm) as s(pos int, col int, kind text, label text, rule text, blocking boolean, active boolean, persons jsonb, roles jsonb, scope text, kinds jsonb, min_days int, pdf_slot text, on_demand boolean);
  insert into public.absence_circuit_log (changed_by, before, after, circuit_id, action) values (auth.uid(), before, public.absence_circuit_steps_json(cid), cid, 'save_steps');
  return public.absence_circuit_get(cid) || case when exists (select 1 from public.absence_circuit_steps where circuit_id = cid and kind = 'visa' and active) then '{}'::jsonb
    else jsonb_build_object('warning', 'Aucun visa de la direction actif : les demandes sans validateur iront aux administrateurs.') end;
end;
$$;

create or replace function public.absence_circuit_create(p_name text, p_copy_from bigint default null) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare nm text := btrim(coalesce(p_name, '')); src bigint; nid bigint;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  if char_length(nm) not between 1 and 60 then raise exception 'Le nom d''un circuit compte de 1 à 60 caractères.'; end if;
  if exists (select 1 from public.absence_circuits where lower(name) = lower(nm)) then raise exception 'Un circuit porte déjà ce nom.'; end if;
  if (select count(*) from public.absence_circuits) >= 30 then raise exception 'Trop de circuits (30 au plus).'; end if;
  src := public.absence_circuit_check_id(p_copy_from);
  insert into public.absence_circuits (name, pos) values (nm, coalesce((select max(pos) from public.absence_circuits), 0) + 10) returning id into nid;
  insert into public.absence_circuit_steps (circuit_id, pos, col, kind, label, rule, blocking, active, persons, roles, scope, kinds, min_days, pdf_slot, on_demand)
    select nid, s.pos, s.col, s.kind, s.label, s.rule, s.blocking, s.active, s.persons, s.roles, s.scope, s.kinds, s.min_days, s.pdf_slot, s.on_demand from public.absence_circuit_steps s where s.circuit_id = src;
  insert into public.absence_circuit_log (changed_by, before, after, circuit_id, action)
    values (auth.uid(), null, jsonb_build_object('name', nm, 'copy_from', src), nid, 'create');
  return nid;
end;
$$;

create or replace function public.absence_reroute(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  for r in select a.id from public.absences a
           where a.user_id = p_user and (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null)) and a.escalated_at is null
             and not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.decision <> 'pending') loop
    perform public.absence_open_round_core(r.id, false);
  end loop;
end;
$$;

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
      when coalesce((e ->> 'on_demand')::boolean, false) then 'sur décision de la direction, après le visa ; un refus suffit'
      when not (e ->> 'blocking')::boolean then 'avis demandé ; la demande n''attend pas cette étape'
      when k = 'visa' then 'un seul visa suffit ; signe le formulaire PDF'
      when k = 'groupe' and e ->> 'rule' = 'any' then 'une seule validation du groupe suffit ; un refus suffit'
      when e ->> 'rule' = 'any' then 'une seule validation suffit ; un refus suffit'
      else 'tous doivent valider ; un refus suffit' end;
    note := case
      when coalesce((e ->> 'on_demand')::boolean, false) and coalesce(array_length(ppl, 1), 0) = 0 then 'Aucune personne disponible : le bouton « Envoyer à la cheffe de service » restera inactif'
      when coalesce((e ->> 'on_demand')::boolean, false) then 'Étape facultative : sautée, sauf si la direction envoie la demande à cette étape en donnant son visa'
      when k = 'visa' and coalesce(array_length(ppl, 1), 0) = 0 then 'Aucun membre direction ni administrateur : personne ne peut viser'
      when k = 'visa' and vis_admin then 'Personne de la direction : le visa revient aux administrateurs'
      when k = 'clinique' and coalesce(array_length(ppl, 1), 0) = 0 and nxt = 'visa' then 'Aucun validateur actif : étape sautée, la demande va directement au visa'
      when k = 'clinique' and coalesce(array_length(ppl, 1), 0) = 0 then 'Aucun validateur actif : étape sautée, la demande passe à l''étape suivante'
      when coalesce(array_length(ppl, 1), 0) = 0 and (e ->> 'blocking')::boolean then 'Aucune personne disponible : étape sautée'
      when coalesce(array_length(ppl, 1), 0) = 0 then 'Aucune personne disponible : aucun avis demandé'
      else null end;
    steps := steps || jsonb_build_array(jsonb_build_object('key', k, 'pos', (e ->> 'pos')::int, 'col', public.absence_step_col(e), 'kind', k, 'label', e ->> 'label', 'rule', rule_txt, 'rule_code', e ->> 'rule',
      'blocking', (e ->> 'blocking')::boolean, 'parallel_with', null, 'pdf_slot', e -> 'pdf_slot', 'on_demand', coalesce((e ->> 'on_demand')::boolean, false),
      'people', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by lower(public.member_name(x))) from unnest(ppl) x), '[]'::jsonb),
      'note', note));
  end loop;

  -- étapes groupées par colonne (étapes simultanées) : une colonne sans personne ni visa est sautée
  cols := coalesce((select jsonb_agg(jsonb_build_object('col', g.col, 'steps', g.st,
            'note', case when exists (select 1 from jsonb_array_elements(g.st) z where z ->> 'kind' = 'visa') then null
                         when exists (select 1 from jsonb_array_elements(g.st) z where (z ->> 'on_demand')::boolean) then 'Sur décision de la direction : colonne sautée, sauf envoi au moment du visa'
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
  for st in select s.label, s.persons, s.on_demand, ac.name, ac.is_default from public.absence_circuit_steps s join public.absence_circuits ac on ac.id = s.circuit_id
             where s.kind = 'personnes' and s.active order by ac.is_default desc, ac.pos, ac.id, s.pos loop
    if not exists (select 1 from unnest(st.persons) x where public.tool_allowed(x, 'absences')) then
      warns := warns || to_jsonb(case when st.is_default then '' else 'Circuit « ' || st.name || ' » : ' end
        || 'Étape « ' || st.label || ' » : aucune personne désignée n''a accès à Absences, '
        || case when st.on_demand then 'le bouton « Envoyer à la cheffe de service » restera inactif' else 'l''étape sera sautée' end);
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

-- 3. Envoi à l'étape sur décision de la direction ----------------------------------------------------------------------------------

-- Instantané de la demande avec, pour les étapes sur décision, les personnes (et rôles, portée) désignées dans le circuit au moment de l'envoi :
-- la cheffe de service peut être désignée après le dépôt de la demande, contrairement aux étapes ordinaires dont l'instantané reste figé.
create or replace function public.absence_circuit_refresh_od(a public.absences) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(case when coalesce((t.e ->> 'on_demand')::boolean, false) and s.id is not null
                                 then t.e || jsonb_build_object('persons', to_jsonb(s.persons), 'roles', to_jsonb(s.roles), 'scope', s.scope) else t.e end order by t.ord), '[]'::jsonb)
    from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) with ordinality t(e, ord)
    left join lateral (
      -- étape sur décision du circuit courant de la demande, de même type ; plusieurs : la première colonne après le visa
      select x.* from public.absence_circuit_steps x
       where x.circuit_id = a.circuit_id and x.on_demand and x.active and x.kind = t.e ->> 'kind'
         and x.col > coalesce((select min(v.col) from public.absence_circuit_steps v where v.circuit_id = a.circuit_id and v.kind = 'visa' and v.active), 0)
       order by x.col, x.pos limit 1) s on true;
$$;

-- Cette demande peut-elle être envoyée à l'étape « sur décision » par cette personne ? null : non concernée ; sinon { available, label, reason }.
-- Concernée : demande en cours, pas encore envoyée, une étape sur décision se trouve après la colonne en cours, qui contient le visa pas encore posé,
-- et la personne peut viser (membre « direction » hors ses propres absences, ou administrateur).
create or replace function public.absence_escalation_state(p_uid uuid, a public.absences) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v jsonb; lbls text[]; has_ppl boolean; r text; ok boolean;
begin
  if p_uid is null or not public.absence_is_open(a) or a.escalated_at is not null then return null; end if;
  a.circuit := public.absence_circuit_refresh_od(a);
  select coalesce(array_agg(e ->> 'label' order by (e ->> 'pos')::int), '{}'::text[]),
         coalesce(bool_or(cardinality(public.absence_step_people(a, e)) > 0), false)
    into lbls, has_ppl
    from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e
   where coalesce((e ->> 'on_demand')::boolean, false) and public.absence_step_col(e) > a.stage;
  if coalesce(array_length(lbls, 1), 0) = 0 then return null; end if;
  select e into v from jsonb_array_elements(public.absence_steps_of(a)) e where e ->> 'kind' = 'visa' and (e ->> 'blocking')::boolean limit 1;
  if v is null or public.absence_visa_done(a) then return null; end if;
  select role into r from public.profiles where id = p_uid;
  ok := r = 'admin' or public.absence_step_member(p_uid, a, v);
  if not ok then return null; end if;
  return jsonb_build_object('available', has_ppl, 'label', array_to_string(lbls, ' + '),
    'reason', case when has_ppl then null else 'Aucune personne n''est désignée pour « ' || array_to_string(lbls, ' + ') || ' » : l''administration doit la désigner dans le circuit de validation.' end);
end;
$$;

-- Visa de la direction, puis envoi de la demande à l'étape sur décision (cheffe de service). Demandes de changement comprises.
create or replace function public.absence_visa_escalate(p_id bigint, p_note text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); a public.absences; st jsonb; n text := nullif(trim(coalesce(p_note, '')), ''); old_stage int;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if char_length(coalesce(n, '')) > 500 then raise exception 'Note trop longue (500 caractères au plus).'; end if;
  st := public.absence_escalation_state(uid, a);
  if st is null then
    if public.absence_is_open(a) and a.escalated_at is not null then raise exception 'Cette demande a déjà été envoyée à la cheffe de service.'; end if;
    raise exception 'Cette demande ne peut pas être envoyée à la cheffe de service par vous à ce stade.' using errcode = '42501';
  end if;
  if not (st ->> 'available')::boolean then raise exception '%', st ->> 'reason'; end if;
  old_stage := a.stage;
  -- le visa de la direction est enregistré (son nom et l'heure figurent sur le PDF), puis la demande passe à l'étape suivante au lieu d'être conclue
  update public.absences set circuit = public.absence_circuit_refresh_od(a), escalated_at = now(), escalated_by = uid, escalation_note = n, direction_by = uid, direction_at = now() where id = p_id;
  perform public.absence_try_complete(p_id, uid, null);
  select * into a from public.absences where id = p_id;
  if public.absence_is_open(a) and a.stage > old_stage then
    perform public.absence_enqueue('escalated', a.user_id, array[p_id], jsonb_build_object('step_label', st ->> 'label'));
  end if;
  return (select case when status = 'requested' or (status = 'approved' and change_type is not null) then 'requested' else status end from public.absences where id = p_id);
end;
$$;

-- Décisions à prendre : colonnes en plus (escalation : le visa peut envoyer la demande à l'étape sur décision ; escalated : demande déjà envoyée, par qui, note)

do $$
begin
  if to_regprocedure('public.absence_to_validate()') is not null
     and not exists (select 1 from pg_proc where oid = to_regprocedure('public.absence_to_validate()') and 'escalation' = any (proargnames)) then
    drop function public.absence_to_validate();
  end if;
end $$;

create or replace function public.absence_to_validate()
returns table(id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text, change_type text, change_kind text,
  change_note text, change_start date, change_end date, created_at timestamptz, change_requested_at timestamptz, conflicts jsonb, my_decision text, progress jsonb, stage integer,
  opinions jsonb, step_kind text, step_label text, steps jsonb, escalation jsonb, escalated jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.note end, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.change_note end, a.change_start, a.change_end, coalesce(a.submitted_at, a.created_at), a.change_requested_at,
           case when a.change_type = 'delete' then '[]'::jsonb
                when a.change_type = 'modify' then public.absence_conflicts_json(a.user_id, a.change_start, a.change_end)
                else public.absence_conflicts_json(a.user_id, a.start_date, a.end_date) end,
           coalesce((select p.decision from public.absence_approvals p where p.absence_id = a.id and p.validator_id = auth.uid()
                      order by (p.step in (select (e ->> 'pos')::int from jsonb_array_elements(public.absence_steps_of(a)) e)) desc limit 1), 'pending'),
           coalesce((select jsonb_agg(jsonb_build_object('name', r.name, 'decision', r.decision, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then r.comment end, 'at', r.at, 'step', r.step, 'step_label', r.step_label)
                     order by r.step, r.name) from public.absence_decision_rows(a) r), '[]'::jsonb),
           public.absence_stage_compat(a),
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(o.user_id), 'opinion', o.opinion, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then o.comment end, 'at', o.updated_at)
                     order by o.updated_at) from public.absence_opinions o where o.absence_id = a.id), '[]'::jsonb),
           public.absence_col_kind(a), public.absence_col_label(a),
           -- étapes qui retiennent la colonne en cours ; mine : celles qui attendent l'appelant
           coalesce((select jsonb_agg(jsonb_build_object('pos', (e ->> 'pos')::int, 'kind', e ->> 'kind', 'label', e ->> 'label', 'rule', e ->> 'rule',
                       'mine', (public.current_role_name() = 'admin' or public.absence_step_member(auth.uid(), a, e)) and (public.current_role_name() = 'admin' or not public.absence_step_done(auth.uid(), a, e)))
                     order by (e ->> 'pos')::int) from jsonb_array_elements(public.absence_active_steps(a)) e), '[]'::jsonb),
           public.absence_escalation_state(auth.uid(), a),
           case when a.escalated_at is not null then jsonb_build_object('by', public.member_name(a.escalated_by), 'at', a.escalated_at, 'note', a.escalation_note) end
    from public.absences a
    where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
      and public.absence_actionable(auth.uid(), a)
    order by coalesce(a.change_requested_at, a.submitted_at, a.created_at);
end;
$$;

create or replace function public.absence_enqueue(p_kind text, p_recipient uuid, p_ids bigint[], p_payload jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids bigint[]; oid bigint; owner uuid; sec uuid;
begin
  -- décision sur une absence d'un médecin cadre : ses secrétaires la reçoivent aussi, à leur propre adresse
  if p_kind in ('approved', 'rejected', 'change_approved', 'change_rejected') then
    select a.user_id into owner from public.absences a where a.id = any (p_ids) and a.user_id = p_recipient limit 1;
    if owner is not null then
      for sec in select distinct cs.secretary_id from public.cadre_secretaries cs where cs.cadre_id = owner and public.is_secretary_of(cs.secretary_id, owner) loop
        perform public.absence_enqueue(p_kind, sec, p_ids, coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('secretary', true, 'owner', public.member_name(owner)));
      end loop;
    end if;
  end if;
  select array_agg(a.id order by a.start_date, a.id) into ids from public.absences a where a.id = any (p_ids) and (
    case when p_kind in ('to_validate', 'to_validate_change') then
      p_recipient = any (public.absence_col_people(a))
    when p_kind in ('approved', 'rejected', 'change_approved', 'change_rejected') then p_recipient = a.user_id or public.is_secretary_of(p_recipient, a.user_id)
    when p_kind in ('direction_change', 'on_behalf', 'agenda_done') then p_recipient = a.user_id
    when p_kind = 'escalated' then p_recipient = a.user_id and a.escalated_at is not null
    when p_kind = 'to_opinion' then
      (public.absence_preavis_of(a) and p_recipient = any (public.absence_opinion_recipients(a.user_id)))
      or p_recipient = any (public.absence_nonblocking_people(a))
    when p_kind = 'peer_rejected' then p_recipient = any (public.absence_peer_people(a))
    else false end)
  -- un seul message d'avis par personne et par tour, qu'il vienne du pré-avis ou d'une étape non bloquante
  and not (p_kind = 'to_opinion' and p_recipient = any (public.absence_col_people(a)))
  and not (p_kind = 'to_opinion' and exists (select 1 from public.absence_outbox o where o.kind = 'to_opinion' and o.recipient = p_recipient
           and a.id = any (o.absence_ids) and o.created_at >= coalesce(a.change_requested_at, a.submitted_at, a.created_at)));
  if ids is null then return; end if;
  if p_kind = 'to_opinion' and p_payload ->> 'step_label' is not null then
    -- un seul message par personne et par étape pour un même envoi
    select id into oid from public.absence_outbox
      where kind = 'to_opinion' and recipient = p_recipient and sent_at is null and claimed_at is null
        and payload ->> 'step_label' = p_payload ->> 'step_label' and payload ->> 'owner' is not distinct from p_payload ->> 'owner'
        and created_at > now() - interval '10 minutes'
      order by id desc limit 1 for update skip locked;
    if oid is not null then
      update public.absence_outbox set absence_ids = array(select distinct x from unnest(absence_ids || ids) x order by x) where id = oid;
      return;
    end if;
  end if;
  insert into public.absence_outbox (kind, recipient, absence_ids, payload) values (p_kind, p_recipient, ids, coalesce(p_payload, '{}'));
end;
$$;

create or replace function public.absence_notification_ids(p_recipient uuid, p_ids bigint[], p_kind text) returns bigint[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(a.id order by a.start_date, a.id), '{}'::bigint[]) from public.absences a
  where a.id = any (p_ids) and public.tool_allowed(p_recipient, 'absences') and case
    when p_kind in ('to_validate', 'to_validate_change') then
      public.absence_is_open(a) and p_recipient = any (public.absence_col_people(a))
    when p_kind = 'to_direction' then
      public.absence_is_open(a) and exists (select 1 from jsonb_array_elements(public.absence_steps_of(a)) e
                                             where e ->> 'kind' = 'visa' and p_recipient = any (public.absence_step_people(a, e)))
    when p_kind = 'to_opinion' then
      public.absence_is_open(a) and ((public.absence_preavis_open(a) and p_recipient = any (public.absence_opinion_recipients(a.user_id)))
                                     or p_recipient = any (public.absence_nonblocking_people(a)))
    when p_kind = 'peer_rejected' then a.decision in ('rejected', 'change_rejected') and p_recipient = any (public.absence_peer_people(a))
    when p_kind in ('approved', 'rejected', 'change_approved', 'change_rejected') then a.user_id = p_recipient or public.is_secretary_of(p_recipient, a.user_id)
    when p_kind in ('direction_change', 'on_behalf', 'agenda_done') then a.user_id = p_recipient
    when p_kind = 'escalated' then a.user_id = p_recipient and a.escalated_at is not null and public.absence_is_open(a)
    else false end;
$$;

create or replace function public.notification_kinds_for(p_user uuid) returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r text; v boolean; k text[] := '{}'; validator boolean; direction boolean; in_group boolean; dir_step boolean;
begin
  select role, coalesce(absence_validator, false) into r, v from public.profiles where id = p_user;
  if r is null or r = 'member' then return '{}'; end if;
  validator := r = 'admin' or v;
  direction := r in ('direction', 'admin');
  if validator then k := k || array['to_validate', 'to_validate_change']; end if;
  if direction then k := k || array['to_direction', 'to_opinion']; end if;
  if validator or direction then k := k || array['reminder']; end if;
  -- membre susceptible d'être sollicité par une étape « groupe » (rôle listé dans une étape active de n'importe quel circuit) ou « direction »
  in_group := exists (select 1 from public.absence_circuit_steps s where s.kind = 'groupe' and s.active and r = any (s.roles));
  dir_step := direction and exists (select 1 from public.absence_circuit_steps s where s.kind = 'direction' and s.active);
  if (in_group or dir_step or exists (select 1 from public.absence_circuit_steps s where s.kind = 'personnes' and s.active and p_user = any (s.persons))) and not validator then k := k || array['to_validate', 'to_validate_change']; end if;
  if validator or direction or in_group or exists (select 1 from public.absence_circuit_steps s where s.kind = 'personnes' and s.active and p_user = any (s.persons)) then
    k := k || array['peer_rejected'];
  end if;
  if public.tool_allowed(p_user, 'absences') then
    k := k || array['approved', 'rejected', 'change_approved', 'change_rejected', 'direction_change', 'escalated'];
    if r = 'cadre' then k := k || array['on_behalf']; end if;
    if r in ('clinician', 'cdc', 'cadre') then k := k || array['agenda_done']; end if;
  end if;
  if public.tool_allowed(p_user, 'congres') then k := k || array['event_join']; end if;
  return k;
end;
$$;

create or replace function public.absence_list(p_user uuid default null) returns setof public.absences
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); perm boolean := true;
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid then
    perm := public.can_validate_absence(uid, p_user) or public.is_direction_admin() or public.is_secretary_of(uid, p_user);
    -- une personne d'une étape « personnes » ne voit que les demandes où elle figure dans l'instantané
    if not perm and not exists (select 1 from public.absences x where x.user_id = p_user and public.absence_in_personnes_step(uid, x)) then
      raise exception 'Accès refusé.' using errcode = '42501';
    end if;
  end if;
  return query select (jsonb_populate_record(null::public.absences, to_jsonb(a)
      || case when a.confidential and a.user_id <> uid and not public.is_direction_admin() then jsonb_build_object('note', null,'change_note',null,'decision_comment',null) else '{}'::jsonb end
      || case when not public.is_direction_admin() then jsonb_build_object('escalation_note', null) else '{}'::jsonb end
      || jsonb_build_object('stage', public.absence_stage_compat(a), 'circuit', public.absence_circuit_public(a)))).*
    from public.absences a where a.user_id = coalesce(p_user, uid) and (perm or public.absence_in_personnes_step(uid, a))
    and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
    -- les brouillons restent à l'intéressé ; une secrétaire voit ceux qu'elle a saisis pour son cadre
    and (a.status <> 'draft' or a.user_id = uid or (a.requested_by = uid and public.is_secretary_of(uid, a.user_id)))
    order by a.start_date desc;
end;
$$;

-- 4. PDF à tout moment ------------------------------------------------------------------------------------------------------------

-- Personnes sollicitées sur une demande : approbations (étapes atteintes), personnes de la colonne en cours, destinataires du visa une fois la colonne atteinte, avis demandés
create or replace function public.absence_solicited_people(a public.absences) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array(
    select q.x from (
      select p.validator_id as x from public.absence_approvals p where p.absence_id = a.id
      union select unnest(public.absence_col_people(a))
      union select unnest(public.absence_nonblocking_people(a))
      union select unnest(public.absence_direction_recipients(a.user_id))
        where exists (select 1 from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e
                       where e ->> 'kind' = 'visa' and (e ->> 'blocking')::boolean and public.absence_step_col(e) <= a.stage)
    ) q where q.x is not null and q.x <> a.user_id order by q.x), '{}'::uuid[]);
$$;

-- Droit d'obtenir le PDF de l'état actuel (demandée, validée ou refusée ; ni brouillon ni annulée) : l'intéressé, ses secrétaires, ses validateurs,
-- les personnes sollicitées sur la demande, la direction et l'administration. Appelée par notify-absence (rôle service).
create or replace function public.absence_pdf_access(p_caller uuid, p_ids bigint[]) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p_caller is not null and cardinality(p_ids) between 1 and 50
    and (select count(*) from public.absences where id = any (p_ids)) = cardinality(p_ids)
    and (select count(distinct user_id) from public.absences where id = any (p_ids)) = 1
    and not exists (select 1 from public.absences a where a.id = any (p_ids) and not (
      a.status in ('requested', 'approved', 'rejected') and (
        a.user_id = p_caller
        or (select role from public.profiles where id = p_caller) in ('admin', 'direction')
        or public.can_validate_absence(p_caller, a.user_id, public.absence_lo(a), public.absence_hi(a))
        or public.is_secretary_of(p_caller, a.user_id)
        or p_caller = any (public.absence_solicited_people(a)))))
    and public.tool_allowed(p_caller, 'absences'), false);
$$;

-- Données du document. Figé (p_live faux) : contenu strictement identique à l'ancien absence_document_create. État actuel (p_live vrai) : le visa ne vaut que
-- s'il date du tour en cours, et l'éventuel refus (qui, quand, commentaire) est ajouté ; le commentaire est omis pour une absence confidentielle. Aucune écriture.
create or replace function public.absence_document_build(p_ids bigint[], p_action text, p_live boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare owner uuid; r text; d jsonb;
begin
 select user_id into owner from public.absences where id=any(p_ids) limit 1;
 if owner is null or exists(select 1 from public.absences where id=any(p_ids) and user_id<>owner) then return null; end if;
 select role into r from public.profiles where id=owner;
 if r not in ('clinician','cdc','cadre') then return null; end if;
 d:=jsonb_build_object('owner_id',owner,'owner',public.member_name(owner),'role',r,'action',p_action,
 'clinics',public.member_clinics(owner),'requested_at',(select min(coalesce(submitted_at,created_at)) from public.absences where id=any(p_ids)),
 'absences',(select jsonb_agg(jsonb_build_object('id',id,'kind',kind,'start_date',start_date,'end_date',end_date,'note',null,'status',status) order by start_date,id) from public.absences where id=any(p_ids)),
 'direction',(select jsonb_build_object('name',public.member_name(direction_by),'at',direction_at) from public.absences where id=any(p_ids) and direction_by is not null order by direction_at desc limit 1),
 'signers',coalesce((select jsonb_agg(jsonb_build_object('name',public.member_name(p.validator_id),'at',p.decided_at,'comment',null) order by p.decided_at)
                     from public.absence_approvals p join public.absences a on a.id=p.absence_id
                     where p.absence_id=any(p_ids) and p.decision='approved' and public.absence_step_kind(a,p.step)='clinique'),'[]'),
 'extra',coalesce((select jsonb_agg(jsonb_build_object('label',st.e->>'label','name',public.member_name(p.validator_id),'at',p.decided_at,'slot',st.e->>'pdf_slot') order by p.decided_at)
                   from public.absence_approvals p join public.absences a on a.id=p.absence_id
                   cross join lateral (select e from jsonb_array_elements(coalesce(a.circuit,'[]'::jsonb)) e where (e->>'pos')::int=p.step and e->>'kind' in ('personnes','direction') and (e->>'blocking')::boolean limit 1) st(e)
                   where p.absence_id=any(p_ids) and p.decision='approved'),'[]'));
 if p_live then
  d:=d||jsonb_build_object(
   'direction',(select jsonb_build_object('name',public.member_name(direction_by),'at',direction_at) from public.absences
                 where id=any(p_ids) and direction_by is not null and direction_at >= coalesce(change_requested_at, submitted_at, created_at) order by direction_at desc limit 1),
   'refusal',(select jsonb_build_object('name',public.member_name(a.decided_by),'at',a.decided_at,
                'comment',case when exists(select 1 from public.absences c where c.id=any(p_ids) and c.confidential) then null else a.decision_comment end,
                'kind',coalesce(rs.e->>'kind','visa'),'label',coalesce(rs.e->>'label','Visa de la direction'),'slot',rs.e->>'pdf_slot')
            from public.absences a
            left join lateral (select e from public.absence_approvals p, jsonb_array_elements(coalesce(a.circuit,'[]'::jsonb)) e
                                where p.absence_id=a.id and p.validator_id=a.decided_by and p.decision='rejected' and (e->>'pos')::int=p.step
                                order by p.decided_at desc limit 1) rs(e) on true
            where a.id=any(p_ids) and a.status='rejected' and a.decision='rejected' and a.decided_by is not null order by a.decided_at desc limit 1));
 end if;
 return d;
end $$;

-- Document figé : calcul de absence_document_build sans l'état actuel
create or replace function public.absence_document_create(p_ids bigint[], p_action text) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare doc bigint; d jsonb; owner uuid;
begin
 d := public.absence_document_build(p_ids, p_action, false);
 if d is null then return null; end if;
 owner := (d ->> 'owner_id')::uuid;
 insert into public.absence_documents(user_id,absence_ids,action,data) values(owner,p_ids,p_action,d) returning id into doc;
 return doc;
end $$;

-- PDF de l'état actuel. Toutes validées avec un document figé : ce document (comportement inchangé). Sinon : l'état du moment, signatures données remplies,
-- cases en attente vides, refus coché « Défavorable ». Pas d'e-mail, pas de ligne dans la boîte d'envoi, aucune écriture.
create or replace function public.absence_form_current(p_ids bigint[]) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d jsonb;
begin
  if cardinality(p_ids) not between 1 and 50 then return null; end if;
  if exists (select 1 from public.absences where id = any (p_ids) and status not in ('requested', 'approved', 'rejected')) then return null; end if;
  if (select count(*) from public.absences where id = any (p_ids)) <> cardinality(p_ids) then return null; end if;
  if not exists (select 1 from public.absences where id = any (p_ids) and status <> 'approved') then
    d := public.absence_form_data(p_ids);
    if d is not null then return d || jsonb_build_object('live', false); end if;
  end if;
  d := public.absence_document_build(p_ids, 'current', true);
  if d is null then return jsonb_build_object('no_form', true); end if;
  return d || jsonb_build_object('document_id', 0, 'generated_at', now(), 'live', true);
end;
$$;

-- 5. Suivi de la direction -----------------------------------------------------------------------------------------------------------

-- Parcours détaillé d'une demande : pré-avis, étapes du circuit figé (personnes, état, horodatage, commentaire), envoi à l'étape sur décision, décision finale, décisions antérieures.
-- Étapes : state = validée, refusée, en cours, à venir, sautée, non atteinte, non demandée (étape sur décision pas envoyée), consultative.
-- Personnes : state = validé, refusé, en attente, non sollicité, favorable, défavorable.
create or replace function public.absence_track_trail(a public.absences) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare steps jsonb := '[]'::jsonb; e jsonb; c int; od boolean; blk boolean; ppl jsonb; stt text; n_ok int; n_ko int; n_wait int;
  is_open boolean := public.absence_is_open(a); rs timestamptz := coalesce(a.change_requested_at, a.submitted_at, a.created_at); k text;
begin
  for e in select value from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) order by public.absence_step_col(value), (value ->> 'pos')::int loop
    c := public.absence_step_col(e); k := e ->> 'kind';
    od := coalesce((e ->> 'on_demand')::boolean, false);
    blk := coalesce((e ->> 'blocking')::boolean, true);
    if od and a.escalated_at is null then
      steps := steps || jsonb_build_array(jsonb_build_object('pos', (e ->> 'pos')::int, 'col', c, 'label', e ->> 'label', 'kind', k, 'rule', e ->> 'rule', 'blocking', blk,
        'on_demand', true, 'escalated', false, 'state', 'non demandée', 'current', false, 'people', '[]'::jsonb));
      continue;
    end if;
    if not blk then
      ppl := coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(o.user_id), 'state', case o.opinion when 'favorable' then 'favorable' else 'défavorable' end,
                         'at', o.updated_at, 'comment', o.comment) order by o.updated_at)
                       from public.absence_opinions o where o.absence_id = a.id and o.step = (e ->> 'pos')::int), '[]'::jsonb);
    elsif k = 'visa' then
      if a.direction_by is not null and a.direction_at >= rs then
        ppl := jsonb_build_array(jsonb_build_object('name', public.member_name(a.direction_by), 'state', 'validé', 'at', a.direction_at, 'comment', null));
      elsif a.decision in ('rejected', 'change_rejected') and a.decided_by is not null and a.decided_at >= rs
            and not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.decision = 'rejected') then
        -- refus au visa : pas de ligne d'approbation, nom, heure et motif viennent de la décision
        ppl := jsonb_build_array(jsonb_build_object('name', public.member_name(a.decided_by), 'state', 'refusé', 'at', a.decided_at, 'comment', a.decision_comment));
      elsif is_open and c = a.stage then
        ppl := coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(x), 'state', 'en attente', 'at', null, 'comment', null) order by public.member_name(x))
                           from unnest(public.absence_step_people(a, e)) x), '[]'::jsonb);
      else
        ppl := '[]'::jsonb;
      end if;
    else
      ppl := coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(p.validator_id),
                         'state', case p.decision when 'approved' then 'validé' when 'rejected' then 'refusé' when 'pending' then 'en attente' else 'non sollicité' end,
                         'at', p.decided_at, 'comment', p.comment) order by public.member_name(p.validator_id))
                       from public.absence_approvals p where p.absence_id = a.id and p.step = (e ->> 'pos')::int), '[]'::jsonb);
    end if;
    select count(*) filter (where x ->> 'state' in ('validé', 'favorable')), count(*) filter (where x ->> 'state' in ('refusé', 'défavorable')), count(*) filter (where x ->> 'state' = 'en attente')
      into n_ok, n_ko, n_wait from jsonb_array_elements(ppl) x;
    stt := case
      when not blk then 'consultative'
      when n_ko > 0 then 'refusée'
      when n_ok > 0 and (k = 'visa' or e ->> 'rule' = 'any' or n_wait = 0) then 'validée'
      when is_open and c = a.stage then 'en cours'
      when is_open and c > a.stage then 'à venir'
      when is_open or a.status in ('approved', 'rejected') then 'sautée'
      else 'non atteinte' end;
    steps := steps || jsonb_build_array(jsonb_build_object('pos', (e ->> 'pos')::int, 'col', c, 'label', e ->> 'label', 'kind', k, 'rule', e ->> 'rule', 'blocking', blk,
      'on_demand', od, 'escalated', od, 'state', stt, 'current', is_open and blk and c = a.stage, 'people', ppl));
  end loop;
  return jsonb_build_object(
    'opinions', coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(o.user_id), 'opinion', o.opinion, 'comment', o.comment, 'at', o.updated_at) order by o.updated_at)
                            from public.absence_opinions o where o.absence_id = a.id and o.step is null), '[]'::jsonb),
    'steps', steps,
    'escalation', case when a.escalated_at is not null then jsonb_build_object('by', public.member_name(a.escalated_by), 'at', a.escalated_at, 'note', a.escalation_note) end,
    'final', case when a.decided_at is not null and a.status <> 'requested' then
               jsonb_build_object('by', case when a.decided_by is null then null else public.member_name(a.decided_by) end, 'at', a.decided_at, 'decision', a.decision, 'comment', a.decision_comment) end,
    'history', coalesce((select jsonb_agg(jsonb_build_object('decision', l.decision, 'by', case when l.decided_by is null then null else public.member_name(l.decided_by) end,
                           'at', l.decided_at, 'comment', l.comment) order by l.decided_at, l.id)
                          from (select * from public.absence_decision_log where absence_id = a.id order by decided_at desc, id desc limit 20) l), '[]'::jsonb));
end;
$$;

-- Toutes les demandes (hors brouillons) qui touchent la fenêtre : en cours, validées, refusées pas encore purgées, annulées. Direction et administration seulement.
create or replace function public.absence_track(p_from date, p_to date)
returns table(id bigint, user_id uuid, name text, role text, clinics text[], kind text, note text, start_date date, end_date date, status text, change_type text, change_kind text,
  change_note text, change_start date, change_end date, submitted_at timestamptz, step_label text, escalated boolean, trail jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 800 then raise exception 'Fenêtre trop longue (800 jours au plus).'; end if;
  return query
    select a.id, a.user_id, public.member_name(a.user_id), (select p.role from public.profiles p where p.id = a.user_id),
           public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, a.note, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, a.change_note, a.change_start, a.change_end, a.submitted_at,
           case when public.absence_is_open(a) then public.absence_col_label(a) end, a.escalated_at is not null, public.absence_track_trail(a)
    from public.absences a
    where a.status <> 'draft'
      and ((a.start_date <= p_to and a.end_date >= p_from) or (a.change_start is not null and a.change_start <= p_to and a.change_end >= p_from))
      and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
    order by a.start_date, public.member_name(a.user_id), a.id;
end;
$$;

-- 6. Droits ------------------------------------------------------------------------------------------------------------------------

-- Fonctions internes : fermées à tous les rôles de l'API
revoke execute on function
  public.absence_escalation_state(uuid, public.absences), public.absence_circuit_refresh_od(public.absences), public.absence_solicited_people(public.absences), public.absence_document_build(bigint[], text, boolean),
  public.absence_track_trail(public.absences), public.absence_document_create(bigint[], text), public.absence_enqueue(text, uuid, bigint[], jsonb),
  public.absence_circuit_steps_json(bigint), public.absence_circuit_steps_named(bigint), public.absence_circuit_normalize(jsonb),
  public.absence_circuit_build(text, date, date, jsonb, uuid), public.absence_first_stop(uuid, date, date, jsonb),
  public.absence_advance(bigint, uuid, text, boolean, boolean, int), public.absence_open_round_core(bigint, boolean), public.absence_circuit_public(public.absences),
  public.absence_in_personnes_step(uuid, public.absences), public.absence_circuit_simulate_core(uuid, date, date, text, jsonb, bigint), public.notification_kinds_for(uuid)
  from public, anon, authenticated;

-- Appelées par la fonction Edge notify-absence (rôle service)
revoke execute on function public.absence_pdf_access(uuid, bigint[]), public.absence_form_current(bigint[]), public.absence_notification_ids(uuid, bigint[], text)
  from public, anon, authenticated;
grant execute on function public.absence_pdf_access(uuid, bigint[]), public.absence_form_current(bigint[]), public.absence_notification_ids(uuid, bigint[], text) to service_role;

-- Appelées par les pages (utilisateurs connectés ; les contrôles de droits sont dans chaque fonction)
revoke execute on function
  public.absence_visa_escalate(bigint, text), public.absence_track(date, date), public.absence_to_validate(), public.absence_list(uuid),
  public.absence_circuit_save(jsonb, bigint), public.absence_circuit_create(text, bigint), public.absence_circuit_overview(), public.absence_circuit_simulate(uuid, date, date, text, jsonb, bigint)
  from public, anon;
grant execute on function
  public.absence_visa_escalate(bigint, text), public.absence_track(date, date), public.absence_to_validate(), public.absence_list(uuid),
  public.absence_circuit_save(jsonb, bigint), public.absence_circuit_create(text, bigint), public.absence_circuit_overview(), public.absence_circuit_simulate(uuid, date, date, text, jsonb, bigint)
  to authenticated;

insert into public.onconic_migrations(version) values ('202611230002') on conflict do nothing;

commit;
