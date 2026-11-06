-- Absences : validation par TOUS les validateurs concernés, brouillons envoyés par lot après confirmation,
-- avancement visible (qui a validé, qui attend, qui a refusé), e-mails (boîte d'envoi), agenda personnel,
-- suppression des demandes refusées (par l'usager et les validateurs, effacées d'office après 14 jours).
-- À exécuter après absences.sql, cadre_medecin.sql, cadre_validateur.sql et congres_plus.sql (calendar_tokens). Sans danger si relancé.
--
-- Fonctionnement
--  * Une nouvelle absence est d'abord un BROUILLON (invisible des autres). absence_submit() envoie tous les brouillons du
--    membre d'un coup : statut « demandée », un tour de validation s'ouvre (une ligne par validateur concerné) et un seul
--    e-mail par validateur est mis en file (absence_outbox), envoyé par la fonction notify-absence.
--  * Validée quand tous les validateurs concernés ont validé ; un seul refus suffit à refuser (e-mail immédiat à l'usager).
--    Sans validateur désigné pour ses cliniques, ce sont les administrateurs qui décident (un seul suffit).
--    Un administrateur peut toujours trancher à lui seul.
--  * Une demande de modification ou de suppression d'une absence validée suit la même règle.

-- ===== 1. Tables =====
alter table public.absences drop constraint if exists absences_status_check;
alter table public.absences add constraint absences_status_check
  check (status in ('draft', 'requested', 'approved', 'rejected', 'cancelled'));
alter table public.absences add column if not exists submitted_at timestamptz;
update public.absences set submitted_at = created_at where submitted_at is null and status <> 'draft';

create table if not exists public.absence_approvals (
  absence_id bigint not null references public.absences (id) on delete cascade,
  validator_id uuid not null references auth.users (id) on delete cascade,
  decision text not null default 'pending' check (decision in ('pending', 'approved', 'rejected', 'skipped')),
  comment text check (char_length(comment) <= 500),
  decided_at timestamptz,
  primary key (absence_id, validator_id)
);
alter table public.absence_approvals enable row level security;
revoke all on public.absence_approvals from anon, authenticated;

-- Boîte d'envoi : les fonctions SQL y déposent les messages, la fonction notify-absence les envoie (e-mail et push)
create table if not exists public.absence_outbox (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('to_validate', 'to_validate_change', 'approved', 'rejected', 'change_approved', 'change_rejected')),
  recipient uuid not null references auth.users (id) on delete cascade,
  absence_ids bigint[] not null default '{}',
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  attempts int not null default 0,
  last_error text
);
create index if not exists absence_outbox_unsent on public.absence_outbox (id) where sent_at is null;
alter table public.absence_outbox enable row level security;
revoke all on public.absence_outbox from anon, authenticated;

-- ===== 2. Fonctions internes =====
-- Validateurs concernés : médecins cadres cochés, désignés pour une clinique du membre (jamais lui-même). Sans repli.
create or replace function public.absence_required_validators(p_user uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct av.user_id), '{}'::uuid[])
  from public.absence_validators av
  join public.profiles v on v.id = av.user_id and v.role = 'cadre' and v.absence_validator
  where av.clinic = any (public.member_clinics(p_user)) and av.user_id <> p_user and public.tool_allowed(av.user_id, 'absences');
$$;

-- Ouvre un tour de validation : une ligne « en attente » par validateur concerné
create or replace function public.absence_open_round(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  select user_id into owner from public.absences where id = p_id;
  delete from public.absence_approvals where absence_id = p_id;
  insert into public.absence_approvals (absence_id, validator_id)
    select p_id, v from unnest(public.absence_required_validators(owner)) v;
end;
$$;

create or replace function public.absence_enqueue(p_kind text, p_recipient uuid, p_ids bigint[], p_payload jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.absence_outbox (kind, recipient, absence_ids, payload) values (p_kind, p_recipient, p_ids, coalesce(p_payload, '{}'::jsonb));
$$;

-- Toutes les validations sont données : l'absence (ou son changement) est acceptée, l'usager est prévenu
create or replace function public.absence_finalize_approve(p_id bigint, p_by uuid, p_comment text) returns void
language plpgsql security definer set search_path = public as $$
declare a public.absences; k text := 'approved';
begin
  select * into a from public.absences where id = p_id for update;
  if a.change_type is null then
    update public.absences set status = 'approved', decision = 'approved', decision_comment = p_comment, decided_by = p_by, decided_at = now(),
      notified_decision_at = null where id = p_id;
  else
    k := 'change_approved';
    if a.change_type = 'delete' then
      update public.absences set status = 'cancelled', decision = 'change_approved' where id = p_id;
    else
      perform public.absence_check(a.user_id, p_id, a.change_kind, a.change_note, a.change_start, a.change_end);
      update public.absences set kind = change_kind, note = change_note, start_date = change_start, end_date = change_end,
        decision = 'change_approved' where id = p_id;
    end if;
    update public.absences set change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null,
      change_requested_at = null, decision_comment = p_comment, decided_by = p_by, decided_at = now(), notified_decision_at = null where id = p_id;
  end if;
  perform public.absence_enqueue(k, a.user_id, array[p_id], jsonb_build_object('by', case when p_by is null then null else public.member_name(p_by) end));
end;
$$;

-- Un validateur refuse : refus immédiat, les autres validations en attente tombent, l'usager est prévenu
create or replace function public.absence_finalize_reject(p_id bigint, p_by uuid, p_comment text) returns void
language plpgsql security definer set search_path = public as $$
declare a public.absences; k text := 'rejected';
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
end;
$$;

-- Plus aucune validation en attente (parmi les validateurs encore habilités) et au moins une donnée : l'absence est validée
create or replace function public.absence_try_complete(p_id bigint, p_by uuid, p_comment text) returns boolean
language plpgsql security definer set search_path = public as $$
declare a public.absences; pend int; appr int;
begin
  select * into a from public.absences where id = p_id for update;
  if not found or not (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null)) then return false; end if;
  select count(*) filter (where decision = 'pending' and public.can_validate_absence(validator_id, a.user_id)),
         count(*) filter (where decision = 'approved')
    into pend, appr from public.absence_approvals where absence_id = p_id;
  if pend = 0 and appr > 0 then
    perform public.absence_finalize_approve(p_id, p_by, p_comment);
    return true;
  end if;
  return false;
end;
$$;

-- Réévalue les demandes en cours (après un changement de désignation) : celles qui n'attendaient plus que des validateurs retirés aboutissent
create or replace function public.absence_recheck() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from public.absences where status = 'requested' or (status = 'approved' and change_type is not null) loop
    perform public.absence_try_complete(r.id, null, null);
  end loop;
end;
$$;

create or replace function public.absence_purge() returns void
language sql security definer set search_path = public as $$
  delete from public.absences where status = 'rejected' and decided_at < now() - interval '14 days';
$$;

revoke execute on function public.absence_required_validators(uuid), public.absence_open_round(bigint),
  public.absence_enqueue(text, uuid, bigint[], jsonb), public.absence_finalize_approve(bigint, uuid, text),
  public.absence_finalize_reject(bigint, uuid, text), public.absence_try_complete(bigint, uuid, text),
  public.absence_recheck(), public.absence_purge() from public, anon, authenticated;
grant execute on function public.absence_purge() to service_role;

-- Contrôle commun : le chevauchement compte aussi les brouillons de l'usager
create or replace function public.absence_check(p_user uuid, p_exclude bigint, p_kind text, p_note text, p_start date, p_end date)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if p_kind is null or p_kind not in ('vacances', 'congres', 'autre') then raise exception 'Motif inconnu.'; end if;
  if p_start is null or p_end is null then raise exception 'Indiquez les dates de début et de fin.'; end if;
  if p_end < p_start then raise exception 'La fin doit être le même jour ou après le début.'; end if;
  if p_end - p_start > 366 then raise exception 'Période trop longue (366 jours au plus).'; end if;
  if p_start < public.ch_today() - 366 or p_end > public.ch_today() + 1100 then raise exception 'Dates hors de la période autorisée.'; end if;
  if char_length(coalesce(p_note, '')) > 200 then raise exception 'Précision trop longue (200 caractères au plus).'; end if;
  if p_kind = 'autre' and char_length(coalesce(p_note, '')) < 2 then raise exception 'Pour le motif « autre », indiquez une précision.'; end if;
  if exists (select 1 from public.absences a where a.user_id = p_user and a.status in ('draft', 'requested', 'approved')
             and a.id is distinct from p_exclude and a.start_date <= p_end and a.end_date >= p_start) then
    raise exception 'Cette période chevauche une de vos absences déjà demandée, validée ou en brouillon.';
  end if;
end;
$$;
revoke execute on function public.absence_check(uuid, bigint, text, text, date, date) from public, anon, authenticated;

-- ===== 3. Fonctions pour les membres =====
-- Nouvelle absence : BROUILLON, envoyé plus tard par absence_submit()
create or replace function public.absence_request(p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); new_id bigint;
begin
  perform public.absence_guard();
  perform public.absence_purge();
  perform public.absence_check(uid, null, p_kind, n, p_start, p_end);
  insert into public.absences (user_id, kind, note, start_date, end_date, status) values (uid, p_kind, n, p_start, p_end, 'draft') returning id into new_id;
  return jsonb_build_object('id', new_id, 'conflicts', public.absence_conflicts_json(uid, p_start, p_end));
end;
$$;

-- Validateurs qui seront prévenus pour les demandes du membre connecté
create or replace function public.absence_my_validators() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); v uuid[]; fb boolean := false;
begin
  perform public.absence_guard();
  v := public.absence_required_validators(uid);
  if coalesce(array_length(v, 1), 0) = 0 then
    fb := true;
    v := coalesce((select array_agg(id) from public.profiles where role = 'admin' and id <> uid), '{}');
  end if;
  return jsonb_build_object('fallback', fb,
    'validators', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by public.member_name(x)) from unnest(v) x), '[]'::jsonb));
end;
$$;

-- Envoie d'un coup tous les brouillons du membre : un tour de validation par absence, un message par validateur
create or replace function public.absence_submit() returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); ids bigint[]; rec uuid[]; who jsonb; fb boolean;
begin
  perform public.absence_guard();
  perform public.absence_purge();
  select array_agg(id order by start_date) into ids from public.absences where user_id = uid and status = 'draft';
  if ids is null then raise exception 'Aucune demande en brouillon à envoyer.'; end if;
  update public.absences set status = 'requested', submitted_at = now(), notified_at = null, decision = null, decision_comment = null,
    decided_by = null, decided_at = null where id = any (ids);
  perform public.absence_open_round(i) from unnest(ids) i;
  who := public.absence_my_validators();
  fb := (who ->> 'fallback')::boolean;
  select coalesce(array_agg((x ->> 'id')::uuid), '{}') into rec from jsonb_array_elements(who -> 'validators') x;
  perform public.absence_enqueue('to_validate', r, ids, jsonb_build_object('owner', public.member_name(uid))) from unnest(rec) r;
  return jsonb_build_object('count', array_length(ids, 1), 'ids', to_jsonb(ids), 'fallback', fb, 'validators', who -> 'validators');
end;
$$;

-- Modifier un brouillon, une demande en cours ou une demande refusée : elle repasse en brouillon et doit être renvoyée
create or replace function public.absence_update(p_id bigint, p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); a public.absences;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id and user_id = uid for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if a.status = 'approved' then raise exception 'Une absence validée se modifie par une demande de modification.'; end if;
  if a.status = 'cancelled' then raise exception 'Cette absence a été annulée.'; end if;
  perform public.absence_check(uid, p_id, p_kind, n, p_start, p_end);
  update public.absences set kind = p_kind, note = n, start_date = p_start, end_date = p_end, status = 'draft',
    decision = null, decision_comment = null, decided_by = null, decided_at = null, notified_at = null, submitted_at = null
    where id = p_id;
  delete from public.absence_approvals where absence_id = p_id;
  return jsonb_build_object('id', p_id, 'conflicts', public.absence_conflicts_json(uid, p_start, p_end));
end;
$$;

-- Retirer : un brouillon ou une demande refusée disparaît ; une demande en cours est annulée
create or replace function public.absence_withdraw(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); s text;
begin
  perform public.absence_guard();
  select status into s from public.absences where id = p_id and user_id = uid for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if s = 'approved' then raise exception 'Une absence validée se supprime par une demande de suppression.'; end if;
  if s in ('draft', 'rejected') then
    delete from public.absences where id = p_id;
  else
    update public.absences set status = 'cancelled', change_type = null, change_kind = null, change_note = null, change_start = null,
      change_end = null, change_requested_at = null where id = p_id and status = 'requested';
    delete from public.absence_approvals where absence_id = p_id;
  end if;
end;
$$;

-- Supprimer une demande refusée : l'usager ou l'un de ses validateurs
create or replace function public.absence_delete_rejected(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); a public.absences;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id for update;
  if not found or a.status <> 'rejected' then raise exception 'Demande refusée introuvable.'; end if;
  if a.user_id <> uid and not public.can_validate_absence(uid, a.user_id) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  delete from public.absences where id = p_id;
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
  rec := public.absence_validator_ids(uid);
  perform public.absence_enqueue('to_validate_change', r, array[p_id], jsonb_build_object('owner', public.member_name(uid))) from unnest(rec) r;
  return res;
end;
$$;

create or replace function public.absence_cancel_change(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.absence_guard();
  update public.absences set change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null,
    change_requested_at = null where id = p_id and user_id = auth.uid() and status = 'approved' and change_type is not null;
  if not found then raise exception 'Aucune demande en cours.'; end if;
  delete from public.absence_approvals where absence_id = p_id;
end;
$$;

-- Liste du membre (ou d'un membre que l'on valide) ; les demandes refusées depuis plus de 14 jours n'apparaissent plus
create or replace function public.absence_list(p_user uuid default null) returns setof public.absences
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid and not public.can_validate_absence(uid, p_user) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  return query select * from public.absences a where a.user_id = coalesce(p_user, uid)
    and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
    and (a.status <> 'draft' or a.user_id = uid)
    order by a.start_date desc;
end;
$$;

-- Avancement de la validation des absences d'un membre : qui a validé, qui attend, qui a refusé
create or replace function public.absence_approvals_all(p_user uuid default null)
returns table (absence_id bigint, validator_name text, decision text, comment text, decided_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid and not public.can_validate_absence(uid, p_user) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  return query
    select p.absence_id, public.member_name(p.validator_id), p.decision, p.comment, p.decided_at
    from public.absence_approvals p join public.absences a on a.id = p.absence_id
    where a.user_id = coalesce(p_user, uid) and (a.status in ('requested', 'rejected') or (a.status = 'approved' and a.change_type is not null))
    order by p.absence_id, public.member_name(p.validator_id);
end;
$$;

-- À traiter : demandes en cours que le valideur n'a pas encore validées (l'admin voit toutes les demandes en cours)
drop function if exists public.absence_to_validate();
create or replace function public.absence_to_validate()
returns table (id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text,
               change_type text, change_kind text, change_note text, change_start date, change_end date,
               created_at timestamptz, change_requested_at timestamptz, conflicts jsonb, my_decision text, progress jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), public.member_clinics(a.user_id), a.kind, a.note, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, a.change_note, a.change_start, a.change_end, coalesce(a.submitted_at, a.created_at), a.change_requested_at,
           case when a.change_type = 'delete' then '[]'::jsonb
                when a.change_type = 'modify' then public.absence_conflicts_json(a.user_id, a.change_start, a.change_end)
                else public.absence_conflicts_json(a.user_id, a.start_date, a.end_date) end,
           coalesce((select p.decision from public.absence_approvals p where p.absence_id = a.id and p.validator_id = auth.uid()), 'pending'),
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(p.validator_id), 'decision', p.decision, 'comment', p.comment, 'at', p.decided_at)
                     order by public.member_name(p.validator_id)) from public.absence_approvals p where p.absence_id = a.id), '[]'::jsonb)
    from public.absences a
    where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
      and public.can_validate_absence(auth.uid(), a.user_id)
      and (public.current_role_name() = 'admin'
           or not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.validator_id = auth.uid() and p.decision = 'approved'))
    order by coalesce(a.change_requested_at, a.submitted_at, a.created_at);
end;
$$;

create or replace function public.absence_pending_count() returns int language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null or not public.tool_allowed(auth.uid(), 'absences') then 0
    else (select count(*)::int from public.absences a
          where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
            and public.can_validate_absence(auth.uid(), a.user_id)
            and (public.current_role_name() = 'admin'
                 or not exists (select 1 from public.absence_approvals p where p.absence_id = a.id and p.validator_id = auth.uid() and p.decision = 'approved'))) end;
$$;

-- Demandes refusées que le valideur peut supprimer (elles disparaissent d'office 14 jours après le refus)
create or replace function public.absence_rejected_to_manage()
returns table (id bigint, user_id uuid, name text, kind text, start_date date, end_date date, decision_comment text, decided_at timestamptz, decided_by_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), a.kind, a.start_date, a.end_date, a.decision_comment, a.decided_at,
           case when a.decided_by is null then null else public.member_name(a.decided_by) end
    from public.absences a
    where a.status = 'rejected' and a.decided_at >= now() - interval '14 days' and public.can_validate_absence(auth.uid(), a.user_id)
    order by a.decided_at desc;
end;
$$;

-- Décision d'un valideur : validation (toutes requises, sauf l'admin qui tranche seul) ou refus (un seul suffit, commentaire obligatoire)
create or replace function public.absence_decide(p_id bigint, p_approve boolean, p_comment text) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); a public.absences; c text := nullif(trim(coalesce(p_comment, '')), ''); is_admin boolean; d text;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if not public.can_validate_absence(uid, a.user_id) then raise exception 'Vous ne validez pas les absences de ce membre.' using errcode = '42501'; end if;
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

-- Un changement de désignation peut débloquer des demandes qui n'attendaient plus que des validateurs retirés
create or replace function public.admin_set_absence_validators(p_clinic text, p_users uuid[]) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare bad uuid;
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  if not exists (select 1 from public.absence_clinic_settings where clinic = p_clinic) then raise exception 'Clinique inconnue : %', p_clinic; end if;
  select u into bad from unnest(coalesce(p_users, '{}')) u
    where not exists (select 1 from public.profiles p where p.id = u and p.role = 'cadre' and p.absence_validator) limit 1;
  if bad is not null then raise exception 'Seuls les médecins cadres cochés « validateur des absences » peuvent valider des absences.'; end if;
  delete from public.absence_validators where clinic = p_clinic;
  insert into public.absence_validators (clinic, user_id) select p_clinic, u from (select distinct u from unnest(coalesce(p_users, '{}')) u) x;
  perform public.absence_recheck();
  return array(select user_id from public.absence_validators where clinic = p_clinic);
end;
$$;

create or replace function public.admin_set_absence_validator(p_user uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r <> 'cadre' then raise exception 'Réservé aux médecins cadres.'; end if;
  update public.profiles set absence_validator = coalesce(p_on, false) where id = p_user;
  if not coalesce(p_on, false) then delete from public.absence_validators where user_id = p_user; end if;
  perform public.absence_recheck();
  return coalesce(p_on, false);
end;
$$;

-- ===== 4. Agenda personnel (flux iCal « Mes absences ») : même jeton que « Mes congrès » =====
create or replace function public.absence_calendar_feed(p_token text)
returns table (id bigint, kind text, note text, status text, start_date date, end_date date, change_type text, updated_at timestamptz, user_key text)
language sql stable security definer set search_path = public as $$
  select a.id, a.kind, a.note, a.status, a.start_date, a.end_date, a.change_type,
         coalesce(a.decided_at, a.submitted_at, a.created_at), t.user_id::text
  from public.calendar_tokens t
  join public.absences a on a.user_id = t.user_id
  where t.token = p_token and public.tool_allowed(t.user_id, 'absences') and a.status in ('requested', 'approved')
  order by a.start_date;
$$;
revoke execute on function public.absence_calendar_feed(text) from public, anon, authenticated;
grant execute on function public.absence_calendar_feed(text) to service_role;

-- ===== 5. Boîte d'envoi (réservée au service : fonction notify-absence) =====
create or replace function public.absence_outbox_claim(p_limit int default 30) returns setof public.absence_outbox
language sql security definer set search_path = public as $$
  update public.absence_outbox o set claimed_at = now(), attempts = o.attempts + 1
  where o.id in (select id from public.absence_outbox where sent_at is null and attempts < 5
                 and (claimed_at is null or claimed_at < now() - interval '3 minutes') order by id limit greatest(1, least(p_limit, 100)) for update skip locked)
  returning o.*;
$$;
create or replace function public.absence_outbox_done(p_id bigint, p_error text default null) returns void
language sql security definer set search_path = public as $$
  update public.absence_outbox set sent_at = case when p_error is null then now() else null end, last_error = left(p_error, 300), claimed_at = null where id = p_id;
$$;
revoke execute on function public.absence_outbox_claim(int), public.absence_outbox_done(bigint, text) from public, anon, authenticated;
grant execute on function public.absence_outbox_claim(int), public.absence_outbox_done(bigint, text) to service_role;

-- ===== 6. Droits d'exécution =====
do $$
declare f text;
begin
  foreach f in array array[
    'absence_request(text, text, date, date)', 'absence_my_validators()', 'absence_submit()', 'absence_update(bigint, text, text, date, date)',
    'absence_withdraw(bigint)', 'absence_delete_rejected(bigint)', 'absence_request_change(bigint, text, text, text, date, date)',
    'absence_cancel_change(bigint)', 'absence_list(uuid)', 'absence_approvals_all(uuid)', 'absence_to_validate()', 'absence_pending_count()',
    'absence_rejected_to_manage()', 'absence_decide(bigint, boolean, text)', 'admin_set_absence_validators(text, uuid[])',
    'admin_set_absence_validator(uuid, boolean)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ===== 7. Reprise des demandes déjà en cours avant cette migration =====
-- Un tour de validation s'ouvre pour celles qui n'ont encore aucune ligne de validation (sans effet si aucun validateur n'est désigné :
-- l'administrateur décide, comme avant). Aucun e-mail n'est envoyé pour ces demandes.
select public.absence_open_round(a.id) from public.absences a
where (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null))
  and not exists (select 1 from public.absence_approvals p where p.absence_id = a.id);
