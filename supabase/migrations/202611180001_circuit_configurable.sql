-- Circuit de validation des absences décrit en données (phase 2A : moteur SQL).
-- Transactionnel et réexécutable. Le comportement par défaut (pré-avis, validateurs de clinique, visa de la direction) reste identique.
--
-- Circuits alternatifs (phase 2C) : absence_circuits (le circuit général is_default et des circuits nommés), absence_circuit_steps.circuit_id,
--  absence_circuit_assignments (membre, rôle ou clinique, une cible = un circuit). Priorité : membre, rôle, clinique (circuit le mieux placé), général.
--  absences.circuit_id / circuit_name / preavis_active figent le circuit appliqué à l'ouverture de la ronde.
--
-- Modèle
--  * absence_circuit_steps : étapes configurées (pos 0 = pré-avis, traité à part ; autres étapes bloquantes ou non).
--    Types : preavis, clinique, visa (uniques par circuit), direction, personnes, groupe (répétables).
--    Phase 2D : les étapes de même `col` sont simultanées (col 0 = pré-avis, puis 10, 20, 30...). Une étape sans col reçoit col = pos.
--  * absences.circuit : instantané figé à l'ouverture de la ronde (étapes applicables, sans le pré-avis).
--  * absences.stage : col de la colonne en cours (10 = clinique, 20 = visa par défaut) ; absences.stage_at : arrivée dans cette colonne.
--    Les résultats de absence_list, absence_to_validate, absence_export et absence_planning gardent un `stage` de compatibilité
--    (1 = la colonne contient des validateurs de clinique, 2 = sinon), et ajoutent step_kind / step_label (libellés joints par « + »).
--  * absence_approvals.step : étape de l'approbation (clé primaire absence_id, step, validator_id).
--  * absence_opinions.step : étape non bloquante qui a demandé l'avis (null = pré-avis de la direction).
begin;

-- 1. Tables ---------------------------------------------------------------------------------------------------------------

-- Circuits : le circuit général (is_default) et des circuits alternatifs nommés, attribués à des membres, des rôles ou des cliniques
create table if not exists public.absence_circuits (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 60),
  pos int not null default 0,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists absence_circuits_name_once on public.absence_circuits (lower(name));
create unique index if not exists absence_circuits_one_default on public.absence_circuits (is_default) where is_default;
alter table public.absence_circuits enable row level security;
revoke all on public.absence_circuits from public, anon, authenticated;
insert into public.absence_circuits (name, pos, is_default)
  select 'Circuit général', 0, true where not exists (select 1 from public.absence_circuits where is_default);

create table if not exists public.absence_circuit_steps (
  id bigint generated always as identity primary key,
  circuit_id bigint references public.absence_circuits (id) on delete cascade,
  pos int not null check (pos between 0 and 9999),
  col int,
  kind text not null check (kind in ('preavis', 'clinique', 'visa', 'direction', 'personnes', 'groupe')),
  label text not null check (char_length(label) between 1 and 80),
  rule text not null default 'all' check (rule in ('all', 'any')),
  blocking boolean not null default true,
  active boolean not null default true,
  persons uuid[] not null default '{}',
  roles text[] check (roles <@ array['clinician', 'cdc', 'cadre', 'assistant', 'nurse', 'pharmacist', 'direction', 'admin']::text[]),
  scope text check (scope in ('clinic', 'all')),
  kinds text[] check (kinds <@ array['vacances', 'congres', 'autre']::text[] and cardinality(kinds) > 0),
  min_days int check (min_days between 1 and 365),
  pdf_slot text check (pdf_slot in ('chef_service')),
  check ((kind = 'preavis') = (pos = 0)),
  check (kind <> 'preavis' or blocking = false),
  check (kind <> 'visa' or rule = 'any')
);
-- Version déjà appliquée sans circuit_id : rattachement des étapes existantes au circuit général
alter table public.absence_circuit_steps add column if not exists circuit_id bigint references public.absence_circuits (id) on delete cascade;
update public.absence_circuit_steps set circuit_id = (select id from public.absence_circuits where is_default) where circuit_id is null;
alter table public.absence_circuit_steps alter column circuit_id set not null;
-- Positions des étapes : 0 (pré-avis) ou au moins 10, pour que le remappage des anciennes valeurs 1 et 2 ne touche jamais une étape configurée
do $$
declare n text;
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.absence_circuit_steps'::regclass and conname = 'absence_circuit_steps_pos_min') then
    alter table public.absence_circuit_steps add constraint absence_circuit_steps_pos_min check (pos = 0 or pos >= 10);
  end if;
  -- l'unicité de pos devient une unicité par circuit
  for n in select c.conname from pg_constraint c
            where c.conrelid = 'public.absence_circuit_steps'::regclass and c.contype = 'u'
              and c.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = 'public.absence_circuit_steps'::regclass and a.attname = 'pos')]::smallint[] loop
    execute format('alter table public.absence_circuit_steps drop constraint %I', n);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'public.absence_circuit_steps'::regclass and conname = 'absence_circuit_steps_circuit_pos_key') then
    alter table public.absence_circuit_steps add constraint absence_circuit_steps_circuit_pos_key unique (circuit_id, pos);
  end if;
  -- un seul pré-avis, une seule clinique, un seul visa par circuit
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'absence_circuit_steps_kind_once' and indexdef not like '%circuit_id%') then
    drop index public.absence_circuit_steps_kind_once;
  end if;
end $$;
-- unicité par circuit pour le pré-avis, la clinique et le visa seulement : direction, groupe et personnes se répètent
create unique index if not exists absence_circuit_steps_kind_once on public.absence_circuit_steps (circuit_id, kind) where kind in ('preavis', 'clinique', 'visa');
-- Phase 2D : colonnes simultanées, étapes « direction » et « groupe »
alter table public.absence_circuit_steps add column if not exists col int;
alter table public.absence_circuit_steps add column if not exists roles text[];
alter table public.absence_circuit_steps add column if not exists scope text;
update public.absence_circuit_steps set col = case when kind = 'preavis' then 0 else pos end where col is null;
alter table public.absence_circuit_steps alter column col set not null;
do $$
declare n text;
begin
  -- contrainte de type : remplacée si elle ne connaît pas encore « direction » et « groupe »
  for n in select c.conname from pg_constraint c
            where c.conrelid = 'public.absence_circuit_steps'::regclass and c.contype = 'c'
              and pg_get_constraintdef(c.oid) like '%ARRAY%' and pg_get_constraintdef(c.oid) like '%''personnes''%'
              and pg_get_constraintdef(c.oid) not like '%''groupe''%' loop
    execute format('alter table public.absence_circuit_steps drop constraint %I', n);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'public.absence_circuit_steps'::regclass and conname = 'absence_circuit_steps_kind_check') then
    alter table public.absence_circuit_steps add constraint absence_circuit_steps_kind_check
      check (kind in ('preavis', 'clinique', 'visa', 'direction', 'personnes', 'groupe'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.absence_circuit_steps'::regclass and conname = 'absence_circuit_steps_roles_check') then
    alter table public.absence_circuit_steps add constraint absence_circuit_steps_roles_check
      check (roles <@ array['clinician', 'cdc', 'cadre', 'assistant', 'nurse', 'pharmacist', 'direction', 'admin']::text[]);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.absence_circuit_steps'::regclass and conname = 'absence_circuit_steps_scope_check') then
    alter table public.absence_circuit_steps add constraint absence_circuit_steps_scope_check check (scope in ('clinic', 'all'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.absence_circuit_steps'::regclass and conname = 'absence_circuit_steps_col_min') then
    alter table public.absence_circuit_steps add constraint absence_circuit_steps_col_min check (col = 0 or col >= 10);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.absence_circuit_steps'::regclass and conname = 'absence_circuit_steps_preavis_col') then
    alter table public.absence_circuit_steps add constraint absence_circuit_steps_preavis_col check ((kind = 'preavis') = (col = 0));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.absence_circuit_steps'::regclass and conname = 'absence_circuit_steps_groupe_scope') then
    alter table public.absence_circuit_steps add constraint absence_circuit_steps_groupe_scope check (kind <> 'groupe' or scope is not null);
  end if;
end $$;
alter table public.absence_circuit_steps enable row level security;
revoke all on public.absence_circuit_steps from public, anon, authenticated;

-- Attributions : une cible (membre, rôle ou clinique) n'appartient qu'à un circuit alternatif ; le circuit général est le repli
create table if not exists public.absence_circuit_assignments (
  circuit_id bigint not null references public.absence_circuits (id) on delete cascade,
  target_type text not null check (target_type in ('member', 'role', 'clinic')),
  target text not null check (char_length(target) between 1 and 80),
  primary key (target_type, target)
);
create index if not exists absence_circuit_assignments_circuit on public.absence_circuit_assignments (circuit_id);
alter table public.absence_circuit_assignments enable row level security;
revoke all on public.absence_circuit_assignments from public, anon, authenticated;

create table if not exists public.absence_circuit_log (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  before jsonb,
  after jsonb
);
-- circuit_id sans clé étrangère : le journal d'un circuit supprimé reste lisible ; action : save_steps, create, rename, delete, reorder, assign
alter table public.absence_circuit_log add column if not exists circuit_id bigint;
alter table public.absence_circuit_log add column if not exists action text;
update public.absence_circuit_log set circuit_id = (select id from public.absence_circuits where is_default), action = 'save_steps' where action is null;
alter table public.absence_circuit_log enable row level security;
revoke all on public.absence_circuit_log from public, anon, authenticated;

insert into public.absence_circuit_steps (circuit_id, pos, col, kind, label, rule, blocking, active, persons, pdf_slot)
select (select id from public.absence_circuits where is_default), v.pos, v.pos, v.kind, v.label, v.rule, v.blocking, v.active, '{}'::uuid[], v.pdf_slot
from (values
  (0,  'preavis',   'Pré-avis de la direction',                 'all', false, true,  null::text),
  (10, 'clinique',  'Validateurs de clinique',                  'all', true,  true,  null),
  (20, 'visa',      'Visa de la direction',                     'any', true,  true,  null),
  (30, 'personnes', 'Validation de la cheffe de service',       'any', true,  false, 'chef_service')
) as v(pos, kind, label, rule, blocking, active, pdf_slot)
where not exists (select 1 from public.absence_circuit_steps);

-- 2. Colonnes existantes et reprise des demandes en cours -------------------------------------------------------------------

alter table public.absences add column if not exists circuit jsonb;
-- Identité du circuit appliqué, figée avec l'instantané ; preavis_active fixé à l'ouverture de la ronde (null : demande antérieure, pré-avis du circuit général)
alter table public.absences add column if not exists circuit_id bigint references public.absence_circuits (id) on delete set null;
alter table public.absences add column if not exists circuit_name text;
alter table public.absences add column if not exists preavis_active boolean;

do $$
begin
  -- l'ancienne contrainte (stage 1 ou 2) n'existe plus après la première exécution
  if exists (select 1 from pg_constraint where conrelid = 'public.absences'::regclass and conname = 'absences_stage_check') then
    alter table public.absences drop constraint absences_stage_check;
  end if;
end $$;
-- stage_at : arrivée dans la colonne en cours (le visa compte s'il est posé après)
alter table public.absences add column if not exists stage_at timestamptz;
alter table public.absences alter column stage type int;
alter table public.absences alter column stage set default 10;
-- reprise des demandes en cours (réexécutable : l'instantané n'est posé que s'il manque, le remappage ne touche que les anciennes valeurs 1 et 2)
update public.absences set circuit = '[{"pos":10,"col":10,"kind":"clinique","label":"Validateurs de clinique","rule":"all","blocking":true,"persons":[],"pdf_slot":null},{"pos":20,"col":20,"kind":"visa","label":"Visa de la direction","rule":"any","blocking":true,"persons":[],"pdf_slot":null}]'::jsonb
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

-- Anciennes signatures (version déjà appliquée sans circuits alternatifs) : remplacées plus bas
do $$
declare f text;
begin
  foreach f in array array['absence_circuit_steps_json()', 'absence_circuit_build(text,date,date,jsonb)', 'absence_circuit_get()', 'absence_circuit_save(jsonb)',
                           'absence_circuit_simulate(uuid,date,date,text,jsonb)', 'absence_circuit_steps_named()', 'absence_preavis_active()',
                           'absence_step_of(public.absences)'] loop
    if to_regprocedure('public.' || f) is not null then execute 'drop function public.' || f; end if;
  end loop;
end $$;

create or replace function public.absence_circuit_default_id() returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.absence_circuits where is_default;
$$;

-- Étapes d'un circuit (null : le circuit général)
create or replace function public.absence_circuit_steps_json(p_circuit bigint default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('pos', s.pos, 'col', s.col, 'kind', s.kind, 'label', s.label, 'rule', s.rule, 'blocking', s.blocking, 'active', s.active,
    'persons', to_jsonb(s.persons), 'roles', to_jsonb(s.roles), 'scope', s.scope, 'kinds', to_jsonb(s.kinds), 'min_days', s.min_days, 'pdf_slot', s.pdf_slot) order by s.col, s.pos), '[]'::jsonb)
  from public.absence_circuit_steps s where s.circuit_id = coalesce(p_circuit, public.absence_circuit_default_id());
$$;

-- Circuit applicable à un membre aux dates données : membre nommé, puis rôle, puis clinique (le circuit le mieux placé dans l'ordre l'emporte), sinon le circuit général
create or replace function public.absence_circuit_resolve(p_user uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare def public.absence_circuits; c public.absence_circuits; r text; cl text[]; hit record; n int; d1 date := coalesce(p_from, public.ch_today()); d2 date := coalesce(p_to, p_from, public.ch_today());
begin
  select * into def from public.absence_circuits where is_default;
  if p_user is not null then
    select ac.* into c from public.absence_circuit_assignments a join public.absence_circuits ac on ac.id = a.circuit_id
     where a.target_type = 'member' and a.target = p_user::text;
    if found then
      return jsonb_build_object('circuit_id', c.id, 'name', c.name, 'reason', 'member', 'detail', public.member_name(p_user), 'conflict', false);
    end if;
    select role into r from public.profiles where id = p_user;
    if r is not null then
      select ac.* into c from public.absence_circuit_assignments a join public.absence_circuits ac on ac.id = a.circuit_id
       where a.target_type = 'role' and a.target = r;
      if found then
        return jsonb_build_object('circuit_id', c.id, 'name', c.name, 'reason', 'role', 'detail', r, 'conflict', false);
      end if;
    end if;
    cl := public.member_clinics(p_user, d1, d2);
    select count(distinct a.circuit_id) into n from public.absence_circuit_assignments a where a.target_type = 'clinic' and a.target = any (cl);
    if n > 0 then
      select ac.id, ac.name, a.target into hit from public.absence_circuit_assignments a join public.absence_circuits ac on ac.id = a.circuit_id
       where a.target_type = 'clinic' and a.target = any (cl) order by ac.pos, ac.id, a.target limit 1;
      return jsonb_build_object('circuit_id', hit.id, 'name', hit.name, 'reason', 'clinic', 'detail', hit.target, 'conflict', n > 1);
    end if;
  end if;
  return jsonb_build_object('circuit_id', def.id, 'name', def.name, 'reason', 'default', 'detail', null, 'conflict', false);
end;
$$;

-- Contrôle et normalisation d'un circuit proposé (enregistrement et simulation)
-- Colonnes : les colonnes distinctes deviennent 10, 20, 30... ; positions : 10, 20, 30... dans l'ordre (col, pos d'origine) ; le pré-avis garde col 0 et pos 0.
create or replace function public.absence_circuit_normalize(p_steps jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  e jsonb; res jsonb := '[]'::jsonb; k text; lbl text; rl text; bl boolean; ac boolean; pers uuid[]; ks jsonb; md int; slot text; ps int; cl int; rls text[]; sc text;
  seen int[] := '{}'; n_pre int := 0; n_cl int := 0; n_vi int := 0; uncond boolean := false; x text;
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
    if k = 'personnes' and ac and coalesce(array_length(pers, 1), 0) = 0 then
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
    if k <> 'preavis' and ac and bl and ks is null and md is null then uncond := true; end if;
    res := res || jsonb_build_array(jsonb_build_object('pos', ps, 'col', cl, 'kind', k, 'label', lbl, 'rule', rl, 'blocking', bl, 'active', ac,
      'persons', to_jsonb(pers), 'roles', to_jsonb(rls), 'scope', sc, 'kinds', ks, 'min_days', md, 'pdf_slot', slot));
  end loop;
  if n_pre > 1 then raise exception 'Un seul pré-avis est permis (position 0).'; end if;
  if n_cl > 1 then raise exception 'Une seule étape « Validateurs de clinique » est permise.'; end if;
  if n_vi > 1 then raise exception 'Une seule étape « Visa de la direction » est permise.'; end if;
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

-- Instantané : étapes actives et applicables (motif, durée en jours ouvrables), sans le pré-avis
create or replace function public.absence_circuit_build(p_kind text, p_from date, p_to date, p_steps jsonb default null, p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare days int; res jsonb;
begin
  days := public.absence_workdays(p_from, p_to);
  select coalesce(jsonb_agg(jsonb_build_object('pos', s.pos, 'col', coalesce(s.col, s.pos), 'kind', s.kind, 'label', s.label, 'rule', s.rule, 'blocking', s.blocking,
           'persons', coalesce(s.persons, '[]'::jsonb), 'roles', s.roles, 'scope', s.scope, 'pdf_slot', s.pdf_slot) order by coalesce(s.col, s.pos), s.pos), '[]'::jsonb)
    into res
    from jsonb_to_recordset(coalesce(p_steps, public.absence_circuit_steps_json(case when p_user is null then null else (public.absence_circuit_resolve(p_user, p_from, p_to) ->> 'circuit_id')::bigint end)))
         as s(pos int, col int, kind text, label text, rule text, blocking boolean, active boolean, persons jsonb, roles jsonb, scope text, kinds jsonb, min_days int, pdf_slot text)
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

create or replace function public.absence_circuit_for(a public.absences) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select public.absence_circuit_build(
    case when a.change_type = 'modify' then a.change_kind else a.kind end,
    case when a.change_type = 'modify' then a.change_start else a.start_date end,
    case when a.change_type = 'modify' then a.change_end else a.end_date end, null, a.user_id);
$$;

-- Colonne d'une étape de l'instantané (instantané ancien sans col : la position)
create or replace function public.absence_step_col(e jsonb) returns int
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(nullif(e ->> 'col', '')::int, (e ->> 'pos')::int);
$$;

-- Étapes de la colonne en cours (bloquantes ou non), dans l'ordre des positions
create or replace function public.absence_steps_of(a public.absences) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(e order by (e ->> 'pos')::int), '[]'::jsonb)
    from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e where public.absence_step_col(e) = a.stage;
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
    when 'direction' then public.absence_direction_recipients(p_user)
    when 'personnes' then coalesce(array(
      select q.x from (select distinct v::uuid as x from jsonb_array_elements_text(coalesce(s -> 'persons', '[]'::jsonb)) v) q
       where q.x <> p_user and public.tool_allowed(q.x, 'absences') order by q.x), '{}'::uuid[])
    -- groupe : membres des rôles listés, hors demandeur, avec l'outil Absences ; portée « clinic » : au moins une clinique commune aux dates de l'absence ; 200 personnes au plus (troncature par identifiant)
    when 'groupe' then coalesce(array(
      select q.id from (
        select p.id from public.profiles p
         where p.role = any (array(select jsonb_array_elements_text(coalesce(s -> 'roles', '[]'::jsonb))))
           and p.id <> p_user and public.tool_allowed(p.id, 'absences')
           and (coalesce(s ->> 'scope', 'clinic') = 'all' or public.member_clinics(p.id, p_from, p_to) && public.member_clinics(p_user, p_from, p_to))
         order by p.id limit 200) q order by q.id), '{}'::uuid[])
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

-- Étapes bloquantes de la colonne en cours qui retiennent la demande : avec des personnes, ou le visa ; à défaut, toutes les étapes bloquantes
create or replace function public.absence_active_steps(a public.absences) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with b as (select e, (e ->> 'pos')::int as pos from jsonb_array_elements(public.absence_steps_of(a)) e where (e ->> 'blocking')::boolean),
       act as (select e, pos from b where e ->> 'kind' = 'visa' or cardinality(public.absence_step_people(a, e)) > 0)
  select coalesce(jsonb_agg(q.e order by q.pos), '[]'::jsonb)
    from (select e, pos from act union all select e, pos from b where not exists (select 1 from act)) q;
$$;

-- Personnes de toutes les étapes bloquantes de la colonne en cours (visa compris)
create or replace function public.absence_col_people(a public.absences) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array(select distinct x from jsonb_array_elements(public.absence_steps_of(a)) e, unnest(public.absence_step_people(a, e)) x
                        where (e ->> 'blocking')::boolean order by x), '{}'::uuid[]);
$$;

-- Type de la colonne en cours : « visa » si elle contient le visa, sinon le type de la première étape bloquante
create or replace function public.absence_col_kind(a public.absences) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when exists (select 1 from jsonb_array_elements(public.absence_active_steps(a)) e where e ->> 'kind' = 'visa') then 'visa'
              else (select e ->> 'kind' from jsonb_array_elements(public.absence_active_steps(a)) with ordinality t(e, ord) order by ord limit 1) end;
$$;

-- Libellés des étapes bloquantes de la colonne en cours, joints par « + »
create or replace function public.absence_col_label(a public.absences) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select string_agg(e ->> 'label', ' + ' order by ord) from jsonb_array_elements(public.absence_active_steps(a)) with ordinality t(e, ord);
$$;

-- Visa posé depuis l'arrivée dans la colonne en cours (demande antérieure sans stage_at : depuis le début du tour)
create or replace function public.absence_visa_done(a public.absences) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select a.direction_by is not null and a.direction_at >= coalesce(a.stage_at, a.change_requested_at, a.submitted_at, a.created_at);
$$;

-- L'étape attend-elle ce membre ? (membre de l'étape ; l'administrateur n'est pas traité ici)
create or replace function public.absence_step_member(p_uid uuid, a public.absences, s jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case s ->> 'kind'
    when 'visa' then coalesce((select role from public.profiles where id = p_uid) = 'direction', false) and p_uid <> a.user_id
    when 'clinique' then public.can_validate_absence(p_uid, a.user_id, public.absence_lo(a), public.absence_hi(a))
    else p_uid = any (public.absence_step_people(a, s)) end;
$$;

-- L'étape est-elle déjà soldée pour ce membre ? (approbation de sa part ; le visa se solde pour tous)
create or replace function public.absence_step_done(p_uid uuid, a public.absences, s jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case when s ->> 'kind' = 'visa' then public.absence_visa_done(a)
    else exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.step = (s ->> 'pos')::int and p.validator_id = p_uid and p.decision = 'approved') end;
$$;

-- Personnes des étapes non bloquantes de l'instantané (avis demandés)
create or replace function public.absence_nonblocking_people(a public.absences) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array(select distinct x from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e,
                        unnest(public.absence_step_people(a, e)) x
                        where not (e ->> 'blocking')::boolean), '{}'::uuid[]);
$$;

-- Personnes prévenues d'un refus : tous ceux qui ont une ligne d'approbation, plus la direction déjà sollicitée (visa ou étape « direction » d'une colonne antérieure)
create or replace function public.absence_peer_people(a public.absences) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array(
    select q.x from (
      select p.validator_id as x from public.absence_approvals p where p.absence_id = a.id
      union
      select unnest(public.absence_direction_recipients(a.user_id))
        where exists (select 1 from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e
                       where e ->> 'kind' in ('visa', 'direction') and (e ->> 'blocking')::boolean and public.absence_step_col(e) < a.stage)
    ) q where q.x <> a.user_id and public.tool_allowed(q.x, 'absences') order by q.x), '{}'::uuid[]);
$$;

-- Étape de repli : aucune étape bloquante n'a de personne, la demande va aux destinataires du visa (direction, sinon administrateurs)
create or replace function public.absence_circuit_fallback() returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select '{"pos":1000,"col":1000,"kind":"visa","label":"Visa de la direction (repli)","rule":"any","blocking":true,"persons":[],"pdf_slot":null}'::jsonb;
$$;

-- Première colonne qui retient la demande : au moins une étape bloquante avec des personnes, ou le visa (jamais sauté).
-- Renvoie col, steps (étapes bloquantes de la colonne), people (union, visa compris) et step (résumé : kind « visa » si seul le visa a des personnes, libellés joints par « + »)
create or replace function public.absence_first_stop(p_user uuid, p_from date, p_to date, p_circuit jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c int; e jsonb; ppl uuid[]; allp uuid[]; has_visa boolean; other boolean; labels text[]; cs jsonb; fk text; fr text; fpos int;
begin
  for c in select distinct public.absence_step_col(x) from jsonb_array_elements(coalesce(p_circuit, '[]'::jsonb)) x order by 1 loop
    has_visa := false; other := false; allp := '{}'::uuid[]; labels := '{}'; cs := '[]'::jsonb; fk := null; fr := null; fpos := null;
    for e in select value from jsonb_array_elements(p_circuit) where public.absence_step_col(value) = c order by (value ->> 'pos')::int loop
      continue when not (e ->> 'blocking')::boolean;
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

-- Pré-avis actif dans le circuit applicable à ce membre à ces dates
create or replace function public.absence_preavis_active_for(p_user uuid, p_from date, p_to date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.absence_circuit_steps s where s.kind = 'preavis' and s.active
                    and s.circuit_id = (public.absence_circuit_resolve(p_user, p_from, p_to) ->> 'circuit_id')::bigint);
$$;

-- Pré-avis d'une demande : valeur figée à l'ouverture de la ronde ; demande antérieure sans valeur figée : pré-avis du circuit général
create or replace function public.absence_preavis_of(a public.absences) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(a.preavis_active, exists (select 1 from public.absence_circuit_steps s where s.kind = 'preavis' and s.active and s.circuit_id = public.absence_circuit_default_id()));
$$;

-- Pré-avis encore utile : demande en cours, avant la colonne du visa
create or replace function public.absence_preavis_open(a public.absences) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.absence_preavis_of(a) and public.absence_is_open(a)
     and a.stage < coalesce((select public.absence_step_col(e) from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e where e ->> 'kind' = 'visa' limit 1), 2147483647);
$$;

-- `stage` de compatibilité pour l'interface actuelle : 1 = la colonne contient des validateurs de clinique, 2 = sinon
create or replace function public.absence_stage_compat(a public.absences) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select case when jsonb_array_length(public.absence_steps_of(a)) = 0 then case when a.stage >= 20 then 2 else 1 end
              when exists (select 1 from jsonb_array_elements(public.absence_active_steps(a)) e where e ->> 'kind' = 'clinique') then 1 else 2 end;
$$;

-- Instantané exposé à l'interface : sans identifiants de personnes, avec les étapes de la colonne en cours
create or replace function public.absence_circuit_public(a public.absences) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when a.circuit is null then null else
    (select coalesce(jsonb_agg(((t.e - 'persons') || jsonb_build_object('col', public.absence_step_col(t.e)))
                               || case when public.absence_step_col(t.e) = a.stage then '{"current":true}'::jsonb else '{}'::jsonb end order by t.ord), '[]'::jsonb)
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
  if r in ('direction', 'admin') and public.absence_preavis_of(a) then
    return jsonb_build_object('step', null, 'label', coalesce(
      (select s.label from public.absence_circuit_steps s where s.kind = 'preavis' and s.circuit_id = a.circuit_id),
      (select s.label from public.absence_circuit_steps s where s.kind = 'preavis' and s.circuit_id = public.absence_circuit_default_id()), 'Pré-avis de la direction'));
  end if;
  return null;
end;
$$;

-- 4. Moteur ------------------------------------------------------------------------------------------------------------------

-- Message « à la direction » (visa) en omettant les personnes déjà prévenues par « à valider » pour cette colonne : un seul message par personne
create or replace function public.absence_enqueue_direction(p_ids bigint[], p_owner uuid, p_skip uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r uuid; oid bigint;
begin
  foreach r in array public.absence_direction_recipients(p_owner) loop
    continue when r = any (coalesce(p_skip, '{}'::uuid[]));
    select id into oid from public.absence_outbox
      where kind = 'to_direction' and recipient = r and sent_at is null and claimed_at is null
        and payload ->> 'owner_id' = p_owner::text and created_at > now() - interval '10 minutes'
      order by id desc limit 1 for update skip locked;
    if oid is not null then
      update public.absence_outbox set absence_ids = array(select distinct x from unnest(absence_ids || p_ids) x order by x) where id = oid;
    else
      insert into public.absence_outbox (kind, recipient, absence_ids, payload)
        values ('to_direction', r, p_ids, jsonb_build_object('owner', public.member_name(p_owner), 'owner_id', p_owner));
    end if;
  end loop;
end;
$$;

-- Passe à la colonne suivante qui retient la demande, ou conclut la demande. Notifications d'avis des étapes non bloquantes rencontrées avant l'arrêt.
-- Une colonne est retenue si une de ses étapes bloquantes (hors visa) a des personnes, ou si elle contient le visa (jamais sauté).
-- p_after : colonne de départ (par défaut la colonne en cours) ; -1 pour partir du début d'un nouveau tour.
do $$
begin
  if to_regprocedure('public.absence_advance(bigint,uuid,text,boolean,boolean)') is not null then
    drop function public.absence_advance(bigint, uuid, text, boolean, boolean);
  end if;
end $$;
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
        'step_label', public.absence_col_label(a)));
    end if;
  end loop;
  -- un refus peut être la dernière décision d'un envoi dont les autres absences sont déjà validées
  if k = 'rejected' then perform public.absence_form_after(p_id); end if;
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

create or replace function public.absence_open_round(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_open_round_core(p_id, true);
end;
$$;

-- La colonne en cours est soldée quand chaque étape bloquante l'est : règle « all » (plus de ligne en attente) ou « any » (une approbation ; les autres lignes passent à « skipped »), visa posé depuis l'arrivée dans la colonne
create or replace function public.absence_try_complete(p_id bigint, p_by uuid, p_comment text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.absences; s jsonb; k text; ppl uuid[]; pend int; apr int; n int := 0; done boolean := true; st int;
begin
  select * into a from public.absences where id = p_id for update;
  if not found or not public.absence_is_open(a) then return false; end if;
  for s in select value from jsonb_array_elements(public.absence_steps_of(a)) where (value ->> 'blocking')::boolean order by (value ->> 'pos')::int loop
    n := n + 1;
    k := s ->> 'kind';
    st := (s ->> 'pos')::int;
    if k = 'visa' then
      if not public.absence_visa_done(a) then done := false; end if;
      continue;
    end if;
    ppl := case when k = 'clinique' then null else public.absence_step_people(a, s) end;
    select count(*) filter (where decision = 'pending' and (case when k = 'clinique'
                                then public.can_validate_absence(validator_id, a.user_id, public.absence_lo(a), public.absence_hi(a))
                                else validator_id = any (ppl) end)),
           count(*) filter (where decision = 'approved')
      into pend, apr from public.absence_approvals where absence_id = p_id and step = st;
    if s ->> 'rule' = 'any' then
      if apr = 0 and pend > 0 then done := false; continue; end if;
      update public.absence_approvals set decision = 'skipped' where absence_id = p_id and step = st and decision = 'pending';
    elsif pend > 0 then
      done := false;
    end if;
  end loop;
  if n = 0 or not done then return false; end if;
  perform public.absence_advance(p_id, p_by, p_comment);
  return true;
end;
$$;

create or replace function public.absence_decide(p_id bigint, p_approve boolean, p_comment text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); a public.absences; c text := nullif(trim(coalesce(p_comment, '')), ''); r text; s jsonb;
  blk int := 0; mem jsonb[] := '{}'; todo jsonb[] := '{}'; n_visa int := 0; n_clin int := 0; visa_todo boolean := false; rstep int; non_visa int := 0;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  r := public.current_role_name();
  -- étapes bloquantes de la colonne en cours auxquelles l'appelant appartient (l'administrateur appartient à toutes), et celles qu'il n'a pas encore approuvées
  for s in select value from jsonb_array_elements(public.absence_steps_of(a)) where (value ->> 'blocking')::boolean order by (value ->> 'pos')::int loop
    blk := blk + 1;
    if s ->> 'kind' = 'visa' then n_visa := n_visa + 1; elsif s ->> 'kind' = 'clinique' then n_clin := n_clin + 1; end if;
    if r = 'admin' or public.absence_step_member(uid, a, s) then
      mem := mem || s;
      if r = 'admin' or not public.absence_step_done(uid, a, s) then todo := todo || s; end if;
    end if;
  end loop;
  if r <> 'admin' and coalesce(array_length(mem, 1), 0) = 0 then
    if n_visa = blk and blk > 0 then raise exception 'Cette demande attend le visa de la direction.' using errcode = '42501'; end if;
    if n_clin = blk and blk > 0 then raise exception 'Vous ne validez pas les absences de ce membre.' using errcode = '42501'; end if;
    raise exception 'Vous ne validez pas cette étape de la demande.' using errcode = '42501';
  end if;
  if not public.absence_is_open(a) then raise exception 'Cette absence n''attend aucune décision.'; end if;
  if not coalesce(p_approve, false) and char_length(coalesce(c, '')) < 3 then raise exception 'Un refus demande un commentaire.'; end if;
  if char_length(coalesce(c, '')) > 500 then raise exception 'Commentaire trop long (500 caractères au plus).'; end if;
  if coalesce(array_length(todo, 1), 0) = 0 and r <> 'admin' then raise exception 'Vous avez déjà donné votre décision.'; end if;

  foreach s in array todo loop
    if s ->> 'kind' = 'visa' then visa_todo := true; else non_visa := non_visa + 1; end if;
  end loop;
  -- l'approbation d'un administrateur au visa (sans autre étape) est rattachée à l'étape de clinique (signataire du formulaire, comme avant)
  rstep := coalesce((select (e ->> 'pos')::int from jsonb_array_elements(coalesce(a.circuit, '[]'::jsonb)) e where e ->> 'kind' = 'clinique' limit 1),
                    (select (e ->> 'pos')::int from jsonb_array_elements(public.absence_steps_of(a)) e limit 1), a.stage);

  -- une décision enregistrée pour chacune des étapes de la colonne auxquelles l'appelant appartient
  foreach s in array todo loop
    continue when s ->> 'kind' = 'visa';
    insert into public.absence_approvals (absence_id, step, validator_id, decision, comment, decided_at)
      values (p_id, (s ->> 'pos')::int, uid, case when p_approve then 'approved' else 'rejected' end, c, now())
      on conflict (absence_id, step, validator_id) do update set decision = excluded.decision, comment = excluded.comment, decided_at = excluded.decided_at;
  end loop;
  if r = 'admin' and non_visa = 0 then
    insert into public.absence_approvals (absence_id, step, validator_id, decision, comment, decided_at)
      values (p_id, rstep, uid, case when p_approve then 'approved' else 'rejected' end, c, now())
      on conflict (absence_id, step, validator_id) do update set decision = excluded.decision, comment = excluded.comment, decided_at = excluded.decided_at;
  end if;

  if not p_approve then
    perform public.absence_finalize_reject(p_id, uid, c);
  elsif r = 'admin' then
    -- l'administrateur tranche seul : toute la chaîne est soldée, son nom tient lieu de visa de la direction
    update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
    update public.absences set direction_by = uid, direction_at = now() where id = p_id;
    perform public.absence_finalize_approve(p_id, uid, c);
  else
    if visa_todo then update public.absences set direction_by = uid, direction_at = now() where id = p_id; end if;
    perform public.absence_try_complete(p_id, uid, c);
  end if;
  return (select case when status = 'requested' or (status = 'approved' and change_type is not null) then 'requested' else status end from public.absences where id = p_id);
end;
$$;

-- Cette demande attend-elle une décision de ce membre ? (au moins une étape bloquante de la colonne en cours qui l'attend)
create or replace function public.absence_actionable(p_uid uuid, a public.absences) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_uid is null or not public.tool_allowed(p_uid, 'absences') then false
    when (select role from public.profiles where id = p_uid) = 'admin' then true
    else exists (select 1 from jsonb_array_elements(public.absence_steps_of(a)) e
                  where (e ->> 'blocking')::boolean and public.absence_step_member(p_uid, a, e) and not public.absence_step_done(p_uid, a, e))
  end;
$$;

-- 5. Notifications -----------------------------------------------------------------------------------------------------------

create or replace function public.absence_enqueue(p_kind text, p_recipient uuid, p_ids bigint[], p_payload jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids bigint[]; oid bigint;
begin
  select array_agg(a.id order by a.start_date, a.id) into ids from public.absences a where a.id = any (p_ids) and (
    case when p_kind in ('to_validate', 'to_validate_change') then
      p_recipient = any (public.absence_col_people(a))
    when p_kind in ('approved', 'rejected', 'change_approved', 'change_rejected', 'direction_change') then p_recipient = a.user_id
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
    when p_kind in ('approved', 'rejected', 'change_approved', 'change_rejected', 'direction_change') then a.user_id = p_recipient
    else false end;
$$;

-- Relance : lignes en attente de la colonne en cours (membres qui peuvent encore décider) ; à défaut, personnes de la colonne, puis direction
create or replace function public.absence_resend_pairs(p_user uuid, p_ids bigint[]) returns table(absence_id bigint, recipient uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a public.absences; s jsonb; r uuid; seen uuid[]; rows_ uuid[];
begin
  for a in select x.* from public.absences x where x.id = any (p_ids) loop
    seen := '{}'::uuid[];
    for s in select value from jsonb_array_elements(public.absence_steps_of(a)) where (value ->> 'blocking')::boolean and value ->> 'kind' <> 'visa' order by (value ->> 'pos')::int loop
      for r in select p.validator_id from public.absence_approvals p
                where p.absence_id = a.id and p.decision = 'pending' and p.step = (s ->> 'pos')::int
                  and (case when s ->> 'kind' = 'clinique'
                            then public.can_validate_absence(p.validator_id, p_user, public.absence_lo(a), public.absence_hi(a))
                            else p.validator_id = any (public.absence_step_people(a, s)) end)
                order by p.validator_id loop
        if not (r = any (seen)) then
          seen := seen || r;
          absence_id := a.id; recipient := r; return next;
        end if;
      end loop;
    end loop;
    -- le visa de la direction, s'il est dans la colonne et pas encore posé
    if not public.absence_visa_done(a) then
      for s in select value from jsonb_array_elements(public.absence_steps_of(a)) where value ->> 'kind' = 'visa' loop
        for r in select unnest(public.absence_step_people(a, s)) loop
          if not (r = any (seen)) then
            seen := seen || r;
            absence_id := a.id; recipient := r; return next;
          end if;
        end loop;
      end loop;
    end if;
    if coalesce(array_length(seen, 1), 0) = 0 then
      rows_ := public.absence_col_people(a);
      if coalesce(array_length(rows_, 1), 0) = 0 or not exists (select 1 from jsonb_array_elements(public.absence_steps_of(a)) e where e ->> 'kind' in ('visa', 'personnes', 'direction', 'groupe')) then
        rows_ := public.absence_direction_recipients(p_user);
      end if;
      for r in select unnest(rows_) loop
        absence_id := a.id; recipient := r; return next;
      end loop;
    end if;
  end loop;
end;
$$;

create or replace function public.absence_my_validators_full() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); v uuid[] := '{}'; fb boolean := false; a record; fs jsonb; first_step jsonb; fsteps jsonb;
begin
  perform public.absence_guard();
  if exists (select 1 from public.absences where user_id = uid and status = 'draft') then
    for a in select x.kind, x.start_date, x.end_date from public.absences x where x.user_id = uid and x.status = 'draft' order by x.start_date, x.id loop
      fs := public.absence_first_stop(uid, a.start_date, a.end_date, public.absence_circuit_build(a.kind, a.start_date, a.end_date, null, uid));
      first_step := coalesce(first_step, fs -> 'step'); fsteps := coalesce(fsteps, fs -> 'steps');
      if fs -> 'step' ->> 'kind' = 'visa' then fb := true; end if;
      v := v || array(select p::uuid from jsonb_array_elements_text(fs -> 'people') p where not (p::uuid = any (v)));
    end loop;
  else
    fs := public.absence_first_stop(uid, public.ch_today(), public.ch_today(), public.absence_circuit_build('vacances', public.ch_today(), public.ch_today(), null, uid));
    first_step := fs -> 'step'; fsteps := fs -> 'steps';
    fb := fs -> 'step' ->> 'kind' = 'visa';
    v := array(select p::uuid from jsonb_array_elements_text(fs -> 'people') p);
  end if;
  return jsonb_build_object('fallback', fb, 'steps', coalesce((select jsonb_agg(jsonb_build_object('label', x ->> 'label', 'rule', coalesce(x ->> 'rule', 'all'))) from jsonb_array_elements(coalesce(fsteps, '[]'::jsonb)) x), '[]'::jsonb), 'step_kind', first_step ->> 'kind', 'step_label', first_step ->> 'label', 'step_rule', coalesce(first_step ->> 'rule', 'all'),
    'validators', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by public.member_name(x)) from unnest(v) x), '[]'::jsonb));
end;
$$;

-- Liste des validateurs pour l'interface : 12 noms au plus, le nombre restant (more) et un résumé (summary) au-delà
create or replace function public.absence_validators_view(w jsonb) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare n int := jsonb_array_length(coalesce(w -> 'validators', '[]'::jsonb));
begin
  if n <= 12 then return w || jsonb_build_object('more', 0, 'summary', null); end if;
  return w || jsonb_build_object(
    'validators', (select jsonb_agg(x order by o) from (select x, o from jsonb_array_elements(w -> 'validators') with ordinality t(x, o) order by o limit 12) q),
    'more', n - 12,
    'summary', n || ' personnes : ' || coalesce(nullif(w ->> 'step_label', ''), 'validateurs'));
end;
$$;

create or replace function public.absence_my_validators() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return public.absence_validators_view(public.absence_my_validators_full());
end;
$$;

create or replace function public.absence_submit() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); ids bigint[]; rec uuid[]; who jsonb; fb boolean; rcp uuid; oi bigint[];
begin
  perform public.absence_guard();
  perform public.absence_purge();
  who := public.absence_my_validators_full();
  fb := (who ->> 'fallback')::boolean;
  select array_agg(id order by start_date) into ids from public.absences where user_id = uid and status = 'draft';
  if ids is null then raise exception 'Aucune demande en brouillon à envoyer.'; end if;
  update public.absences set status = 'requested', submitted_at = now(), notified_at = null, decision = null, decision_comment = null,
    decided_by = null, decided_at = null where id = any (ids);
  perform public.absence_open_round(i) from unnest(ids) i;
  select coalesce(array_agg((x ->> 'id')::uuid), '{}') into rec from jsonb_array_elements(who -> 'validators') x;
  perform public.absence_enqueue('to_validate', r, ids, jsonb_build_object('owner', public.member_name(uid))) from unnest(rec) r;
  -- Pré-avis de la direction, en parallèle et sans bloquer : demande par demande, sans doublon pour qui reçoit déjà le message de validation de cette demande
  foreach rcp in array public.absence_opinion_recipients(uid) loop
    oi := array(select x.id from public.absences x where x.id = any (ids) and public.absence_preavis_of(x)
                   and not (rcp = any (public.absence_col_people(x))) order by x.start_date, x.id);
    if coalesce(array_length(oi, 1), 0) > 0 then
      perform public.absence_enqueue('to_opinion', rcp, oi, jsonb_build_object('owner', public.member_name(uid)));
    end if;
  end loop;
  who := public.absence_validators_view(who);
  return jsonb_build_object('count', array_length(ids, 1), 'ids', to_jsonb(ids), 'fallback', fb, 'validators', who -> 'validators', 'more', who -> 'more', 'summary', who -> 'summary');
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
  rec := public.absence_col_people(a);
  perform public.absence_enqueue('to_validate_change', r, array[p_id], jsonb_build_object('owner', public.member_name(uid))) from unnest(rec) r;
  if public.absence_preavis_of(a) then
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
  if (in_group or dir_step) and not validator then k := k || array['to_validate', 'to_validate_change']; end if;
  if validator or direction or in_group or exists (select 1 from public.absence_circuit_steps s where s.kind = 'personnes' and s.active and p_user = any (s.persons)) then
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

-- Nouvelle colonne `steps` (étapes de la colonne en cours) : le type de retour change, l'ancienne signature est supprimée si elle n'a pas encore cette colonne
do $$
begin
  if to_regprocedure('public.absence_to_validate()') is not null
     and not exists (select 1 from pg_proc where oid = to_regprocedure('public.absence_to_validate()') and 'steps' = any (proargnames)) then
    drop function public.absence_to_validate();
  end if;
end $$;
create or replace function public.absence_to_validate()
returns table(id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text, change_type text, change_kind text,
  change_note text, change_start date, change_end date, created_at timestamptz, change_requested_at timestamptz, conflicts jsonb, my_decision text, progress jsonb, stage integer,
  opinions jsonb, step_kind text, step_label text, steps jsonb)
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
                     order by (e ->> 'pos')::int) from jsonb_array_elements(public.absence_active_steps(a)) e), '[]'::jsonb)
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
           case when public.absence_is_open(a) then public.absence_col_kind(a) end,
           case when public.absence_is_open(a) then public.absence_col_label(a) end,
           case when a.status = 'requested' then 'En cours : ' || case coalesce(public.absence_col_kind(a), 'clinique')
                  when 'visa' then 'visa de la direction' when 'clinique' then 'chez les validateurs'
                  else coalesce(public.absence_col_label(a), 'étape suivante') end end
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
               'step_kind', case when public.absence_is_open(a) then public.absence_col_kind(a) end,
               'step_label', case when public.absence_is_open(a) then public.absence_col_label(a) end)
             order by a.start_date, a.id)
        from public.absences a
       where a.status in ('requested', 'approved') and a.start_date <= p_to and a.end_date >= p_from
         and a.user_id in (select m.id from members m)), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

-- Document de lot figé : signataires = étape de clinique ; extra = approbations des étapes « personnes » et « direction » bloquantes (case du PDF : slot, sinon sans case)
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
                   cross join lateral (select e from jsonb_array_elements(coalesce(a.circuit,'[]'::jsonb)) e where (e->>'pos')::int=p.step and e->>'kind' in ('personnes','direction') and (e->>'blocking')::boolean limit 1) st(e)
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
  insert into public.absences (user_id, kind, note, start_date, end_date, status, submitted_at, decision, decided_by, decided_at, direction_by, direction_at, stage, circuit, circuit_id, circuit_name, preavis_active, confidential, form_queued_at)
    values (p_user, p_kind, n, p_start, p_end, 'approved', now(), 'approved', uid, now(), uid, now(), 10, public.absence_circuit_build(p_kind, p_start, p_end, null, p_user),
            (public.absence_circuit_resolve(p_user, p_start, p_end) ->> 'circuit_id')::bigint, public.absence_circuit_resolve(p_user, p_start, p_end) ->> 'name', false, conf, now()) returning id into new_id;
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
    stage = 10, circuit = public.absence_circuit_build(p_kind, p_start, p_end, null, a.user_id),
    circuit_id = (public.absence_circuit_resolve(a.user_id, p_start, p_end) ->> 'circuit_id')::bigint, circuit_name = public.absence_circuit_resolve(a.user_id, p_start, p_end) ->> 'name', preavis_active = false, direction_by = uid, direction_at = now(), notified_at = null, decision='change_approved',decided_by=uid,decided_at=clock_timestamp() where id = p_id;
  update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
  if a.user_id <> uid then
    perform public.absence_enqueue('direction_change', a.user_id, array[p_id], jsonb_build_object('action', 'edited', 'by', public.member_name(uid)));
  end if;
  perform public.absence_queue_correction(p_id,'modified_direct');
  return jsonb_build_object('id', p_id, 'conflicts', public.absence_conflicts_json(a.user_id, p_start, p_end),
                            'balance', public.absence_balance_check(a.user_id, p_kind, p_start, p_end, p_id));
end;
$$;

-- 9. Administration des circuits ---------------------------------------------------------------------------------------------

-- Circuit existant (null : le circuit général)
create or replace function public.absence_circuit_check_id(p_circuit bigint) returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare cid bigint := coalesce(p_circuit, public.absence_circuit_default_id());
begin
  if cid is null or not exists (select 1 from public.absence_circuits where id = cid) then raise exception 'Circuit introuvable.'; end if;
  return cid;
end;
$$;

create or replace function public.absence_circuit_steps_named(p_circuit bigint default null) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'pos', s.pos, 'col', s.col, 'kind', s.kind, 'label', s.label, 'rule', s.rule, 'blocking', s.blocking, 'active', s.active,
    'persons', (select coalesce(jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x), 'has_tool', public.tool_allowed(x, 'absences'))
                                          order by lower(coalesce(public.member_name(x), ''))), '[]'::jsonb) from unnest(s.persons) x),
    'roles', to_jsonb(s.roles), 'scope', s.scope,
    'kinds', to_jsonb(s.kinds), 'min_days', s.min_days, 'pdf_slot', s.pdf_slot) order by s.col, s.pos), '[]'::jsonb)
  from public.absence_circuit_steps s where s.circuit_id = coalesce(p_circuit, public.absence_circuit_default_id());
$$;

-- Attributions d'un circuit, avec le nom des membres
create or replace function public.absence_circuit_assignments_json(p_circuit bigint) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('type', a.target_type, 'target', a.target,
      'name', case when a.target_type = 'member' and a.target ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   then coalesce(public.member_name(a.target::uuid), a.target) else a.target end)
    order by a.target_type, lower(case when a.target_type = 'member' and a.target ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   then coalesce(public.member_name(a.target::uuid), a.target) else a.target end)), '[]'::jsonb)
  from public.absence_circuit_assignments a where a.circuit_id = p_circuit;
$$;

-- Circuit suivi par chaque membre (non « member », avec l'outil Absences), aux dates du jour
create or replace function public.absence_circuit_who_core() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name, 'role', q.role, 'clinics', to_jsonb(q.cl),
      'circuit_id', (q.r ->> 'circuit_id')::bigint, 'circuit_name', q.r ->> 'name', 'reason', q.r ->> 'reason', 'detail', q.r -> 'detail',
      'conflict', coalesce((q.r ->> 'conflict')::boolean, false)) order by lower(coalesce(q.name, '')), q.id), '[]'::jsonb)
  from (select p.id, public.member_name(p.id) as name, p.role, public.member_clinics(p.id, public.ch_today(), public.ch_today()) as cl,
               public.absence_circuit_resolve(p.id, public.ch_today(), public.ch_today()) as r
          from public.profiles p where p.role <> 'member' and public.tool_allowed(p.id, 'absences')) q;
$$;

create or replace function public.absence_circuit_get(p_circuit bigint default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare cid bigint; c public.absence_circuits;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
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
  insert into public.absence_circuit_steps (circuit_id, pos, col, kind, label, rule, blocking, active, persons, roles, scope, kinds, min_days, pdf_slot)
    select cid, s.pos, s.col, s.kind, s.label, s.rule, s.blocking, s.active,
           array(select x::uuid from jsonb_array_elements_text(coalesce(s.persons, '[]'::jsonb)) x),
           case when s.roles is null or jsonb_typeof(s.roles) <> 'array' then null else array(select x from jsonb_array_elements_text(s.roles) x) end,
           s.scope,
           case when s.kinds is null or jsonb_typeof(s.kinds) <> 'array' then null else array(select x from jsonb_array_elements_text(s.kinds) x) end,
           s.min_days, s.pdf_slot
      from jsonb_to_recordset(norm) as s(pos int, col int, kind text, label text, rule text, blocking boolean, active boolean, persons jsonb, roles jsonb, scope text, kinds jsonb, min_days int, pdf_slot text);
  insert into public.absence_circuit_log (changed_by, before, after, circuit_id, action) values (auth.uid(), before, public.absence_circuit_steps_json(cid), cid, 'save_steps');
  return public.absence_circuit_get(cid) || case when exists (select 1 from public.absence_circuit_steps where circuit_id = cid and kind = 'visa' and active) then '{}'::jsonb
    else jsonb_build_object('warning', 'Aucun visa de la direction actif : les demandes sans validateur iront aux administrateurs.') end;
end;
$$;

-- Nouveau circuit alternatif : copie des étapes du circuit source (par défaut le circuit général)
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
  insert into public.absence_circuit_steps (circuit_id, pos, col, kind, label, rule, blocking, active, persons, roles, scope, kinds, min_days, pdf_slot)
    select nid, s.pos, s.col, s.kind, s.label, s.rule, s.blocking, s.active, s.persons, s.roles, s.scope, s.kinds, s.min_days, s.pdf_slot from public.absence_circuit_steps s where s.circuit_id = src;
  insert into public.absence_circuit_log (changed_by, before, after, circuit_id, action)
    values (auth.uid(), null, jsonb_build_object('name', nm, 'copy_from', src), nid, 'create');
  return nid;
end;
$$;

create or replace function public.absence_circuit_rename(p_circuit bigint, p_name text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare nm text := btrim(coalesce(p_name, '')); c public.absence_circuits;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  select * into c from public.absence_circuits where id = p_circuit for update;
  if not found then raise exception 'Circuit introuvable.'; end if;
  if c.is_default then raise exception 'Le circuit général ne se renomme pas.'; end if;
  if char_length(nm) not between 1 and 60 then raise exception 'Le nom d''un circuit compte de 1 à 60 caractères.'; end if;
  if exists (select 1 from public.absence_circuits where lower(name) = lower(nm) and id <> p_circuit) then raise exception 'Un circuit porte déjà ce nom.'; end if;
  update public.absence_circuits set name = nm where id = p_circuit;
  insert into public.absence_circuit_log (changed_by, before, after, circuit_id, action)
    values (auth.uid(), jsonb_build_object('name', c.name), jsonb_build_object('name', nm), p_circuit, 'rename');
end;
$$;

-- Suppression d'un circuit alternatif : ses attributions disparaissent, ses membres reviennent au circuit général pour les nouvelles demandes ; les demandes en cours gardent leur instantané
create or replace function public.absence_circuit_delete(p_circuit bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.absence_circuits;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  select * into c from public.absence_circuits where id = p_circuit for update;
  if not found then raise exception 'Circuit introuvable.'; end if;
  if c.is_default then raise exception 'Le circuit général ne se supprime pas.'; end if;
  delete from public.absence_circuit_assignments where circuit_id = p_circuit;
  delete from public.absence_circuits where id = p_circuit;
  insert into public.absence_circuit_log (changed_by, before, after, circuit_id, action)
    values (auth.uid(), jsonb_build_object('name', c.name), null, p_circuit, 'delete');
end;
$$;

-- Ordre des circuits alternatifs (le circuit général reste en tête)
create or replace function public.absence_circuit_reorder(p_ids bigint[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare alt bigint[];
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  perform 1 from public.absence_circuits where is_default for update;
  alt := array(select id from public.absence_circuits where not is_default order by pos, id);
  if p_ids is null or cardinality(p_ids) <> cardinality(alt) or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids) or not (p_ids <@ alt) then
    raise exception 'La liste des circuits est incomplète ou invalide.';
  end if;
  update public.absence_circuits c set pos = 10 * t.o from unnest(p_ids) with ordinality t(id, o) where c.id = t.id;
  -- une ligne par circuit alternatif (et une pour le circuit général), pour que l'ordre apparaisse dans chaque journal
  insert into public.absence_circuit_log (changed_by, before, after, circuit_id, action)
    select auth.uid(), to_jsonb(alt), to_jsonb(p_ids), c.id, 'reorder' from public.absence_circuits c;
end;
$$;

-- Remplace les attributions d'un circuit pour un type de cible (sans contrôle de droit ni journal) ; renvoie les libellés des cibles
create or replace function public.absence_circuit_assign_apply(p_circuit bigint, p_type text, p_targets text[]) returns text[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare x text; tg text[] := '{}'; o text; lbl text; labels text[] := '{}';
begin
  if p_type is null or p_type not in ('member', 'role', 'clinic') then raise exception 'Type d''attribution inconnu.'; end if;
  if cardinality(coalesce(p_targets, '{}')) > 500 then raise exception 'Trop de cibles (500 au plus).'; end if;
  for x in select distinct lower(btrim(v)) from unnest(coalesce(p_targets, '{}')) v where btrim(v) <> '' order by 1 loop
    if p_type = 'member' then
      if x !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Un membre désigné est invalide.'; end if;
      if not exists (select 1 from public.profiles p where p.id = x::uuid and p.role <> 'member') then raise exception 'Un membre désigné n''existe pas ou n''a pas encore de rôle.'; end if;
      lbl := coalesce(public.member_name(x::uuid), x);
    elsif p_type = 'role' then
      if x not in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'admin', 'direction', 'nurse') then raise exception 'Rôle inconnu : %.', x; end if;
      lbl := x;
    else
      -- les cliniques gardent leur casse d'origine
      select s.clinic into lbl from public.absence_clinic_settings s where lower(s.clinic) = x;
      if lbl is null then raise exception 'Clinique inconnue : %.', x; end if;
      x := lbl;
    end if;
    o := null;
    select ac.name into o from public.absence_circuit_assignments a join public.absence_circuits ac on ac.id = a.circuit_id
     where a.target_type = p_type and a.target = x and a.circuit_id <> p_circuit;
    if o is not null then raise exception 'La cible « % » suit déjà le circuit « % ».', lbl, o; end if;
    tg := tg || x; labels := labels || lbl;
  end loop;
  delete from public.absence_circuit_assignments where circuit_id = p_circuit and target_type = p_type;
  insert into public.absence_circuit_assignments (circuit_id, target_type, target) select p_circuit, p_type, t from unnest(tg) t;
  return labels;
end;
$$;

-- Circuit alternatif modifiable : existant, pas le circuit général (verrouillé)
create or replace function public.absence_circuit_assign_guard(p_circuit bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.absence_circuits;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  select * into c from public.absence_circuits where id = p_circuit for update;
  if not found then raise exception 'Circuit introuvable.'; end if;
  if c.is_default then raise exception 'Le circuit général ne s''attribue pas : retirez l''attribution d''un circuit alternatif pour y revenir.'; end if;
end;
$$;

create or replace function public.absence_circuit_assign(p_circuit bigint, p_type text, p_targets text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare labels text[];
begin
  perform public.absence_circuit_assign_guard(p_circuit);
  labels := public.absence_circuit_assign_apply(p_circuit, p_type, p_targets);
  insert into public.absence_circuit_log (changed_by, before, after, circuit_id, action)
    values (auth.uid(), null, jsonb_build_object('type', p_type, 'targets', to_jsonb(labels)), p_circuit, 'assign');
  return public.absence_circuit_assignments_json(p_circuit);
end;
$$;

-- Les trois types d'un coup : une transaction, une ligne de journal
create or replace function public.absence_circuit_assign_all(p_circuit bigint, p_members text[], p_roles text[], p_clinics text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare lm text[]; lr text[]; lc text[];
begin
  perform public.absence_circuit_assign_guard(p_circuit);
  lm := public.absence_circuit_assign_apply(p_circuit, 'member', p_members);
  lr := public.absence_circuit_assign_apply(p_circuit, 'role', p_roles);
  lc := public.absence_circuit_assign_apply(p_circuit, 'clinic', p_clinics);
  insert into public.absence_circuit_log (changed_by, before, after, circuit_id, action)
    values (auth.uid(), null, jsonb_build_object('type', 'all', 'targets', to_jsonb(lm || lr || lc)), p_circuit, 'assign');
  return public.absence_circuit_assignments_json(p_circuit);
end;
$$;

create or replace function public.absence_circuit_who() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  return public.absence_circuit_who_core();
end;
$$;

create or replace function public.absence_circuit_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare who jsonb;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  who := public.absence_circuit_who_core();
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'is_default', c.is_default, 'pos', c.pos,
      'assignments', public.absence_circuit_assignments_json(c.id),
      'active_steps', (select count(*) from public.absence_circuit_steps s where s.circuit_id = c.id and s.active),
      'members', (select count(*) from jsonb_array_elements(who) w where (w ->> 'circuit_id')::bigint = c.id))
      order by c.is_default desc, c.pos, c.id) from public.absence_circuits c), '[]'::jsonb);
end;
$$;

do $$
begin
  if to_regprocedure('public.absence_circuit_simulate(uuid,date,date)') is not null then
    execute 'drop function public.absence_circuit_simulate(uuid, date, date)';
  end if;
end $$;

create or replace function public.absence_circuit_simulate(p_user uuid, p_from date, p_to date, p_kind text default 'vacances', p_steps jsonb default null, p_circuit bigint default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  r text; cl text[]; selfx boolean; norm jsonb; circ jsonb; pre jsonb; pre_active boolean; fs jsonb; stop_people uuid[]; op uuid[];
  e jsonb; ppl uuid[]; k text; nxt text; note text; steps jsonb := '[]'::jsonb; cols jsonb; excl jsonb := '[]'::jsonb; rule_txt text; vis_admin boolean; resolved jsonb; cid bigint; cinfo jsonb;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
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

create or replace function public.absence_circuit_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare res jsonb; warns jsonb := '[]'::jsonb; c record; v record; st record; dir_active int; n_active int; who jsonb; w jsonb; ca record;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
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

-- 10. Droits -----------------------------------------------------------------------------------------------------------------

revoke execute on function
  public.absence_circuit_steps_json(bigint), public.absence_circuit_normalize(jsonb), public.absence_circuit_build(text, date, date, jsonb, uuid),
  public.absence_circuit_for(public.absences), public.absence_step_col(jsonb), public.absence_steps_of(public.absences), public.absence_is_open(public.absences),
  public.absence_active_steps(public.absences), public.absence_col_people(public.absences), public.absence_col_kind(public.absences), public.absence_col_label(public.absences),
  public.absence_visa_done(public.absences), public.absence_step_member(uuid, public.absences, jsonb), public.absence_step_done(uuid, public.absences, jsonb),
  public.absence_step_people_for(uuid, date, date, jsonb), public.absence_step_people(public.absences, jsonb), public.absence_step_kind(public.absences, int),
  public.absence_nonblocking_people(public.absences), public.absence_first_stop(uuid, date, date, jsonb), public.absence_preavis_active_for(uuid, date, date),
  public.absence_preavis_of(public.absences),
  public.absence_preavis_open(public.absences), public.absence_stage_compat(public.absences), public.absence_circuit_public(public.absences),
  public.absence_opinion_step(uuid, public.absences), public.absence_advance(bigint, uuid, text, boolean, boolean, int), public.absence_circuit_fallback(),
  public.absence_open_round_core(bigint, boolean), public.absence_circuit_steps_named(bigint), public.absence_peer_people(public.absences), public.absence_step_label(public.absences, int),
  public.absence_decision_rows(public.absences), public.absence_in_personnes_step(uuid, public.absences),
  public.absence_enqueue_direction(bigint[], uuid, uuid[]), public.absence_my_validators_full(), public.absence_validators_view(jsonb), public.absence_circuit_default_id(), public.absence_circuit_resolve(uuid, date, date), public.absence_circuit_check_id(bigint),
  public.absence_circuit_assignments_json(bigint), public.absence_circuit_who_core(),
  public.absence_circuit_assign_apply(bigint, text, text[]), public.absence_circuit_assign_guard(bigint)
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
  public.absence_delete_rejected(bigint), public.absence_history(bigint),
  public.absence_direction_add(uuid, text, text, date, date, boolean), public.absence_direction_cancel(bigint),
  public.absence_direction_update(bigint, text, text, date, date, boolean),
  public.absence_circuit_get(bigint), public.absence_circuit_save(jsonb, bigint), public.absence_circuit_simulate(uuid, date, date, text, jsonb, bigint), public.absence_circuit_overview(),
  public.absence_circuit_list(), public.absence_circuit_create(text, bigint), public.absence_circuit_rename(bigint, text), public.absence_circuit_delete(bigint),
  public.absence_circuit_reorder(bigint[]), public.absence_circuit_assign(bigint, text, text[]), public.absence_circuit_assign_all(bigint, text[], text[], text[]), public.absence_circuit_who()
  from public, anon;
grant execute on function
  public.absence_decide(bigint, boolean, text), public.absence_my_validators(), public.absence_submit(),
  public.absence_request_change(bigint, text, text, text, date, date), public.absence_opinion_set(bigint, text, text), public.absence_opinion_todo(),
  public.absence_to_validate(), public.absence_approvals_all(uuid), public.absence_rejected_to_manage(), public.absence_list(uuid), public.absence_export(date, date), public.absence_planning(date, date),
  public.absence_delete_rejected(bigint), public.absence_history(bigint),
  public.absence_direction_add(uuid, text, text, date, date, boolean), public.absence_direction_cancel(bigint),
  public.absence_direction_update(bigint, text, text, date, date, boolean),
  public.absence_circuit_get(bigint), public.absence_circuit_save(jsonb, bigint), public.absence_circuit_simulate(uuid, date, date, text, jsonb, bigint), public.absence_circuit_overview(),
  public.absence_circuit_list(), public.absence_circuit_create(text, bigint), public.absence_circuit_rename(bigint, text), public.absence_circuit_delete(bigint),
  public.absence_circuit_reorder(bigint[]), public.absence_circuit_assign(bigint, text, text[]), public.absence_circuit_assign_all(bigint, text[], text[], text[]), public.absence_circuit_who()
  to authenticated;

do $$
begin
  if to_regclass('public.onconic_migrations') is not null then
    insert into public.onconic_migrations(version) values ('202611170001'), ('202611180001') on conflict do nothing;
  end if;
end $$;

commit;
