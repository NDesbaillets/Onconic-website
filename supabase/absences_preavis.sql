-- Absences : pré-avis non bloquant de la direction (admins de direction), visible des validateurs comme aide à la décision.
-- À l'envoi d'une demande (nouvelle absence ou demande de changement), un e-mail « pré-avis possible » part aux membres « direction »
-- en parallèle des validateurs de clinique (sauf à ceux qui reçoivent déjà le message de validation). Ils donnent un pré-avis favorable
-- ou défavorable, avec commentaire (obligatoire si défavorable), tant que la demande est en cours. Le pré-avis ne bloque rien : il
-- apparaît sur la carte « À valider » des validateurs et du visa de la direction. Il est effacé quand une nouvelle ronde de validation
-- s'ouvre (demande modifiée ou renvoyée). Sans membre « direction », aucun e-mail de pré-avis (les admins ne sont pas sollicités).
-- À exécuter après admin_direction.sql, absences_visibilite.sql. Sans danger si relancé.

-- ===== 1. Table (accès par les seules fonctions ci-dessous) =====
create table if not exists public.absence_opinions (
  absence_id bigint not null references public.absences (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  opinion text not null check (opinion in ('favorable', 'defavorable')),
  comment text check (char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (absence_id, user_id)
);
alter table public.absence_opinions enable row level security;
revoke all on public.absence_opinions from anon, authenticated;

alter table public.absence_outbox drop constraint if exists absence_outbox_kind_check;
alter table public.absence_outbox add constraint absence_outbox_kind_check
  check (kind in ('to_validate', 'to_validate_change', 'approved', 'rejected', 'change_approved', 'change_rejected', 'form', 'to_direction', 'direction_change', 'to_opinion'));

-- ===== 2. Destinataires, ronde de validation, envoi =====
create or replace function public.absence_opinion_recipients(p_owner uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array(select p.id from public.profiles p
                        where p.role = 'direction' and p.id is distinct from p_owner and public.tool_allowed(p.id, 'absences')), '{}');
$$;
revoke execute on function public.absence_opinion_recipients(uuid) from public, anon, authenticated;

create or replace function public.absence_open_round(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a public.absences;
begin
  select * into a from public.absences where id = p_id;
  if not found then return; end if;
  delete from public.absence_approvals where absence_id = p_id;
  delete from public.absence_opinions where absence_id = p_id;
  insert into public.absence_approvals (absence_id, validator_id)
    select p_id, v from unnest(public.absence_required_validators(a.user_id, public.absence_lo(a), public.absence_hi(a))) v;
  update public.absences set stage = case when exists (select 1 from public.absence_approvals where absence_id = p_id) then 1 else 2 end where id = p_id;
end;
$$;

create or replace function public.absence_submit() returns jsonb
language plpgsql security definer set search_path = public as $$
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
  op := array(select x from unnest(public.absence_opinion_recipients(uid)) x where not (x = any (rec)));
  perform public.absence_enqueue('to_opinion', r, ids, jsonb_build_object('owner', public.member_name(uid))) from unnest(op) r;
  return jsonb_build_object('count', array_length(ids, 1), 'ids', to_jsonb(ids), 'fallback', fb, 'validators', who -> 'validators');
end;
$$;

create or replace function public.absence_request_change(p_id bigint, p_type text, p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public as $$
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
  rec := public.absence_validator_ids(uid, public.absence_lo(a), public.absence_hi(a));
  perform public.absence_enqueue('to_validate_change', r, array[p_id], jsonb_build_object('owner', public.member_name(uid))) from unnest(rec) r;
  op := array(select x from unnest(public.absence_opinion_recipients(uid)) x where not (x = any (rec)));
  perform public.absence_enqueue('to_opinion', r, array[p_id], jsonb_build_object('owner', public.member_name(uid))) from unnest(op) r;
  return res;
end;
$$;

-- ===== 3. Donner et lire les pré-avis =====
create or replace function public.absence_opinion_set(p_id bigint, p_opinion text, p_comment text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); a public.absences; c text := nullif(trim(coalesce(p_comment, '')), '');
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  select * into a from public.absences where id = p_id;
  if not found then raise exception 'Absence introuvable.'; end if;
  if a.user_id = uid then raise exception 'Pas de pré-avis sur vos propres absences.' using errcode = '42501'; end if;
  if not (a.status = 'requested' or (a.status = 'approved' and a.change_type is not null)) then raise exception 'Cette absence n''attend aucune décision.'; end if;
  if p_opinion is null then
    delete from public.absence_opinions where absence_id = p_id and user_id = uid;
    return;
  end if;
  if p_opinion not in ('favorable', 'defavorable') then raise exception 'Pré-avis inconnu.'; end if;
  if p_opinion = 'defavorable' and char_length(coalesce(c, '')) < 3 then raise exception 'Un pré-avis défavorable demande un commentaire.'; end if;
  if char_length(coalesce(c, '')) > 500 then raise exception 'Commentaire trop long (500 caractères au plus).'; end if;
  insert into public.absence_opinions (absence_id, user_id, opinion, comment) values (p_id, uid, p_opinion, c)
    on conflict (absence_id, user_id) do update set opinion = excluded.opinion, comment = excluded.comment, updated_at = now();
end;
$$;

-- Demandes en cours chez les validateurs de clinique (1re ligne), pour que la direction donne son pré-avis
drop function if exists public.absence_opinion_todo();
create or replace function public.absence_opinion_todo()
returns table (id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text,
  change_type text, change_kind text, change_note text, change_start date, change_end date, created_at timestamptz,
  conflicts jsonb, progress jsonb, my_opinion text, my_comment text, opinions jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then return; end if;
  return query
    select a.id, a.user_id, public.member_name(a.user_id), public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, a.note, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, a.change_note, a.change_start, a.change_end, coalesce(a.change_requested_at, a.submitted_at, a.created_at),
           case when a.change_type = 'delete' then '[]'::jsonb
                when a.change_type = 'modify' then public.absence_conflicts_json(a.user_id, a.change_start, a.change_end)
                else public.absence_conflicts_json(a.user_id, a.start_date, a.end_date) end,
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(p.validator_id), 'decision', p.decision, 'comment', p.comment, 'at', p.decided_at)
                     order by public.member_name(p.validator_id)) from public.absence_approvals p where p.absence_id = a.id), '[]'::jsonb),
           (select o.opinion from public.absence_opinions o where o.absence_id = a.id and o.user_id = auth.uid()),
           (select o.comment from public.absence_opinions o where o.absence_id = a.id and o.user_id = auth.uid()),
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(o.user_id), 'opinion', o.opinion, 'comment', o.comment, 'at', o.updated_at)
                     order by o.updated_at) from public.absence_opinions o where o.absence_id = a.id and o.user_id <> auth.uid()), '[]'::jsonb)
    from public.absences a
    where a.stage = 1 and a.user_id <> auth.uid()
      and a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
    order by coalesce(a.change_requested_at, a.submitted_at, a.created_at);
end;
$$;

-- « À valider » : ajoute les pré-avis de la direction à chaque demande
drop function if exists public.absence_to_validate();
create or replace function public.absence_to_validate()
returns table (id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text,
  change_type text, change_kind text, change_note text, change_start date, change_end date, created_at timestamptz,
  change_requested_at timestamptz, conflicts jsonb, my_decision text, progress jsonb, stage int, opinions jsonb)
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
                     order by public.member_name(p.validator_id)) from public.absence_approvals p where p.absence_id = a.id), '[]'::jsonb),
           a.stage::int,
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(o.user_id), 'opinion', o.opinion, 'comment', o.comment, 'at', o.updated_at)
                     order by o.updated_at) from public.absence_opinions o where o.absence_id = a.id), '[]'::jsonb)
    from public.absences a
    where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
      and public.absence_actionable(auth.uid(), a)
    order by coalesce(a.change_requested_at, a.submitted_at, a.created_at);
end;
$$;

revoke execute on function public.absence_opinion_set(bigint, text, text), public.absence_opinion_todo(), public.absence_to_validate() from public, anon;
grant execute on function public.absence_opinion_set(bigint, text, text), public.absence_opinion_todo(), public.absence_to_validate() to authenticated;
