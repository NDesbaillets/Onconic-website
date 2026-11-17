-- Circuit de validation des absences décrit en données (phase 2A : moteur SQL).
-- Transactionnel et réexécutable. Le comportement par défaut (pré-avis, validateurs de clinique, visa de la direction) reste identique.
--
-- Modèle
--  * absence_circuit_steps : étapes configurées (pos 0 = pré-avis, traité à part ; autres étapes bloquantes ou non).
--  * absences.circuit : instantané figé à l'ouverture de la ronde (étapes applicables, sans le pré-avis).
--  * absences.stage : pos de l'étape bloquante en cours (10 = clinique, 20 = visa par défaut).
--    Les résultats de absence_list, absence_to_validate, absence_export et absence_planning gardent un `stage` de compatibilité
--    (1 = validateurs de clinique, 2 = toute autre étape) en attendant l'adaptation de l'interface (phase 2B), et ajoutent step_kind / step_label.
--  * absence_approvals.step : étape de l'approbation (clé primaire absence_id, step, validator_id).
--  * absence_opinions.step : étape non bloquante qui a demandé l'avis (null = pré-avis de la direction).
begin;

-- 1. Tables ---------------------------------------------------------------------------------------------------------------

create table if not exists public.absence_circuit_steps (
  id bigint generated always as identity primary key,
  pos int not null unique check (pos between 0 and 9999),
  kind text not null check (kind in ('preavis', 'clinique', 'visa', 'personnes')),
  label text not null check (char_length(label) between 1 and 80),
  rule text not null default 'all' check (rule in ('all', 'any')),
  blocking boolean not null default true,
  active boolean not null default true,
  persons uuid[] not null default '{}',
  kinds text[] check (kinds <@ array['vacances', 'congres', 'autre']::text[] and cardinality(kinds) > 0),
  min_days int check (min_days between 1 and 365),
  pdf_slot text check (pdf_slot in ('chef_service')),
  check ((kind = 'preavis') = (pos = 0)),
  check (kind <> 'preavis' or blocking = false),
  check (kind <> 'visa' or rule = 'any')
);
create unique index if not exists absence_circuit_steps_kind_once on public.absence_circuit_steps (kind) where kind in ('preavis', 'clinique', 'visa');
alter table public.absence_circuit_steps enable row level security;
revoke all on public.absence_circuit_steps from public, anon, authenticated;

create table if not exists public.absence_circuit_log (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  before jsonb,
  after jsonb
);
alter table public.absence_circuit_log enable row level security;
revoke all on public.absence_circuit_log from public, anon, authenticated;

insert into public.absence_circuit_steps (pos, kind, label, rule, blocking, active, persons, pdf_slot)
select v.pos, v.kind, v.label, v.rule, v.blocking, v.active, '{}'::uuid[], v.pdf_slot
from (values
  (0,  'preavis',   'Pré-avis de la direction',                 'all', false, true,  null::text),
  (10, 'clinique',  'Validateurs de clinique',                  'all', true,  true,  null),
  (20, 'visa',      'Visa de la direction',                     'any', true,  true,  null),
  (30, 'personnes', 'Validation de la cheffe de service',       'any', true,  false, 'chef_service')
) as v(pos, kind, label, rule, blocking, active, pdf_slot)
where not exists (select 1 from public.absence_circuit_steps);

-- 2. Colonnes existantes et reprise des demandes en cours -------------------------------------------------------------------

alter table public.absences add column if not exists circuit jsonb;

do $$
begin
  -- l'ancienne contrainte (stage 1 ou 2) n'existe plus après la première exécution
  if exists (select 1 from pg_constraint where conrelid = 'public.absences'::regclass and conname = 'absences_stage_check') then
    alter table public.absences drop constraint absences_stage_check;
  end if;
end $$;
alter table public.absences alter column stage type int;
alter table public.absences alter column stage set default 10;
-- reprise des demandes en cours (réexécutable : l'instantané n'est posé que s'il manque, le remappage ne touche que les anciennes valeurs 1 et 2)
update public.absences set circuit = '[{"pos":10,"kind":"clinique","label":"Validateurs de clinique","rule":"all","blocking":true,"persons":[],"pdf_slot":null},{"pos":20,"kind":"visa","label":"Visa de la direction","rule":"any","blocking":true,"persons":[],"pdf_slot":null}]'::jsonb
  where circuit is null and (status = 'requested' or (status = 'approved' and change_type is not null));
update public.absences set stage = stage * 10 where stage in (1, 2);

alter table public.absence_approvals add column if not exists step int not null default 10;
do $$
declare d text; n text;
begin
  select conname, pg_get_constraintdef(oid) into n, d from pg_constraint where conrelid = 'public.absence_approvals'::regclass and contype = 'p';
  if d = 'PRIMARY KEY (absence_id, validator_id)' then
    execute format('alter table public.absence_approvals drop constraint %I', n);
    alter table public.absence_approvals add constraint absence_approvals_pkey primary key (absence_id, step, validator_id);
  end if;
end $$;

alter table public.absence_opinions add column if not exists step int;

-- Nouveau type de message : prévenir les autres validateurs d'un refus (peer_rejected)
do $$
declare n text; d text;
begin
  select conname, pg_get_constraintdef(oid) into n, d from pg_constraint where conrelid = 'public.absence_outbox'::regclass and conname = 'absence_outbox_kind_check';
  if n is null then
    alter table public.absence_outbox add constraint absence_outbox_kind_check check (kind in
      ('to_validate', 'to_validate_change', 'approved', 'rejected', 'change_approved', 'change_rejected', 'form', 'to_direction', 'direction_change', 'to_opinion', 'peer_rejected'));
  elsif position('peer_rejected' in d) = 0 then
    execute format('alter table public.absence_outbox drop constraint %I', n);
    alter table public.absence_outbox add constraint absence_outbox_kind_check check (kind in
      ('to_validate', 'to_validate_change', 'approved', 'rejected', 'change_approved', 'change_rejected', 'form', 'to_direction', 'direction_change', 'to_opinion', 'peer_rejected'));
  end if;
end $$;

-- 3. Fonctions internes ------------------------------------------------------------------------------------------------------

create or replace function public.absence_circuit_steps_json() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('pos', s.pos, 'kind', s.kind, 'label', s.label, 'rule', s.rule, 'blocking', s.blocking, 'active', s.active,
    'persons', to_jsonb(s.persons), 'kinds', to_jsonb(s.kinds), 'min_days', s.min_days, 'pdf_slot', s.pdf_slot) order by s.pos), '[]'::jsonb)
  from public.absence_circuit_steps s;
$$;

-- Contrôle et normalisation d'un circuit proposé (enregistrement et simulation)
create or replace function public.absence_circuit_normalize(p_steps jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  e jsonb; res jsonb := '[]'::jsonb; k text; lbl text; rl text; bl boolean; ac boolean; pers uuid[]; ks jsonb; md int; slot text; ps int;
  seen int[] := '{}'; n_pre int := 0; n_cl int := 0; n_vi int := 0; uncond boolean := false; x text;
begin
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' then raise exception 'Le circuit doit être une liste d''étapes.'; end if;
  if jsonb_array_length(p_steps) > 30 then raise exception 'Trop d''étapes (30 au plus).'; end if;
  for e in select value from jsonb_array_elements(p_steps) loop
    if jsonb_typeof(e) <> 'object' then raise exception 'Étape invalide.'; end if;
    k := e ->> 'kind';
    if k is null or k not in ('preavis', 'clinique', 'visa', 'personnes') then raise exception 'Type d''étape inconnu.'; end if;
    lbl := btrim(coalesce(e ->> 'label', ''));
    if char_length(lbl) not between 1 and 80 then raise exception 'Le libellé d''une étape compte de 1 à 80 caractères.'; end if;
    if jsonb_typeof(e -> 'pos') is distinct from 'number' or (e ->> 'pos') !~ '^[0-9]{1,4}$' then raise exception 'La position d''une étape est invalide.'; end if;
    ps := (e ->> 'pos')::int;
    if ps = any (seen) then raise exception 'Deux étapes ne peuvent pas avoir la même position.'; end if;
    seen := seen || ps;
    if (k = 'preavis') <> (ps = 0) then raise exception 'La position 0 est réservée au pré-avis, et le pré-avis occupe toujours la position 0.'; end if;
    rl := coalesce(e ->> 'rule', 'all');
    if rl not in ('all', 'any') then raise exception 'La règle d''une étape doit être « all » (tous) ou « any » (un seul).'; end if;
    bl := case when jsonb_typeof(e -> 'blocking') = 'boolean' then (e ->> 'blocking')::boolean else true end;
    ac := case when jsonb_typeof(e -> 'active') = 'boolean' then (e ->> 'active')::boolean else true end;
    if k = 'visa' then rl := 'any'; end if;
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
    if k = 'personnes' and ac and coalesce(array_length(pers, 1), 0) = 0 then
      raise exception 'L''étape « % » est active : désignez au moins une personne.', lbl;
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
    if k <> 'preavis' and ac and bl and ks is null and md is null then uncond := true; end if;
    res := res || jsonb_build_array(jsonb_build_object('pos', ps, 'kind', k, 'label', lbl, 'rule', rl, 'blocking', bl, 'active', ac,
      'persons', to_jsonb(pers), 'kinds', ks, 'min_days', md, 'pdf_slot', slot));
  end loop;
  if n_pre > 1 then raise exception 'Un seul pré-avis est permis (position 0).'; end if;
  if n_cl > 1 then raise exception 'Une seule étape « Validateurs de clinique » est permise.'; end if;
  if n_vi > 1 then raise exception 'Une seule étape « Visa de la direction » est permise.'; end if;
  if not uncond then
    raise exception 'Le circuit doit comporter au moins une étape active, bloquante et sans condition de motif ni de durée.';
  end if;
  return (select jsonb_agg(v order by (v ->> 'pos')::int) from jsonb_array_elements(res) v);
end;
$$;

-- Instantané : étapes actives et applicables (motif, durée en jours ouvrables), sans le pré-avis
create or replace function public.absence_circuit_build(p_kind text, p_from date, p_to date, p_steps jsonb default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare days int; res jsonb;
begin
  days := public.absence_workdays(p_from, p_to);
  select coalesce(jsonb_agg(jsonb_build_object('pos', s.pos, 'kind', s.kind, 'label', s.label, 'rule', s.rule, 'blocking', s.blocking,
           'persons', coalesce(s.persons, '[]'::jsonb), 'pdf_slot', s.pdf_slot) order by s.pos), '[]'::jsonb)
    into res
    from jsonb_to_recordset(coalesce(p_steps, public.absence_circuit_steps_json()))
         as s(pos int, kind text, label text, rule text, blocking boolean, active boolean, persons jsonb, kinds jsonb, min_days int, pdf_slot text)
   where s.active and s.kind <> 'preavis'
     and (s.kinds is null or jsonb_typeof(s.kinds) <> 'array' or s.kinds @> to_jsonb(p_kind))
     and (s.min_days is null or days >= s.min_days);
  if not exists (select 1 from jsonb_array_elements(res) e where (e ->> 'blocking')::boolean) then
    -- garde-fou : sans étape bloquante, on revient au circuit d'origine
    res := '[{"pos":10,"kind":"clinique","label":"Validateurs de clinique","rule":"all","blocking":true,"persons":[],"pdf_slot":null},{"pos":20,"kind":"visa","label":"Visa de la direction","rule":"any","blocking":true,"persons":[],"pdf_slot":null}]'::jsonb;
  end if;
  return res;
end;
$$;

create or replace function public.absence_circuit_for(a public.absences) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select public.absence_circuit_build(
    case when a.change_type = 'modify' then a.change_kind else a.kind end,
    case when a.change_type = 'modify' then a.change_start else a.start_date end,
    case when a.change_type = 'modify' then a.change_end else a.end_date end, null);
$$;

create or replace function public.absence_step_of(a public.absences) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select e from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e where (e ->> 'pos')::int = a.stage limit 1;
$$;

create or replace function public.absence_is_open(a public.absences) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select a.status = 'requested' or (a.status = 'approved' and a.change_type is not null);
$$;

create or replace function public.absence_step_people_for(p_user uuid, p_from date, p_to date, s jsonb) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select case s ->> 'kind'
    when 'clinique' then public.absence_required_validators(p_user, p_from, p_to)
    when 'visa' then public.absence_direction_recipients(p_user)
    when 'personnes' then coalesce(array(
      select q.x from (select distinct v::uuid as x from jsonb_array_elements_text(coalesce(s -> 'persons', '[]'::jsonb)) v) q
       where q.x <> p_user and public.tool_allowed(q.x, 'absences') order by q.x), '{}'::uuid[])
    else '{}'::uuid[] end;
$$;

create or replace function public.absence_step_people(a public.absences, s jsonb) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select public.absence_step_people_for(a.user_id, public.absence_lo(a), public.absence_hi(a), s);
$$;

create or replace function public.absence_step_kind(a public.absences, p_step int) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when a.circuit is null then case when p_step = 10 then 'clinique' end
              else (select e ->> 'kind' from jsonb_array_elements(a.circuit) e where (e ->> 'pos')::int = p_step limit 1) end;
$$;

-- Personnes des étapes non bloquantes de l'instantané (avis demandés)
create or replace function public.absence_nonblocking_people(a public.absences) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array(select distinct x from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e,
                        unnest(public.absence_step_people(a, e)) x
                        where not (e ->> 'blocking')::boolean), '{}'::uuid[]);
$$;

-- Personnes prévenues d'un refus : tous ceux qui ont une ligne d'approbation, plus la direction déjà sollicitée au visa si le refus vient d'une étape postérieure
create or replace function public.absence_peer_people(a public.absences) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array(
    select q.x from (
      select p.validator_id as x from public.absence_approvals p where p.absence_id = a.id
      union
      select unnest(public.absence_direction_recipients(a.user_id))
        where exists (select 1 from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e where e ->> 'kind' = 'visa' and (e ->> 'pos')::int < a.stage)
    ) q where q.x <> a.user_id and public.tool_allowed(q.x, 'absences') order by q.x), '{}'::uuid[]);
$$;

-- Étape de repli : aucune étape bloquante n'a de personne, la demande va aux destinataires du visa (direction, sinon administrateurs)
create or replace function public.absence_circuit_fallback() returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select '{"pos":1000,"kind":"visa","label":"Visa de la direction (repli)","rule":"any","blocking":true,"persons":[],"pdf_slot":null}'::jsonb;
$$;

-- Première étape bloquante qui retient la demande : étape avec personnes (le visa n'est jamais sauté)
create or replace function public.absence_first_stop(p_user uuid, p_from date, p_to date, p_circuit jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e jsonb; ppl uuid[];
begin
  for e in select value from jsonb_array_elements(coalesce(p_circuit, '[]'::jsonb)) order by (value ->> 'pos')::int loop
    if (e ->> 'blocking')::boolean then
      ppl := public.absence_step_people_for(p_user, p_from, p_to, e);
      if coalesce(array_length(ppl, 1), 0) > 0 or e ->> 'kind' = 'visa' then
        return jsonb_build_object('step', e, 'people', to_jsonb(ppl));
      end if;
    end if;
  end loop;
  return jsonb_build_object('step', public.absence_circuit_fallback(), 'people', to_jsonb(public.absence_direction_recipients(p_user)));
end;
$$;

create or replace function public.absence_preavis_active() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.absence_circuit_steps where kind = 'preavis' and active);
$$;

-- Pré-avis encore utile : demande en cours, avant l'étape de visa
create or replace function public.absence_preavis_open(a public.absences) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.absence_preavis_active() and public.absence_is_open(a)
     and a.stage < coalesce((select (e ->> 'pos')::int from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e where e ->> 'kind' = 'visa' limit 1), 2147483647);
$$;

-- `stage` de compatibilité pour l'interface actuelle : 1 = validateurs de clinique, 2 = toute autre étape
create or replace function public.absence_stage_compat(a public.absences) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select case coalesce(public.absence_step_of(a) ->> 'kind', case when a.stage >= 20 then 'visa' else 'clinique' end) when 'clinique' then 1 else 2 end;
$$;

-- Instantané exposé à l'interface : sans identifiants de personnes, avec l'étape en cours
create or replace function public.absence_circuit_public(a public.absences) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when a.circuit is null then null else
    (select coalesce(jsonb_agg((t.e - 'persons') || case when (t.e ->> 'pos')::int = a.stage then '{"current":true}'::jsonb else '{}'::jsonb end order by t.ord), '[]'::jsonb)
       from jsonb_array_elements(a.circuit) with ordinality t(e, ord)) end;
$$;

-- Droit de donner un avis : étape non bloquante de l'instantané, ou pré-avis de la direction et des administrateurs
create or replace function public.absence_opinion_step(p_uid uuid, a public.absences) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e jsonb; r text;
begin
  for e in select value from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) order by (value ->> 'pos')::int loop
    if not (e ->> 'blocking')::boolean and p_uid = any (public.absence_step_people(a, e)) then
      return jsonb_build_object('step', (e ->> 'pos')::int, 'label', e ->> 'label');
    end if;
  end loop;
  select role into r from public.profiles where id = p_uid;
  if r in ('direction', 'admin') and public.absence_preavis_active() then
    return jsonb_build_object('step', null, 'label', (select label from public.absence_circuit_steps where kind = 'preavis' limit 1));
  end if;
  return null;
end;
$$;

-- 4. Moteur ------------------------------------------------------------------------------------------------------------------

-- Passe à l'étape bloquante suivante, ou conclut la demande. Notifications d'avis des étapes non bloquantes rencontrées avant l'arrêt.
-- p_after : position de départ (par défaut l'étape en cours) ; -1 pour partir du début d'un nouveau tour.
do $$
begin
  if to_regprocedure('public.absence_advance(bigint,uuid,text,boolean,boolean)') is not null then
    drop function public.absence_advance(bigint, uuid, text, boolean, boolean);
  end if;
end $$;
create or replace function public.absence_advance(p_id bigint, p_by uuid default null, p_comment text default null,
                                                  p_mail_stop boolean default true, p_mail_opinion boolean default true, p_after int default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.absences; s jsonb; ppl uuid[]; r uuid; k text; v_from int; circ jsonb; ops jsonb[] := '{}'; o jsonb;
begin
  select * into a from public.absences where id = p_id for update;
  if not found then return; end if;
  v_from := coalesce(p_after, a.stage);
  for s in select value from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) order by (value ->> 'pos')::int loop
    continue when (s ->> 'pos')::int <= v_from;
    ppl := public.absence_step_people(a, s);
    k := s ->> 'kind';
    if not (s ->> 'blocking')::boolean then
      ops := ops || s;
      continue;
    end if;
    if coalesce(array_length(ppl, 1), 0) = 0 and k <> 'visa' then continue; end if;
    update public.absences set stage = (s ->> 'pos')::int where id = p_id;
    if p_mail_opinion then
      foreach o in array ops loop
        foreach r in array public.absence_step_people(a, o) loop
          perform public.absence_enqueue('to_opinion', r, array[p_id], jsonb_build_object('owner', public.member_name(a.user_id), 'step_label', o ->> 'label'));
        end loop;
      end loop;
    end if;
    if k in ('clinique', 'personnes') then
      insert into public.absence_approvals (absence_id, step, validator_id)
        select p_id, (s ->> 'pos')::int, v from unnest(ppl) v on conflict (absence_id, step, validator_id) do nothing;
      if p_mail_stop then
        foreach r in array ppl loop
          perform public.absence_enqueue(case when a.change_type is not null then 'to_validate_change' else 'to_validate' end, r, array[p_id],
                                         jsonb_build_object('owner', public.member_name(a.user_id)));
        end loop;
      end if;
    elsif p_mail_stop then
      perform public.absence_enqueue_direction(array[p_id], a.user_id);
    end if;
    return;
  end loop;
  -- Fin de chaîne. Jamais d'approbation automatique sans aucune décision humaine : la demande passe à l'étape de repli (visa de la direction, sinon administrateurs).
  if p_by is null and not exists (select 1 from public.absence_approvals where absence_id = p_id and decision = 'approved') then
    circ := coalesce(a.circuit, '[]'::jsonb);
    if not exists (select 1 from jsonb_array_elements(circ) e where (e ->> 'pos')::int = 1000) then circ := circ || jsonb_build_array(public.absence_circuit_fallback()); end if;
    update public.absences set circuit = circ, stage = 1000 where id = p_id;
    if p_mail_stop then perform public.absence_enqueue_direction(array[p_id], a.user_id); end if;
    return;
  end if;
  perform public.absence_finalize_approve(p_id, p_by, p_comment);
end;
$$;

create or replace function public.absence_finalize_reject(p_id bigint, p_by uuid, p_comment text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.absences; k text := 'rejected'; r uuid;
begin
  select * into a from public.absences where id = p_id for update;
  if a.change_type is null then
    update public.absences set status = 'rejected', decision = 'rejected' where id = p_id;
  else
    k := 'change_rejected';
    update public.absences set decision = 'change_rejected', change_type = null, change_kind = null, change_note = null,
      change_start = null, change_end = null, change_requested_at = null where id = p_id;
  end if;
  update public.absences set decision_comment = p_comment, decided_by = p_by, decided_at = now(), notified_decision_at = null where id = p_id;
  update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
  perform public.absence_enqueue(k, a.user_id, array[p_id], jsonb_build_object('by', public.member_name(p_by), 'comment', p_comment));
  -- les autres validateurs sont prévenus du refus (hors celui qui refuse et le demandeur)
  foreach r in array public.absence_peer_people(a) loop
    if r is distinct from p_by then
      perform public.absence_enqueue('peer_rejected', r, array[p_id], jsonb_build_object('owner', public.member_name(a.user_id), 'by', public.member_name(p_by),
        'comment', p_comment, 'step_label', public.absence_step_label(a, a.stage)));
    end if;
  end loop;
  -- un refus peut être la dernière décision d'un envoi dont les autres absences sont déjà validées
  if k = 'rejected' then perform public.absence_form_after(p_id); end if;
end;
$$;

create or replace function public.absence_open_round_core(p_id bigint, p_notify boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.absences;
begin
  select * into a from public.absences where id = p_id;
  if not found then return; end if;
  delete from public.absence_approvals where absence_id = p_id;
  delete from public.absence_opinions where absence_id = p_id;
  update public.absences set circuit = public.absence_circuit_for(a) where id = p_id;
  -- les e-mails de la première étape bloquante sont envoyés par l'appelant (envoi, demande de changement)
  perform public.absence_advance(p_id, null, null, false, p_notify, -1);
end;
$$;

create or replace function public.absence_open_round(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_open_round_core(p_id, true);
end;
$$;

create or replace function public.absence_try_complete(p_id bigint, p_by uuid, p_comment text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.absences; s jsonb; k text; ppl uuid[]; pend int; apr int;
begin
  select * into a from public.absences where id = p_id for update;
  if not found or not public.absence_is_open(a) then return false; end if;
  s := public.absence_step_of(a);
  k := s ->> 'kind';
  if s is null or k not in ('clinique', 'personnes') then return false; end if;
  ppl := case when k = 'personnes' then public.absence_step_people(a, s) end;
  select count(*) filter (where decision = 'pending' and (case when k = 'clinique'
                              then public.can_validate_absence(validator_id, a.user_id, public.absence_lo(a), public.absence_hi(a))
                              else validator_id = any (ppl) end)),
         count(*) filter (where decision = 'approved')
    into pend, apr from public.absence_approvals where absence_id = p_id and step = a.stage;
  if s ->> 'rule' = 'any' then
    if apr = 0 and pend > 0 then return false; end if;
    update public.absence_approvals set decision = 'skipped' where absence_id = p_id and step = a.stage and decision = 'pending';
  elsif pend > 0 then
    return false;
  end if;
  perform public.absence_advance(p_id, p_by, p_comment);
  return true;
end;
$$;

create or replace function public.absence_decide(p_id bigint, p_approve boolean, p_comment text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); a public.absences; c text := nullif(trim(coalesce(p_comment, '')), ''); r text; d text; s jsonb; k text; at_visa boolean; rstep int;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  r := public.current_role_name();
  s := public.absence_step_of(a);
  k := s ->> 'kind';
  at_visa := k = 'visa' and r <> 'admin';
  if at_visa then
    if not (r = 'direction' and uid <> a.user_id) then raise exception 'Cette demande attend le visa de la direction.' using errcode = '42501'; end if;
  elsif k = 'personnes' and r <> 'admin' then
    if not (uid = any (public.absence_step_people(a, s))) then raise exception 'Vous ne validez pas cette étape de la demande.' using errcode = '42501'; end if;
  elsif not public.can_validate_absence(uid, a.user_id, public.absence_lo(a), public.absence_hi(a)) then
    raise exception 'Vous ne validez pas les absences de ce membre.' using errcode = '42501';
  end if;
  if not public.absence_is_open(a) then raise exception 'Cette absence n''attend aucune décision.'; end if;
  if not coalesce(p_approve, false) and char_length(coalesce(c, '')) < 3 then raise exception 'Un refus demande un commentaire.'; end if;
  if char_length(coalesce(c, '')) > 500 then raise exception 'Commentaire trop long (500 caractères au plus).'; end if;

  if at_visa then
    if p_approve then
      update public.absences set direction_by = uid, direction_at = now() where id = p_id;
      perform public.absence_advance(p_id, uid, c);
    else
      perform public.absence_finalize_reject(p_id, uid, c);
    end if;
  else
    -- l'approbation d'un administrateur au visa est rattachée à l'étape de clinique (signataire du formulaire, comme avant)
    rstep := a.stage;
    if r = 'admin' and k = 'visa' then
      rstep := coalesce((select (e ->> 'pos')::int from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e where e ->> 'kind' = 'clinique' limit 1), a.stage);
    end if;
    select decision into d from public.absence_approvals where absence_id = p_id and step = rstep and validator_id = uid;
    if d in ('approved', 'rejected') and r <> 'admin' then raise exception 'Vous avez déjà donné votre décision.'; end if;
    insert into public.absence_approvals (absence_id, step, validator_id, decision, comment, decided_at)
      values (p_id, rstep, uid, case when p_approve then 'approved' else 'rejected' end, c, now())
      on conflict (absence_id, step, validator_id) do update set decision = excluded.decision, comment = excluded.comment, decided_at = excluded.decided_at;
    if not p_approve then
      perform public.absence_finalize_reject(p_id, uid, c);
    elsif r = 'admin' then
      -- l'administrateur tranche seul : toute la chaîne est soldée, son nom tient lieu de visa de la direction
      update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
      update public.absences set direction_by = uid, direction_at = now() where id = p_id;
      perform public.absence_finalize_approve(p_id, uid, c);
    else
      perform public.absence_try_complete(p_id, uid, c);
    end if;
  end if;
  return (select case when status = 'requested' or (status = 'approved' and change_type is not null) then 'requested' else status end from public.absences where id = p_id);
end;
$$;

create or replace function public.absence_actionable(p_uid uuid, a public.absences) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_uid is null or not public.tool_allowed(p_uid, 'absences') then false
    when (select role from public.profiles where id = p_uid) = 'admin' then true
    when public.absence_step_of(a) ->> 'kind' = 'visa' then (select role from public.profiles where id = p_uid) = 'direction' and p_uid <> a.user_id
    when public.absence_step_of(a) ->> 'kind' = 'personnes' then p_uid = any (public.absence_step_people(a, public.absence_step_of(a)))
         and not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.step = a.stage and p.validator_id = p_uid and p.decision = 'approved')
    else public.can_validate_absence(p_uid, a.user_id, public.absence_lo(a), public.absence_hi(a))
         and not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.step = a.stage and p.validator_id = p_uid and p.decision = 'approved')
  end;
$$;

-- 5. Notifications -----------------------------------------------------------------------------------------------------------

create or replace function public.absence_enqueue(p_kind text, p_recipient uuid, p_ids bigint[], p_payload jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids bigint[]; oid bigint;
begin
  select array_agg(a.id order by a.start_date, a.id) into ids from public.absences a where a.id = any (p_ids) and (
    case when p_kind in ('to_validate', 'to_validate_change') then
      p_recipient = any (public.absence_step_people(a, public.absence_step_of(a)))
    when p_kind in ('approved', 'rejected', 'change_approved', 'change_rejected', 'direction_change') then p_recipient = a.user_id
    when p_kind = 'to_opinion' then
      (public.absence_preavis_active() and p_recipient = any (public.absence_opinion_recipients(a.user_id)))
      or p_recipient = any (public.absence_nonblocking_people(a))
    when p_kind = 'peer_rejected' then p_recipient = any (public.absence_peer_people(a))
    else false end)
  -- un seul message d'avis par personne et par tour, qu'il vienne du pré-avis ou d'une étape non bloquante
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
      public.absence_is_open(a) and p_recipient = any (public.absence_step_people(a, public.absence_step_of(a)))
    when p_kind = 'to_direction' then
      public.absence_is_open(a) and public.absence_step_of(a) ->> 'kind' = 'visa' and p_recipient = any (public.absence_step_people(a, public.absence_step_of(a)))
    when p_kind = 'to_opinion' then
      public.absence_is_open(a) and ((public.absence_preavis_open(a) and p_recipient = any (public.absence_opinion_recipients(a.user_id)))
                                     or p_recipient = any (public.absence_nonblocking_people(a)))
    when p_kind = 'peer_rejected' then a.decision in ('rejected', 'change_rejected') and p_recipient = any (public.absence_peer_people(a))
    when p_kind in ('approved', 'rejected', 'change_approved', 'change_rejected', 'direction_change') then a.user_id = p_recipient
    else false end;
$$;

create or replace function public.absence_resend_pairs(p_user uuid, p_ids bigint[]) returns table(absence_id bigint, recipient uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.absences; s jsonb; k text; r uuid; n int;
begin
  for a in select x.* from public.absences x where x.id = any (p_ids) loop
    s := public.absence_step_of(a);
    k := s ->> 'kind';
    n := 0;
    if k is distinct from 'visa' then
      for r in select p.validator_id from public.absence_approvals p
                where p.absence_id = a.id and p.decision = 'pending' and p.step = a.stage
                  and (case when k = 'personnes' then p.validator_id = any (public.absence_step_people(a, s))
                            else public.can_validate_absence(p.validator_id, p_user, public.absence_lo(a), public.absence_hi(a)) end) loop
        n := n + 1;
        absence_id := a.id; recipient := r; return next;
      end loop;
    end if;
    if n = 0 then
      for r in select unnest(case when k = 'visa' or k = 'personnes' then public.absence_step_people(a, s) else public.absence_direction_recipients(p_user) end) loop
        absence_id := a.id; recipient := r; return next;
      end loop;
    end if;
  end loop;
end;
$$;

create or replace function public.absence_my_validators() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); v uuid[] := '{}'; fb boolean := false; a record; fs jsonb; first_step jsonb;
begin
  perform public.absence_guard();
  if exists (select 1 from public.absences where user_id = uid and status = 'draft') then
    for a in select x.kind, x.start_date, x.end_date from public.absences x where x.user_id = uid and x.status = 'draft' order by x.start_date, x.id loop
      fs := public.absence_first_stop(uid, a.start_date, a.end_date, public.absence_circuit_build(a.kind, a.start_date, a.end_date, null));
      first_step := coalesce(first_step, fs -> 'step');
      if fs -> 'step' ->> 'kind' = 'visa' then fb := true; end if;
      v := v || array(select p::uuid from jsonb_array_elements_text(fs -> 'people') p where not (p::uuid = any (v)));
    end loop;
  else
    fs := public.absence_first_stop(uid, public.ch_today(), public.ch_today(), public.absence_circuit_build('vacances', public.ch_today(), public.ch_today(), null));
    first_step := fs -> 'step';
    fb := fs -> 'step' ->> 'kind' = 'visa';
    v := array(select p::uuid from jsonb_array_elements_text(fs -> 'people') p);
  end if;
  return jsonb_build_object('fallback', fb, 'step_kind', first_step ->> 'kind', 'step_label', first_step ->> 'label',
    'validators', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by public.member_name(x)) from unnest(v) x), '[]'::jsonb));
end;
$$;

create or replace function public.absence_submit() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); ids bigint[]; rec uuid[]; who jsonb; fb boolean; op uuid[];
begin
  perform public.absence_guard();
  perform public.absence_purge();
  who := public.absence_my_validators();
  fb := (who ->> 'fallback')::boolean;
  select array_agg(id order by start_date) into ids from public.absences where user_id = uid and status = 'draft';
  if ids is null then raise exception 'Aucune demande en brouillon à envoyer.'; end if;
  update public.absences set status = 'requested', submitted_at = now(), notified_at = null, decision = null, decision_comment = null,
    decided_by = null, decided_at = null where id = any (ids);
  perform public.absence_open_round(i) from unnest(ids) i;
  select coalesce(array_agg((x ->> 'id')::uuid), '{}') into rec from jsonb_array_elements(who -> 'validators') x;
  perform public.absence_enqueue('to_validate', r, ids, jsonb_build_object('owner', public.member_name(uid))) from unnest(rec) r;
  -- Pré-avis de la direction, en parallèle et sans bloquer : pas de doublon pour qui reçoit déjà le message de validation
  if public.absence_preavis_active() then
    op := array(select x from unnest(public.absence_opinion_recipients(uid)) x where not (x = any (rec)));
    perform public.absence_enqueue('to_opinion', r, ids, jsonb_build_object('owner', public.member_name(uid))) from unnest(op) r;
  end if;
  return jsonb_build_object('count', array_length(ids, 1), 'ids', to_jsonb(ids), 'fallback', fb, 'validators', who -> 'validators');
end;
$$;

create or replace function public.absence_request_change(p_id bigint, p_type text, p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); a public.absences; res jsonb; rec uuid[]; op uuid[];
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id and user_id = uid for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if a.status <> 'approved' then raise exception 'Seule une absence validée appelle une demande de modification.'; end if;
  if a.change_type is not null then raise exception 'Une demande est déjà en cours pour cette absence.'; end if;
  if p_type = 'delete' then
    update public.absences set change_type = 'delete', change_requested_at = now(), notified_at = null where id = p_id;
    res := jsonb_build_object('id', p_id, 'conflicts', '[]'::jsonb);
  elsif p_type = 'modify' then
    perform public.absence_check(uid, p_id, p_kind, n, p_start, p_end);
    update public.absences set change_type = 'modify', change_kind = p_kind, change_note = n, change_start = p_start, change_end = p_end,
      change_requested_at = now(), notified_at = null where id = p_id;
    res := jsonb_build_object('id', p_id, 'conflicts', public.absence_conflicts_json(uid, p_start, p_end));
  else
    raise exception 'Type de demande inconnu.';
  end if;
  perform public.absence_open_round(p_id);
  select * into a from public.absences where id = p_id;
  rec := public.absence_step_people(a, public.absence_step_of(a));
  perform public.absence_enqueue('to_validate_change', r, array[p_id], jsonb_build_object('owner', public.member_name(uid))) from unnest(rec) r;
  if public.absence_preavis_active() then
    op := array(select x from unnest(public.absence_opinion_recipients(uid)) x where not (x = any (rec)));
    perform public.absence_enqueue('to_opinion', r, array[p_id], jsonb_build_object('owner', public.member_name(uid))) from unnest(op) r;
  end if;
  return res;
end;
$$;

create or replace function public.absence_reroute(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  for r in select a.id from public.absences a
           where a.user_id = p_user and (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null))
             and not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.decision <> 'pending') loop
    perform public.absence_open_round_core(r.id, false);
  end loop;
end;
$$;

-- Types de notification proposés (préférences de Mon compte) : ajout de peer_rejected pour les validateurs, la direction et les personnes d'une étape
create or replace function public.notification_kinds_for(p_user uuid) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare r text; v boolean; k text[] := '{}'; validator boolean; direction boolean;
begin
  select role, coalesce(absence_validator, false) into r, v from public.profiles where id = p_user;
  if r is null or r = 'member' then return '{}'; end if;
  validator := r = 'admin' or v;
  direction := r in ('direction', 'admin');
  if validator then k := k || array['to_validate', 'to_validate_change']; end if;
  if direction then k := k || array['to_direction', 'to_opinion']; end if;
  if validator or direction then k := k || array['reminder']; end if;
  if validator or direction or exists (select 1 from public.absence_circuit_steps s where s.kind = 'personnes' and s.active and p_user = any (s.persons)) then
    k := k || array['peer_rejected'];
  end if;
  if public.tool_allowed(p_user, 'absences') then
    k := k || array['approved', 'rejected', 'change_approved', 'change_rejected', 'direction_change'];
  end if;
  if public.tool_allowed(p_user, 'congres') then k := k || array['event_join']; end if;
  return k;
end;
$$;
revoke execute on function public.notification_kinds_for(uuid) from public, anon, authenticated;

-- 6. Avis (pré-avis de la direction et étapes non bloquantes) -----------------------------------------------------------------

create or replace function public.absence_opinion_set(p_id bigint, p_opinion text, p_comment text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); a public.absences; c text := nullif(trim(coalesce(p_comment, '')), ''); os jsonb;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id;
  if not found then
    if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
    raise exception 'Absence introuvable.';
  end if;
  os := public.absence_opinion_step(uid, a);
  if os is null then
    if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
    raise exception 'Aucun pré-avis n''est demandé.';
  end if;
  if a.user_id = uid then raise exception 'Pas de pré-avis sur vos propres absences.' using errcode = '42501'; end if;
  if not public.absence_is_open(a) then raise exception 'Cette absence n''attend aucune décision.'; end if;
  if p_opinion is null then
    delete from public.absence_opinions where absence_id = p_id and user_id = uid;
    return;
  end if;
  if p_opinion not in ('favorable', 'defavorable') then raise exception 'Pré-avis inconnu.'; end if;
  if p_opinion = 'defavorable' and char_length(coalesce(c, '')) < 3 then raise exception 'Un pré-avis défavorable demande un commentaire.'; end if;
  if char_length(coalesce(c, '')) > 500 then raise exception 'Commentaire trop long (500 caractères au plus).'; end if;
  insert into public.absence_opinions (absence_id, user_id, opinion, comment, step) values (p_id, uid, p_opinion, c, (os ->> 'step')::int)
    on conflict (absence_id, user_id) do update set opinion = excluded.opinion, comment = excluded.comment, step = excluded.step, updated_at = now();
end;
$$;

drop function if exists public.absence_opinion_todo();
create function public.absence_opinion_todo()
returns table(id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text, change_type text, change_kind text,
  change_note text, change_start date, change_end date, created_at timestamptz, conflicts jsonb, progress jsonb, my_opinion text, my_comment text, opinions jsonb, step_label text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.note end, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.change_note end, a.change_start, a.change_end, coalesce(a.change_requested_at, a.submitted_at, a.created_at),
           case when a.change_type = 'delete' then '[]'::jsonb
                when a.change_type = 'modify' then public.absence_conflicts_json(a.user_id, a.change_start, a.change_end)
                else public.absence_conflicts_json(a.user_id, a.start_date, a.end_date) end,
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(p.validator_id), 'decision', p.decision, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then p.comment end, 'at', p.decided_at)
                     order by public.member_name(p.validator_id)) from public.absence_approvals p where p.absence_id = a.id), '[]'::jsonb),
           (select o2.opinion from public.absence_opinions o2 where o2.absence_id = a.id and o2.user_id = auth.uid()),
           (select o2.comment from public.absence_opinions o2 where o2.absence_id = a.id and o2.user_id = auth.uid()),
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(o2.user_id), 'opinion', o2.opinion, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then o2.comment end, 'at', o2.updated_at)
                     order by o2.updated_at) from public.absence_opinions o2 where o2.absence_id = a.id and o2.user_id <> auth.uid()), '[]'::jsonb),
           x.os ->> 'label'
    from public.absences a
    cross join lateral (select public.absence_opinion_step(auth.uid(), a) as os) x
    where x.os is not null and (x.os ->> 'step' is not null or public.absence_preavis_open(a))
      and a.user_id <> auth.uid()
      and a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
    order by coalesce(a.change_requested_at, a.submitted_at, a.created_at);
end;
$$;

-- 7. Listes, export, planning, document --------------------------------------------------------------------------------------

drop function if exists public.absence_to_validate();
create function public.absence_to_validate()
returns table(id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text, change_type text, change_kind text,
  change_note text, change_start date, change_end date, created_at timestamptz, change_requested_at timestamptz, conflicts jsonb, my_decision text, progress jsonb, stage integer,
  opinions jsonb, step_kind text, step_label text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.note end, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.change_note end, a.change_start, a.change_end, coalesce(a.submitted_at, a.created_at), a.change_requested_at,
           case when a.change_type = 'delete' then '[]'::jsonb
                when a.change_type = 'modify' then public.absence_conflicts_json(a.user_id, a.change_start, a.change_end)
                else public.absence_conflicts_json(a.user_id, a.start_date, a.end_date) end,
           coalesce((select p.decision from public.absence_approvals p where p.absence_id = a.id and p.validator_id = auth.uid() order by (p.step = a.stage) desc limit 1), 'pending'),
           coalesce((select jsonb_agg(jsonb_build_object('name', r.name, 'decision', r.decision, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then r.comment end, 'at', r.at, 'step', r.step, 'step_label', r.step_label)
                     order by r.step, r.name) from public.absence_decision_rows(a) r), '[]'::jsonb),
           public.absence_stage_compat(a),
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(o.user_id), 'opinion', o.opinion, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then o.comment end, 'at', o.updated_at)
                     order by o.updated_at) from public.absence_opinions o where o.absence_id = a.id), '[]'::jsonb),
           public.absence_step_of(a) ->> 'kind', public.absence_step_of(a) ->> 'label'
    from public.absences a
    where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
      and public.absence_actionable(auth.uid(), a)
    order by coalesce(a.change_requested_at, a.submitted_at, a.created_at);
end;
$$;

create or replace function public.absence_list(p_user uuid default null) returns setof public.absences
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); perm boolean := true;
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid then
    perm := public.can_validate_absence(uid, p_user) or public.is_direction_admin();
    -- une personne d'une étape « personnes » ne voit que les demandes où elle figure dans l'instantané
    if not perm and not exists (select 1 from public.absences x where x.user_id = p_user and public.absence_in_personnes_step(uid, x)) then
      raise exception 'Accès refusé.' using errcode = '42501';
    end if;
  end if;
  -- `stage` de compatibilité (1 ou 2) ; l'instantané `circuit` marque l'étape en cours (current) et ne contient pas les personnes
  return query select (jsonb_populate_record(null::public.absences, to_jsonb(a)
      || case when a.confidential and a.user_id <> uid and not public.is_direction_admin() then jsonb_build_object('note', null,'change_note',null,'decision_comment',null) else '{}'::jsonb end
      || jsonb_build_object('stage', public.absence_stage_compat(a), 'circuit', public.absence_circuit_public(a)))).*
    from public.absences a where a.user_id = coalesce(p_user, uid) and (perm or public.absence_in_personnes_step(uid, a))
    and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
    and (a.status <> 'draft' or a.user_id = uid)
    order by a.start_date desc;
end;
$$;

drop function if exists public.absence_export(date, date);
create function public.absence_export(p_from date, p_to date)
returns table(id bigint, user_id uuid, name text, role text, clinics text[], kind text, note text, start_date date, end_date date, status text, stage integer, change_type text,
  change_kind text, change_note text, change_start date, change_end date, submitted_at timestamptz, decided_at timestamptz, decided_by_name text, decision_comment text,
  approvers text, direction_name text, direction_at timestamptz, step_kind text, step_label text, state_label text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  if not public.absence_export_allowed() then raise exception 'Réservé aux administrateurs et aux validateurs des absences.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 800 then raise exception 'Fenêtre trop longue (800 jours au plus).'; end if;
  return query
    select a.id, a.user_id, public.member_name(a.user_id), (select p.role from public.profiles p where p.id = a.user_id),
           public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, case when not a.confidential or public.is_direction_admin() then a.note end, a.start_date, a.end_date, a.status, public.absence_stage_compat(a),
           a.change_type, a.change_kind, case when not a.confidential or public.is_direction_admin() then a.change_note end, a.change_start, a.change_end, a.submitted_at, a.decided_at,
           case when a.decided_by is null then null else public.member_name(a.decided_by) end, case when not a.confidential or public.is_direction_admin() then a.decision_comment end,
           (select string_agg(public.member_name(x.validator_id) || ' (' || to_char(x.decided_at at time zone 'Europe/Zurich', 'DD.MM.YYYY HH24:MI') || ')', ', ' order by x.decided_at)
              from public.absence_approvals x where x.absence_id = a.id and x.decision = 'approved' and x.decided_at is not null),
           case when a.direction_by is null then null else public.member_name(a.direction_by) end, a.direction_at,
           case when public.absence_is_open(a) then public.absence_step_of(a) ->> 'kind' end,
           case when public.absence_is_open(a) then public.absence_step_of(a) ->> 'label' end,
           case when a.status = 'requested' then 'En cours : ' || case coalesce(public.absence_step_of(a) ->> 'kind', 'clinique')
                  when 'visa' then 'visa de la direction' when 'clinique' then 'chez les validateurs'
                  else coalesce(public.absence_step_of(a) ->> 'label', 'étape suivante') end end
    from public.absences a
    where a.status <> 'draft' and a.start_date <= p_to and a.end_date >= p_from
      and (public.is_direction_admin() or public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a)))
    order by public.member_name(a.user_id), a.start_date, a.id;
end;
$$;

create or replace function public.absence_planning(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
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
               'start_date', a.start_date, 'end_date', a.end_date, 'status', a.status, 'stage', public.absence_stage_compat(a), 'change_type', a.change_type,
               'step_kind', case when public.absence_is_open(a) then public.absence_step_of(a) ->> 'kind' end,
               'step_label', case when public.absence_is_open(a) then public.absence_step_of(a) ->> 'label' end)
             order by a.start_date, a.id)
        from public.absences a
       where a.status in ('requested', 'approved') and a.start_date <= p_to and a.end_date >= p_from
         and a.user_id in (select m.id from members m)), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

-- Document de lot figé : signataires = étape de clinique ; extra = approbations des étapes « personnes » bloquantes (case du PDF : slot)
create or replace function public.absence_document_create(p_ids bigint[], p_action text) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare owner uuid; r text; doc bigint; d jsonb;
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
                   cross join lateral (select e from jsonb_array_elements(coalesce(a.circuit,'[]'::jsonb)) e where (e->>'pos')::int=p.step and e->>'kind'='personnes' and (e->>'blocking')::boolean limit 1) st(e)
                   where p.absence_id=any(p_ids) and p.decision='approved'),'[]'));
 insert into public.absence_documents(user_id,absence_ids,action,data) values(owner,p_ids,p_action,d) returning id into doc;
 return doc;
end $$;

-- Décisions de toutes les étapes d'une demande (approbations, plus le visa de la direction du tour en cours)
create or replace function public.absence_step_label(a public.absences, p_step int) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when a.circuit is null then case when p_step = 10 then 'Validateurs de clinique' when p_step = 20 then 'Visa de la direction' end
              else (select e ->> 'label' from jsonb_array_elements(a.circuit) e where (e ->> 'pos')::int = p_step limit 1) end;
$$;

create or replace function public.absence_decision_rows(a public.absences)
returns table(step int, step_label text, name text, decision text, comment text, at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.step, public.absence_step_label(a, p.step), public.member_name(p.validator_id), p.decision, p.comment, p.decided_at
    from public.absence_approvals p where p.absence_id = a.id
  union all
  select v.pos, v.label, public.member_name(a.direction_by), 'approved'::text, null::text, a.direction_at
    from (select (e ->> 'pos')::int as pos, e ->> 'label' as label from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e where e ->> 'kind' = 'visa' limit 1) v
   where a.direction_by is not null and a.direction_at >= coalesce(a.change_requested_at, a.submitted_at, a.created_at)
     and not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.validator_id = a.direction_by and p.decision = 'approved');
$$;

create or replace function public.absence_in_personnes_step(p_uid uuid, a public.absences) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select (a.status in ('requested', 'rejected') or public.absence_is_open(a))
     and exists (select 1 from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e
                  where e ->> 'kind' = 'personnes' and p_uid = any (public.absence_step_people(a, e)));
$$;

drop function if exists public.absence_approvals_all(uuid);
create function public.absence_approvals_all(p_user uuid default null)
returns table(absence_id bigint, validator_name text, decision text, comment text, decided_at timestamptz, step int, step_label text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); perm boolean := true;
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid then
    perm := public.can_validate_absence(uid, p_user) or public.is_direction_admin();
    -- une personne d'une étape « personnes » ne voit que les demandes où elle figure dans l'instantané
    if not perm and not exists (select 1 from public.absences x where x.user_id = p_user and public.absence_in_personnes_step(uid, x)) then
      raise exception 'Accès refusé.' using errcode = '42501';
    end if;
  end if;
  return query
    select a.id, r.name, r.decision, case when not a.confidential or a.user_id = uid or public.is_direction_admin() then r.comment end, r.at, r.step, r.step_label
    from public.absences a cross join lateral public.absence_decision_rows(a) r
    where a.user_id = coalesce(p_user, uid) and (perm or public.absence_in_personnes_step(uid, a))
      and (a.status in ('requested', 'rejected') or (a.status = 'approved' and a.change_type is not null))
    order by a.id, r.step, r.name;
end;
$$;

drop function if exists public.absence_rejected_to_manage();
create function public.absence_rejected_to_manage()
returns table(id bigint, user_id uuid, name text, kind text, start_date date, end_date date, decision_comment text, decided_at timestamptz, decided_by_name text, approvals jsonb)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), a.kind, a.start_date, a.end_date, case when not a.confidential or a.user_id = auth.uid() or public.is_direction_admin() then a.decision_comment end, a.decided_at,
           case when a.decided_by is null then null else public.member_name(a.decided_by) end,
           coalesce((select jsonb_agg(jsonb_build_object('name', r.name, 'decision', r.decision, 'comment', case when not a.confidential or a.user_id = auth.uid() or public.is_direction_admin() then r.comment end, 'at', r.at, 'step', r.step, 'step_label', r.step_label)
                     order by r.step, r.name) from public.absence_decision_rows(a) r where r.decision in ('approved', 'rejected')), '[]'::jsonb)
    from public.absences a
    where a.status = 'rejected' and a.decided_at >= now() - interval '14 days'
      and (public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a)) or public.absence_in_personnes_step(auth.uid(), a))
    order by a.decided_at desc;
end;
$$;

create or replace function public.absence_delete_rejected(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); a public.absences;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id for update;
  if not found or a.status <> 'rejected' then raise exception 'Demande refusée introuvable.'; end if;
  if a.user_id <> uid and not public.can_validate_absence(uid, a.user_id, public.absence_lo(a), public.absence_hi(a)) and not public.absence_in_personnes_step(uid, a) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  delete from public.absences where id = p_id;
end;
$$;

-- Historique : l'instantané du circuit (identifiants de personnes) n'est pas montré
create or replace function public.absence_history(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare owner uuid;
begin
 perform public.absence_guard();
 select user_id into owner from public.absence_audit where absence_id=p_id order by id limit 1;
 if owner is null then return '[]'; end if;
 -- L'historique détaillé reste réservé à la personne et à l'administration ; aucun contournement de confidentialité.
 if owner<>auth.uid() and not public.is_direction_admin() then raise exception 'Accès refusé.' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('actor_name',public.member_name(actor),'before_data',a.before_data - 'circuit','after_data',a.after_data - 'circuit') order by id) from public.absence_audit a where absence_id=p_id),'[]');
end $$;

-- 8. Saisies directes de la direction ---------------------------------------------------------------------------------------

create or replace function public.absence_direction_add(p_user uuid, p_kind text, p_note text, p_start date, p_end date, p_confidential boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); new_id bigint; conf boolean := coalesce(p_confidential, false) and p_kind = 'autre';
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  if p_user is null or not exists (select 1 from public.profiles where id = p_user and role <> 'member') or not public.tool_allowed(p_user, 'absences') then
    raise exception 'Membre introuvable ou sans accès à Absences.';
  end if;
  if public.current_role_name() = 'direction' and not public.absence_is_chuv(p_user) then raise exception 'Seuls les membres de l''institution CHUV se gèrent ici.' using errcode = '42501'; end if;
  perform public.absence_check(p_user, null, p_kind, n, p_start, p_end);
  -- Saisie directe de la direction : aucune validation, aucun formulaire PDF (visualisation et planification)
  insert into public.absences (user_id, kind, note, start_date, end_date, status, submitted_at, decision, decided_by, decided_at, direction_by, direction_at, stage, circuit, confidential, form_queued_at)
    values (p_user, p_kind, n, p_start, p_end, 'approved', now(), 'approved', uid, now(), uid, now(), 10, public.absence_circuit_build(p_kind, p_start, p_end, null), conf, now()) returning id into new_id;
  if p_user <> uid then
    perform public.absence_enqueue('direction_change', p_user, array[new_id], jsonb_build_object('action', 'added', 'by', public.member_name(uid)));
  end if;
  return jsonb_build_object('id', new_id, 'conflicts', public.absence_conflicts_json(p_user, p_start, p_end),
                            'balance', public.absence_balance_check(p_user, p_kind, p_start, p_end, new_id));
end;
$$;

create or replace function public.absence_direction_cancel(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); a public.absences;
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  select * into a from public.absences where id = p_id for update;
  if not found or a.status not in ('approved', 'requested') then raise exception 'Absence introuvable ou déjà décidée.'; end if;
  if public.current_role_name() = 'direction' and not public.absence_is_chuv(a.user_id) then raise exception 'Seuls les membres de l''institution CHUV se gèrent ici.' using errcode = '42501'; end if;
  update public.absences set status = 'cancelled', change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null,
    change_requested_at = null, stage = 10, decision='change_approved',decided_by=uid,decided_at=clock_timestamp(),direction_by=uid,direction_at=now() where id = p_id;
  update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
  if a.user_id <> uid then
    perform public.absence_enqueue('direction_change', a.user_id, array[p_id], jsonb_build_object('action', 'cancelled', 'by', public.member_name(uid)));
  end if;
  perform public.absence_queue_correction(p_id,'cancelled_direct');
end;
$$;

create or replace function public.absence_direction_update(p_id bigint, p_kind text, p_note text, p_start date, p_end date, p_confidential boolean default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); a public.absences; conf boolean;
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if a.status <> 'approved' then raise exception 'Seule une absence validée se modifie ici (une demande en cours se décide dans « À valider »).'; end if;
  if public.current_role_name() = 'direction' and not public.absence_is_chuv(a.user_id) then raise exception 'Seuls les membres de l''institution CHUV se gèrent ici.' using errcode = '42501'; end if;
  perform public.absence_check(a.user_id, p_id, p_kind, n, p_start, p_end);
  conf := case when p_kind <> 'autre' then false else coalesce(p_confidential, a.confidential) end;
  update public.absences set kind = p_kind, note = n, start_date = p_start, end_date = p_end, confidential = conf,
    change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null, change_requested_at = null,
    stage = 10, circuit = public.absence_circuit_build(p_kind, p_start, p_end, null), direction_by = uid, direction_at = now(), notified_at = null, decision='change_approved',decided_by=uid,decided_at=clock_timestamp() where id = p_id;
  update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
  if a.user_id <> uid then
    perform public.absence_enqueue('direction_change', a.user_id, array[p_id], jsonb_build_object('action', 'edited', 'by', public.member_name(uid)));
  end if;
  perform public.absence_queue_correction(p_id,'modified_direct');
  return jsonb_build_object('id', p_id, 'conflicts', public.absence_conflicts_json(a.user_id, p_start, p_end),
                            'balance', public.absence_balance_check(a.user_id, p_kind, p_start, p_end, p_id));
end;
$$;

-- 9. Administration du circuit -----------------------------------------------------------------------------------------------

create or replace function public.absence_circuit_steps_named() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'pos', s.pos, 'kind', s.kind, 'label', s.label, 'rule', s.rule, 'blocking', s.blocking, 'active', s.active,
    'persons', (select coalesce(jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x), 'has_tool', public.tool_allowed(x, 'absences'))
                                          order by lower(coalesce(public.member_name(x), ''))), '[]'::jsonb) from unnest(s.persons) x),
    'kinds', to_jsonb(s.kinds), 'min_days', s.min_days, 'pdf_slot', s.pdf_slot) order by s.pos), '[]'::jsonb)
  from public.absence_circuit_steps s;
$$;

create or replace function public.absence_circuit_get() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'steps', public.absence_circuit_steps_named(),
    'log', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'at', l.changed_at, 'by', l.changed_by, 'by_name', public.member_name(l.changed_by),
        'summary', 'Étapes actives : ' || coalesce((select string_agg(e ->> 'label', ', ' order by (e ->> 'pos')::int)
                                                    from jsonb_array_elements(coalesce(l.after, '[]'::jsonb)) e where (e ->> 'active')::boolean), 'aucune'))
        order by l.changed_at desc, l.id desc)
      from (select * from public.absence_circuit_log order by changed_at desc, id desc limit 20) l), '[]'::jsonb));
end;
$$;

create or replace function public.absence_circuit_save(p_steps jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare norm jsonb; before jsonb;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  norm := public.absence_circuit_normalize(p_steps);
  before := public.absence_circuit_steps_json();
  delete from public.absence_circuit_steps where true;
  insert into public.absence_circuit_steps (pos, kind, label, rule, blocking, active, persons, kinds, min_days, pdf_slot)
    select s.pos, s.kind, s.label, s.rule, s.blocking, s.active,
           array(select x::uuid from jsonb_array_elements_text(coalesce(s.persons, '[]'::jsonb)) x),
           case when s.kinds is null or jsonb_typeof(s.kinds) <> 'array' then null else array(select x from jsonb_array_elements_text(s.kinds) x) end,
           s.min_days, s.pdf_slot
      from jsonb_to_recordset(norm) as s(pos int, kind text, label text, rule text, blocking boolean, active boolean, persons jsonb, kinds jsonb, min_days int, pdf_slot text);
  insert into public.absence_circuit_log (changed_by, before, after) values (auth.uid(), before, public.absence_circuit_steps_json());
  return public.absence_circuit_get() || case when exists (select 1 from public.absence_circuit_steps where kind = 'visa' and active) then '{}'::jsonb
    else jsonb_build_object('warning', 'Aucun visa de la direction actif : les demandes sans validateur iront aux administrateurs.') end;
end;
$$;

do $$
begin
  if to_regprocedure('public.absence_circuit_simulate(uuid,date,date)') is not null then
    execute 'drop function public.absence_circuit_simulate(uuid, date, date)';
  end if;
end $$;

create or replace function public.absence_circuit_simulate(p_user uuid, p_from date, p_to date, p_kind text default 'vacances', p_steps jsonb default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r text; cl text[]; selfx boolean; norm jsonb; circ jsonb; pre jsonb; pre_active boolean; fs jsonb; stop_people uuid[]; op uuid[];
  e jsonb; ppl uuid[]; k text; nxt text; note text; steps jsonb := '[]'::jsonb; excl jsonb := '[]'::jsonb; rule_txt text; vis_admin boolean;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Les dates sont invalides : la fin précède le début.'; end if;
  select role into r from public.profiles where id = p_user;
  if not found then raise exception 'Membre introuvable.'; end if;
  if p_kind is null or p_kind not in ('vacances', 'congres', 'autre') then raise exception 'Motif inconnu.'; end if;
  norm := case when p_steps is null then public.absence_circuit_steps_json() else public.absence_circuit_normalize(p_steps) end;
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

  steps := jsonb_build_array(jsonb_build_object('key', 'preavis', 'pos', 0, 'kind', 'preavis', 'label', coalesce(pre ->> 'label', 'Pré-avis de la direction'),
      'rule', 'facultatif', 'rule_code', null, 'blocking', false, 'parallel_with', coalesce(fs -> 'step' ->> 'kind', 'clinique'),
      'people', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by lower(public.member_name(x))) from unnest(op) x), '[]'::jsonb),
      'note', case when not pre_active then 'Pré-avis désactivé'
                   when coalesce(array_length(op, 1), 0) > 0 then null
                   when coalesce(fs -> 'step' ->> 'kind', '') <> 'clinique' then 'Aucun pré-avis : la direction reçoit déjà la demande au visa'
                   else 'Aucun pré-avis demandé' end));

  for e in select value from jsonb_array_elements(circ) order by (value ->> 'pos')::int loop
    k := e ->> 'kind';
    ppl := public.absence_step_people_for(p_user, p_from, p_to, e);
    nxt := (select x ->> 'kind' from jsonb_array_elements(circ) x where (x ->> 'pos')::int > (e ->> 'pos')::int and (x ->> 'blocking')::boolean order by (x ->> 'pos')::int limit 1);
    vis_admin := k = 'visa' and exists (select 1 from public.profiles p where p.id = any (ppl) and p.role = 'admin');
    rule_txt := case
      when not (e ->> 'blocking')::boolean then 'avis demandé ; la demande n''attend pas cette étape'
      when k = 'visa' then 'un seul visa suffit ; signe le formulaire PDF'
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
    steps := steps || jsonb_build_array(jsonb_build_object('key', k, 'pos', (e ->> 'pos')::int, 'kind', k, 'label', e ->> 'label', 'rule', rule_txt, 'rule_code', e ->> 'rule',
      'blocking', (e ->> 'blocking')::boolean, 'parallel_with', null, 'pdf_slot', e -> 'pdf_slot',
      'people', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by lower(public.member_name(x))) from unnest(ppl) x), '[]'::jsonb),
      'note', note));
  end loop;

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
    'steps', steps,
    'excluded', excl,
    'admin_override', 'Un administrateur peut valider à toute étape ; sa validation conclut la demande.',
    'self_excluded', selfx);
end;
$$;

create or replace function public.absence_circuit_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare res jsonb; warns jsonb := '[]'::jsonb; c record; v record; st record; dir_active int; n_active int;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  select count(*) into dir_active from public.profiles p where p.role = 'direction' and public.tool_allowed(p.id, 'absences');
  if dir_active = 0 then
    warns := warns || to_jsonb('Visa et pré-avis : aucun membre direction, le visa revient aux administrateurs et aucun pré-avis n''est demandé'::text);
  end if;
  if dir_active = 0 and not exists (select 1 from public.profiles p where p.role = 'admin') then
    warns := warns || to_jsonb('Visa : aucun membre direction ni administrateur, personne ne peut viser les demandes'::text);
  end if;
  for st in select s.label, s.persons from public.absence_circuit_steps s where s.kind = 'personnes' and s.active order by s.pos loop
    if not exists (select 1 from unnest(st.persons) x where public.tool_allowed(x, 'absences')) then
      warns := warns || to_jsonb('Étape « ' || st.label || ' » : aucune personne désignée n''a accès à Absences, l''étape sera sautée');
    end if;
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
    'warnings', warns);
  return res;
end;
$$;

-- 10. Droits -----------------------------------------------------------------------------------------------------------------

revoke execute on function
  public.absence_circuit_steps_json(), public.absence_circuit_normalize(jsonb), public.absence_circuit_build(text, date, date, jsonb),
  public.absence_circuit_for(public.absences), public.absence_step_of(public.absences), public.absence_is_open(public.absences),
  public.absence_step_people_for(uuid, date, date, jsonb), public.absence_step_people(public.absences, jsonb), public.absence_step_kind(public.absences, int),
  public.absence_nonblocking_people(public.absences), public.absence_first_stop(uuid, date, date, jsonb), public.absence_preavis_active(),
  public.absence_preavis_open(public.absences), public.absence_stage_compat(public.absences), public.absence_circuit_public(public.absences),
  public.absence_opinion_step(uuid, public.absences), public.absence_advance(bigint, uuid, text, boolean, boolean, int), public.absence_circuit_fallback(),
  public.absence_open_round_core(bigint, boolean), public.absence_circuit_steps_named(), public.absence_peer_people(public.absences), public.absence_step_label(public.absences, int),
  public.absence_decision_rows(public.absences), public.absence_in_personnes_step(uuid, public.absences)
  from public, anon, authenticated;

revoke execute on function
  public.absence_finalize_reject(bigint, uuid, text), public.absence_open_round(bigint), public.absence_try_complete(bigint, uuid, text), public.absence_actionable(uuid, public.absences),
  public.absence_enqueue(text, uuid, bigint[], jsonb), public.absence_document_create(bigint[], text), public.absence_reroute(uuid)
  from public, anon, authenticated;

revoke execute on function
  public.absence_notification_ids(uuid, bigint[], text), public.absence_resend_pairs(uuid, bigint[])
  from public, anon, authenticated;
grant execute on function public.absence_notification_ids(uuid, bigint[], text), public.absence_resend_pairs(uuid, bigint[]) to service_role;

revoke execute on function
  public.absence_decide(bigint, boolean, text), public.absence_my_validators(), public.absence_submit(),
  public.absence_request_change(bigint, text, text, text, date, date), public.absence_opinion_set(bigint, text, text), public.absence_opinion_todo(),
  public.absence_to_validate(), public.absence_approvals_all(uuid), public.absence_rejected_to_manage(), public.absence_list(uuid), public.absence_export(date, date), public.absence_planning(date, date),
  public.absence_direction_add(uuid, text, text, date, date, boolean), public.absence_direction_cancel(bigint),
  public.absence_direction_update(bigint, text, text, date, date, boolean),
  public.absence_circuit_get(), public.absence_circuit_save(jsonb), public.absence_circuit_simulate(uuid, date, date, text, jsonb), public.absence_circuit_overview()
  from public, anon;
grant execute on function
  public.absence_decide(bigint, boolean, text), public.absence_my_validators(), public.absence_submit(),
  public.absence_request_change(bigint, text, text, text, date, date), public.absence_opinion_set(bigint, text, text), public.absence_opinion_todo(),
  public.absence_to_validate(), public.absence_approvals_all(uuid), public.absence_rejected_to_manage(), public.absence_list(uuid), public.absence_export(date, date), public.absence_planning(date, date),
  public.absence_direction_add(uuid, text, text, date, date, boolean), public.absence_direction_cancel(bigint),
  public.absence_direction_update(bigint, text, text, date, date, boolean),
  public.absence_circuit_get(), public.absence_circuit_save(jsonb), public.absence_circuit_simulate(uuid, date, date, text, jsonb), public.absence_circuit_overview()
  to authenticated;

do $$
begin
  if to_regclass('public.onconic_migrations') is not null then
    insert into public.onconic_migrations(version) values ('202611170001'), ('202611180001') on conflict do nothing;
  end if;
end $$;

commit;
