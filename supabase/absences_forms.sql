-- Absences : formulaires papier du département générés en PDF, signés électroniquement (nom du validateur + horodatage),
-- envoyés par e-mail à la gestion des absences quand toutes les absences d'un envoi sont décidées.
-- À exécuter après absences_validation.sql. Sans danger si relancé.
--
-- Fonctionnement
--  * Un « envoi » = les absences d'un membre soumises ensemble (même submitted_at). Quand plus aucune absence de l'envoi
--    n'attend de décision et qu'au moins une est validée, une ligne « form » est déposée dans absence_outbox (destinataire
--    vide : l'adresse de la gestion des absences est le secret ABSENCE_FORMS_TO de la fonction notify-absence).
--  * Seuls les médecins assistants, chefs de clinique (cdc) et médecins cadres ont un formulaire (un par rôle).
--  * absence_form_data() et absence_form_access() ne sont appelables que par la fonction notify-absence (rôle service).
--  * Les absences déjà décidées avant cette mise en service ne déclenchent aucun envoi (form_queued_at renseigné).

-- ===== 1. Boîte d'envoi : type « form », sans destinataire interne =====
alter table public.absence_outbox drop constraint if exists absence_outbox_kind_check;
alter table public.absence_outbox add constraint absence_outbox_kind_check
  check (kind in ('to_validate', 'to_validate_change', 'approved', 'rejected', 'change_approved', 'change_rejected', 'form'));
alter table public.absence_outbox alter column recipient drop not null;
alter table public.absence_outbox drop constraint if exists absence_outbox_recipient_check;
alter table public.absence_outbox add constraint absence_outbox_recipient_check check (recipient is not null or kind = 'form');

alter table public.absences add column if not exists form_queued_at timestamptz;
update public.absences set form_queued_at = coalesce(decided_at, created_at)
  where form_queued_at is null and status in ('approved', 'rejected', 'cancelled');

-- Bucket privé pour le logo de l'en-tête (logo.png), hors dépôt public ; aucune policy : seule la fonction (rôle service) y accède
insert into storage.buckets (id, name, public) values ('absence-forms', 'absence-forms', false) on conflict (id) do nothing;

-- ===== 2. Mise en file du formulaire =====
create or replace function public.absence_form_after(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare a public.absences; ids bigint[];
begin
  select * into a from public.absences where id = p_id;
  if not found then return; end if;
  -- deux validateurs peuvent décider en même temps deux absences du même envoi : on sérialise par membre
  perform pg_advisory_xact_lock(hashtext('absence_form:' || a.user_id::text));
  if not exists (select 1 from public.profiles where id = a.user_id and role in ('clinician', 'cdc', 'cadre')) then return; end if;
  if exists (select 1 from public.absences x where x.user_id = a.user_id and x.submitted_at is not distinct from a.submitted_at and x.status = 'requested') then return; end if;
  select array_agg(x.id order by x.start_date, x.id) into ids from public.absences x
    where x.user_id = a.user_id and x.submitted_at is not distinct from a.submitted_at and x.status = 'approved' and x.form_queued_at is null;
  if ids is null then return; end if;
  update public.absences set form_queued_at = now() where id = any (ids);
  insert into public.absence_outbox (kind, recipient, absence_ids, payload) values ('form', null, ids, jsonb_build_object('owner_id', a.user_id));
end;
$$;

-- Les deux fonctions de décision finale existantes, avec un appel en plus (absence_form_after) dans le cas d'une nouvelle absence
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
  if k = 'approved' then perform public.absence_form_after(p_id); end if;
end;
$$;

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
  -- un refus peut être la dernière décision d'un envoi dont les autres absences sont déjà validées
  if k = 'rejected' then perform public.absence_form_after(p_id); end if;
end;
$$;

-- ===== 3. Données du formulaire (réservé à la fonction notify-absence) =====
create or replace function public.absence_form_data(p_ids bigint[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare owner uuid; r text;
begin
  select user_id into owner from public.absences where id = any (p_ids) limit 1;
  if owner is null then return null; end if;
  if exists (select 1 from public.absences where id = any (p_ids) and (user_id <> owner or status <> 'approved')) then return null; end if;
  select role into r from public.profiles where id = owner;
  if r not in ('clinician', 'cdc', 'cadre') then return jsonb_build_object('role', r, 'no_form', true); end if;
  return jsonb_build_object(
    'owner_id', owner, 'owner', public.member_name(owner), 'role', r, 'clinics', to_jsonb(public.member_clinics(owner)),
    'requested_at', (select min(coalesce(submitted_at, created_at)) from public.absences where id = any (p_ids)),
    'absences', (select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'start_date', start_date, 'end_date', end_date, 'note', note) order by start_date, id)
                 from public.absences where id = any (p_ids)),
    'signers', coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(s.validator_id), 'at', s.at, 'comment', s.comment) order by s.at)
                 from (select validator_id, max(decided_at) as at, nullif(string_agg(distinct nullif(trim(comment), ''), ' / '), '') as comment
                       from public.absence_approvals where absence_id = any (p_ids) and decision = 'approved' and decided_at is not null
                       group by validator_id) s), '[]'::jsonb));
end;
$$;

-- Qui peut télécharger le formulaire d'un envoi : l'intéressé, ses validateurs et les administrateurs
create or replace function public.absence_form_access(p_caller uuid, p_ids bigint[]) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare owner uuid;
begin
  select user_id into owner from public.absences where id = any (p_ids) limit 1;
  if owner is null or p_caller is null then return false; end if;
  return p_caller = owner
      or public.can_validate_absence(p_caller, owner)
      or exists (select 1 from public.profiles where id = p_caller and role = 'admin');
end;
$$;

revoke execute on function public.absence_form_after(bigint), public.absence_form_data(bigint[]), public.absence_form_access(uuid, bigint[]) from public, anon, authenticated;
grant execute on function public.absence_form_data(bigint[]), public.absence_form_access(uuid, bigint[]) to service_role;
