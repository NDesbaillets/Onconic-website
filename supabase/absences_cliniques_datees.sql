-- Onconic : rattachements datés aux cliniques (absences).
-- Les médecins assistants changent de bloc tous les 6 mois, les CDC peuvent changer de clinique : l'admin programme
-- « à partir du JJ.MM.AAAA, cliniques X, Y ». Les validateurs d'une absence sont ceux des cliniques du membre
-- pendant les dates de l'absence (union si elle chevauche un changement). Le médecin règle lui-même ses cliniques
-- actuelles dans Mon compte ; l'admin peut tout modifier.
-- À exécuter après absences.sql, cadre_medecin.sql, cadre_validateur.sql et absences_validation.sql. Relançable sans risque.

-- ===== 1. Changements programmés =====
-- profiles.clinics = cliniques actuelles ; chaque ligne ci-dessous = nouvelles cliniques à partir de valid_from.
-- Un changement échu est appliqué à profiles.clinics puis retiré (tâche quotidienne, voir fin de fichier).
create table if not exists public.member_clinic_changes (
  user_id uuid not null references public.profiles (id) on delete cascade,
  valid_from date not null,
  clinics text[] not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (user_id, valid_from)
);
alter table public.member_clinic_changes enable row level security;
revoke all on public.member_clinic_changes from anon, authenticated;

-- Cliniques d'un membre sur une période : cliniques actuelles (avant le premier changement programmé),
-- plus celles de chaque changement en vigueur pendant la période
create or replace function public.member_clinics(p_user uuid, p_from date, p_to date) returns text[]
language sql stable security definer set search_path = public as $$
  with ch as (
    select c.valid_from, c.clinics, lead(c.valid_from) over (order by c.valid_from) as nxt
    from public.member_clinic_changes c where c.user_id = p_user
  )
  select coalesce((
    select case
      when p.role in ('clinician', 'cdc', 'cadre') then coalesce(array(
        select distinct x from (
          select unnest(p.clinics) as x where not exists (select 1 from ch where ch.valid_from <= p_from)
          union all
          select unnest(ch.clinics) from ch where ch.valid_from <= p_to and (ch.nxt is null or ch.nxt > p_from)
        ) s order by x), '{}')
      when p.role in ('assistant', 'pharmacist', 'admin') then array['Administration']
      else '{}'::text[] end
    from public.profiles p where p.id = p_user), '{}'::text[]);
$$;

-- Cliniques d'aujourd'hui (un changement échu compte même avant le passage de la tâche quotidienne)
create or replace function public.member_clinics(p_user uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select public.member_clinics(p_user, public.ch_today(), public.ch_today());
$$;

-- Période couverte par une absence, y compris une modification demandée
create or replace function public.absence_lo(a public.absences) returns date
language sql immutable as $$ select least(a.start_date, coalesce(a.change_start, a.start_date)); $$;
create or replace function public.absence_hi(a public.absences) returns date
language sql immutable as $$ select greatest(a.end_date, coalesce(a.change_end, a.end_date)); $$;

-- ===== 2. Validateurs selon les dates =====
create or replace function public.can_validate_absence(p_validator uuid, p_user uuid, p_from date, p_to date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles v where v.id = p_validator and v.role = 'admin')
      or (p_validator <> p_user
          and public.tool_allowed(p_validator, 'absences')
          and exists (select 1 from public.absence_validators av
                      join public.profiles v on v.id = av.user_id and v.role = 'cadre' and v.absence_validator
                      where av.user_id = p_validator and av.clinic = any (public.member_clinics(p_user, p_from, p_to))));
$$;
-- Sans dates : toutes les cliniques connues du membre (actuelles et programmées), pour consulter sa liste
create or replace function public.can_validate_absence(p_validator uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_validate_absence(p_validator, p_user, date '1900-01-01', date '2999-12-31');
$$;

create or replace function public.absence_required_validators(p_user uuid, p_from date, p_to date) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct av.user_id), '{}'::uuid[])
  from public.absence_validators av
  join public.profiles v on v.id = av.user_id and v.role = 'cadre' and v.absence_validator
  where av.clinic = any (public.member_clinics(p_user, p_from, p_to)) and av.user_id <> p_user and public.tool_allowed(av.user_id, 'absences');
$$;
create or replace function public.absence_required_validators(p_user uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select public.absence_required_validators(p_user, public.ch_today(), public.ch_today());
$$;

create or replace function public.absence_validator_ids(p_user uuid, p_from date, p_to date) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(public.absence_required_validators(p_user, p_from, p_to), '{}'),
    (select array_agg(id) from public.profiles where role = 'admin' and id <> p_user),
    '{}');
$$;
create or replace function public.absence_validator_ids(p_user uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select public.absence_validator_ids(p_user, public.ch_today(), public.ch_today());
$$;

-- Tour de validation d'une absence : validateurs des cliniques pendant ses dates
create or replace function public.absence_open_round(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a public.absences;
begin
  select * into a from public.absences where id = p_id;
  if not found then return; end if;
  delete from public.absence_approvals where absence_id = p_id;
  insert into public.absence_approvals (absence_id, validator_id)
    select p_id, v from unnest(public.absence_required_validators(a.user_id, public.absence_lo(a), public.absence_hi(a))) v;
end;
$$;

-- Validateurs prévenus pour les brouillons en cours (ou, sans brouillon, pour aujourd'hui)
create or replace function public.absence_my_validators() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); v uuid[]; fb boolean := false;
begin
  perform public.absence_guard();
  if exists (select 1 from public.absences where user_id = uid and status = 'draft') then
    select coalesce(array_agg(distinct x), '{}') into v
      from public.absences a, unnest(public.absence_required_validators(uid, a.start_date, a.end_date)) x
      where a.user_id = uid and a.status = 'draft';
    fb := exists (select 1 from public.absences a where a.user_id = uid and a.status = 'draft'
                  and coalesce(array_length(public.absence_required_validators(uid, a.start_date, a.end_date), 1), 0) = 0);
  else
    v := public.absence_required_validators(uid);
    fb := coalesce(array_length(v, 1), 0) = 0;
  end if;
  if fb then v := v || coalesce((select array_agg(id) from public.profiles where role = 'admin' and id <> uid and not (id = any (v))), '{}'); end if;
  return jsonb_build_object('fallback', fb,
    'validators', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by public.member_name(x)) from unnest(v) x), '[]'::jsonb));
end;
$$;

create or replace function public.absence_submit() returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); ids bigint[]; rec uuid[]; who jsonb; fb boolean;
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
  return jsonb_build_object('count', array_length(ids, 1), 'ids', to_jsonb(ids), 'fallback', fb, 'validators', who -> 'validators');
end;
$$;

create or replace function public.absence_request_change(p_id bigint, p_type text, p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); a public.absences; res jsonb; rec uuid[];
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
  rec := public.absence_validator_ids(uid, public.absence_lo(a), public.absence_hi(a));
  perform public.absence_enqueue('to_validate_change', r, array[p_id], jsonb_build_object('owner', public.member_name(uid))) from unnest(rec) r;
  return res;
end;
$$;

create or replace function public.absence_decide(p_id bigint, p_approve boolean, p_comment text) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); a public.absences; c text := nullif(trim(coalesce(p_comment, '')), ''); is_admin boolean; d text;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if not public.can_validate_absence(uid, a.user_id, public.absence_lo(a), public.absence_hi(a)) then raise exception 'Vous ne validez pas les absences de ce membre.' using errcode = '42501'; end if;
  if not (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null)) then raise exception 'Cette absence n''attend aucune décision.'; end if;
  if not coalesce(p_approve, false) and char_length(coalesce(c, '')) < 3 then raise exception 'Un refus demande un commentaire.'; end if;
  if char_length(coalesce(c, '')) > 500 then raise exception 'Commentaire trop long (500 caractères au plus).'; end if;
  is_admin := public.current_role_name() = 'admin';
  select decision into d from public.absence_approvals where absence_id = p_id and validator_id = uid;
  if d in ('approved', 'rejected') and not is_admin then raise exception 'Vous avez déjà donné votre décision.'; end if;

  insert into public.absence_approvals (absence_id, validator_id, decision, comment, decided_at)
    values (p_id, uid, case when p_approve then 'approved' else 'rejected' end, c, now())
    on conflict (absence_id, validator_id) do update set decision = excluded.decision, comment = excluded.comment, decided_at = excluded.decided_at;

  if not p_approve then
    perform public.absence_finalize_reject(p_id, uid, c);
  elsif is_admin then
    update public.absence_approvals set decision = 'skipped' where absence_id = p_id and decision = 'pending';
    perform public.absence_finalize_approve(p_id, uid, c);
  else
    perform public.absence_try_complete(p_id, uid, c);
  end if;
  return (select case when status = 'requested' or (status = 'approved' and change_type is not null) then 'requested' else status end from public.absences where id = p_id);
end;
$$;

create or replace function public.absence_try_complete(p_id bigint, p_by uuid, p_comment text) returns boolean
language plpgsql security definer set search_path = public as $$
declare a public.absences; pend int; appr int;
begin
  select * into a from public.absences where id = p_id for update;
  if not found or not (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null)) then return false; end if;
  select count(*) filter (where decision = 'pending' and public.can_validate_absence(validator_id, a.user_id, public.absence_lo(a), public.absence_hi(a))),
         count(*) filter (where decision = 'approved')
    into pend, appr from public.absence_approvals where absence_id = p_id;
  if pend = 0 and appr > 0 then
    perform public.absence_finalize_approve(p_id, p_by, p_comment);
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.absence_delete_rejected(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); a public.absences;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id for update;
  if not found or a.status <> 'rejected' then raise exception 'Demande refusée introuvable.'; end if;
  if a.user_id <> uid and not public.can_validate_absence(uid, a.user_id, public.absence_lo(a), public.absence_hi(a)) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  delete from public.absences where id = p_id;
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
           case when a.user_id = auth.uid() or public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a)) then a.note end,
           a.change_type, a.change_start, a.change_end
    from public.absences a
    where a.status in ('requested', 'approved') and a.start_date <= p_to and a.end_date >= p_from
    order by a.start_date;
end;
$$;

create or replace function public.absence_pending_count() returns integer
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null or not public.tool_allowed(auth.uid(), 'absences') then 0
    else (select count(*)::int from public.absences a
          where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
            and public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a))
            and (public.current_role_name() = 'admin'
                 or not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.validator_id = auth.uid() and p.decision = 'approved'))) end;
$$;

create or replace function public.absence_rejected_to_manage()
returns table (id bigint, user_id uuid, name text, kind text, start_date date, end_date date, decision_comment text, decided_at timestamptz, decided_by_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), a.kind, a.start_date, a.end_date, a.decision_comment, a.decided_at,
           case when a.decided_by is null then null else public.member_name(a.decided_by) end
    from public.absences a
    where a.status = 'rejected' and a.decided_at >= now() - interval '14 days'
      and public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a))
    order by a.decided_at desc;
end;
$$;

create or replace function public.absence_to_validate()
returns table (id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text,
  change_type text, change_kind text, change_note text, change_start date, change_end date, created_at timestamptz,
  change_requested_at timestamptz, conflicts jsonb, my_decision text, progress jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, a.note, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, a.change_note, a.change_start, a.change_end, coalesce(a.submitted_at, a.created_at), a.change_requested_at,
           case when a.change_type = 'delete' then '[]'::jsonb
                when a.change_type = 'modify' then public.absence_conflicts_json(a.user_id, a.change_start, a.change_end)
                else public.absence_conflicts_json(a.user_id, a.start_date, a.end_date) end,
           coalesce((select p.decision from public.absence_approvals p where p.absence_id = a.id and p.validator_id = auth.uid()), 'pending'),
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(p.validator_id), 'decision', p.decision, 'comment', p.comment, 'at', p.decided_at)
                     order by public.member_name(p.validator_id)) from public.absence_approvals p where p.absence_id = a.id), '[]'::jsonb)
    from public.absences a
    where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
      and public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a))
      and (public.current_role_name() = 'admin'
           or not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.validator_id = auth.uid() and p.decision = 'approved'))
    order by coalesce(a.change_requested_at, a.submitted_at, a.created_at);
end;
$$;

create or replace function public.absence_resend_pairs(p_user uuid, p_ids bigint[])
returns table (absence_id bigint, recipient uuid)
language sql stable security definer set search_path = public as $$
  select p.absence_id, p.validator_id from public.absence_approvals p join public.absences a on a.id = p.absence_id
  where p.absence_id = any (p_ids) and p.decision = 'pending' and public.can_validate_absence(p.validator_id, p_user, public.absence_lo(a), public.absence_hi(a))
  union
  select i, ad.id from unnest(p_ids) i cross join public.profiles ad
  where ad.role = 'admin' and ad.id <> p_user
    and not exists (select 1 from public.absence_approvals p join public.absences a on a.id = p.absence_id
                    where p.absence_id = i and p.decision = 'pending' and public.can_validate_absence(p.validator_id, p_user, public.absence_lo(a), public.absence_hi(a)));
$$;

-- Chevauchements : cliniques de chacun jour par jour
create or replace function public.absence_conflicts(p_user uuid, p_start date, p_end date)
returns table (clinic text, max_absent int, peak int, first_day date, last_day date, others text[])
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
       where o.clinic = od.clinic and o.d in (select x.d from over_days x where x.clinic = od.clinic))
  from over_days od group by od.clinic, od.max_absent;
$$;

-- ===== 3. Réacheminement des demandes encore sans décision =====
-- Après un changement de cliniques, les demandes en cours dont personne n'a encore décidé repartent vers les bons validateurs.
-- Une demande déjà partiellement validée garde ses validateurs (aucune décision n'est perdue).
create or replace function public.absence_reroute(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select a.id from public.absences a
           where a.user_id = p_user and (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null))
             and not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.decision <> 'pending') loop
    perform public.absence_open_round(r.id);
  end loop;
end;
$$;

-- ===== 4. Réglages : le médecin pour lui-même, l'admin pour tous =====
create or replace function public.clinic_choice_check(p_clinics text[]) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare bad text;
begin
  select c into bad from unnest(coalesce(p_clinics, '{}')) c
    where not exists (select 1 from public.absence_clinic_settings s where s.clinic = c and s.clinic <> 'Administration') limit 1;
  if bad is not null then raise exception 'Clinique inconnue : %', bad; end if;
  return coalesce(array(select distinct c from unnest(coalesce(p_clinics, '{}')) c order by c), '{}');
end;
$$;

-- Mes cliniques : actuelles (modifiables par un médecin) et changements programmés par l'admin (lecture seule)
create or replace function public.my_clinics() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); r text;
begin
  if uid is null then raise exception 'Connexion requise.' using errcode = '42501'; end if;
  select role into r from public.profiles where id = uid;
  return jsonb_build_object(
    'role', r,
    'editable', r in ('clinician', 'cdc', 'cadre'),
    'clinics', to_jsonb(public.member_clinics(uid)),
    'options', to_jsonb(array(select clinic from public.absence_clinic_settings where clinic <> 'Administration' order by pos)),
    'changes', coalesce((select jsonb_agg(jsonb_build_object('valid_from', c.valid_from, 'clinics', c.clinics) order by c.valid_from)
                         from public.member_clinic_changes c where c.user_id = uid and c.valid_from > public.ch_today()), '[]'::jsonb));
end;
$$;

create or replace function public.my_set_clinics(p_clinics text[]) returns text[]
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); r text; v text[];
begin
  select role into r from public.profiles where id = uid;
  if r is null or r not in ('clinician', 'cdc', 'cadre') then raise exception 'Seuls les médecins règlent leurs cliniques.' using errcode = '42501'; end if;
  v := public.clinic_choice_check(p_clinics);
  update public.profiles set clinics = v where id = uid;
  perform public.absence_reroute(uid);
  return v;
end;
$$;

-- L'admin règle les cliniques actuelles (fonction existante, complétée par le réacheminement)
create or replace function public.admin_set_clinics(p_user uuid, p_clinics text[]) returns text[]
language plpgsql security definer set search_path = public as $$
declare r text; v text[];
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r not in ('clinician', 'cdc', 'cadre') then raise exception 'Seuls les médecins sont rattachés à une clinique.'; end if;
  v := public.clinic_choice_check(p_clinics);
  update public.profiles set clinics = v where id = p_user;
  perform public.absence_reroute(p_user);
  return v;
end;
$$;

-- L'admin programme « à partir du … : cliniques … » (date future), ou retire un changement programmé
create or replace function public.admin_clinic_change_save(p_user uuid, p_from date, p_clinics text[]) returns void
language plpgsql security definer set search_path = public as $$
declare r text; v text[];
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r not in ('clinician', 'cdc', 'cadre') then raise exception 'Seuls les médecins sont rattachés à une clinique.'; end if;
  if p_from is null or p_from <= public.ch_today() then raise exception 'Choisissez une date postérieure à aujourd''hui (pour aujourd''hui, modifiez les cliniques actuelles).'; end if;
  if p_from > public.ch_today() + 1100 then raise exception 'Date trop lointaine (3 ans au plus).'; end if;
  v := public.clinic_choice_check(p_clinics);
  insert into public.member_clinic_changes (user_id, valid_from, clinics, created_by) values (p_user, p_from, v, auth.uid())
    on conflict (user_id, valid_from) do update set clinics = excluded.clinics, created_by = excluded.created_by, created_at = now();
  perform public.absence_reroute(p_user);
end;
$$;

create or replace function public.admin_clinic_change_delete(p_user uuid, p_from date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  delete from public.member_clinic_changes where user_id = p_user and valid_from = p_from;
  perform public.absence_reroute(p_user);
end;
$$;

create or replace function public.admin_clinic_changes()
returns table (user_id uuid, valid_from date, clinics text[])
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  return query select c.user_id, c.valid_from, c.clinics from public.member_clinic_changes c
    where c.valid_from > public.ch_today() order by c.user_id, c.valid_from;
end;
$$;

-- Tâche quotidienne : un changement échu devient les cliniques actuelles
create or replace function public.apply_clinic_changes() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select distinct on (c.user_id) c.user_id, c.clinics from public.member_clinic_changes c
           where c.valid_from <= public.ch_today() order by c.user_id, c.valid_from desc loop
    update public.profiles set clinics = r.clinics where id = r.user_id and role in ('clinician', 'cdc', 'cadre');
    delete from public.member_clinic_changes where user_id = r.user_id and valid_from <= public.ch_today();
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ===== Droits =====
do $$
declare f text;
begin
  foreach f in array array['member_clinics(uuid, date, date)', 'member_clinics(uuid)', 'absence_lo(public.absences)', 'absence_hi(public.absences)',
    'can_validate_absence(uuid, uuid, date, date)', 'can_validate_absence(uuid, uuid)',
    'absence_required_validators(uuid, date, date)', 'absence_required_validators(uuid)',
    'absence_validator_ids(uuid, date, date)', 'absence_validator_ids(uuid)', 'absence_open_round(bigint)', 'absence_try_complete(bigint, uuid, text)',
    'absence_resend_pairs(uuid, bigint[])', 'absence_conflicts(uuid, date, date)', 'absence_reroute(uuid)', 'clinic_choice_check(text[])', 'apply_clinic_changes()']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['absence_my_validators()', 'absence_submit()', 'absence_request_change(bigint, text, text, text, date, date)',
    'absence_decide(bigint, boolean, text)', 'absence_delete_rejected(bigint)', 'absence_grid(date, date)', 'absence_pending_count()',
    'absence_rejected_to_manage()', 'absence_to_validate()', 'my_clinics()', 'my_set_clinics(text[])', 'admin_set_clinics(uuid, text[])',
    'admin_clinic_change_save(uuid, date, text[])', 'admin_clinic_change_delete(uuid, date)', 'admin_clinic_changes()']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
-- La fonction d'envoi des e-mails (service) lit les validateurs
grant execute on function public.absence_validator_ids(uuid), public.absence_validator_ids(uuid, date, date), public.absence_resend_pairs(uuid, bigint[]) to service_role;

-- ===== Tâche quotidienne (00h07 heure suisse en hiver) =====
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('cliniques-changements', '7 23 * * *', $job$ select public.apply_clinic_changes() $job$);
  end if;
end $$;
