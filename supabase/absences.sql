-- Absences : demandes d'absence (vacances, congrès, autre), validation par des cadres désignés par clinique,
-- planning mensuel commun, avertissement de chevauchement, demandes de modification / suppression.
-- À exécuter après schema.sql, admin.sql, trials_roles.sql et formation.sql. Sans danger si relancé.
--
-- Principes
--  * Nouveau rôle « cadre » : valide les absences des cliniques pour lesquelles l'admin l'a désigné.
--    Le rôle « cdc » désigne désormais le chef de clinique (médecin) ; son rôle sur Key trials ne change pas.
--  * Seuls les médecins (clinician, cdc) sont rattachés à une ou plusieurs cliniques (profiles.clinics).
--    Les autres rôles (cadre, assistant, pharmacist, admin) relèvent de la « clinique » Administration.
--  * Aucune lecture ou écriture directe des tables : tout passe par des fonctions qui contrôlent les droits.

-- ===== 1. Rôle « cadre » et cliniques de rattachement =====
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('member', 'clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'admin'));
alter table public.profiles add column if not exists clinics text[] not null default '{}';
-- Reprise des cliniques déjà attribuées aux CDC pour Key trials (une seule fois : seulement si clinics est vide)
update public.profiles set clinics = cdc_clinics where role = 'cdc' and clinics = '{}' and cdc_clinics <> '{}';

-- Cliniques de l'outil Absences (la dernière, Administration, regroupe les non-médecins) et seuil d'avertissement
create table if not exists public.absence_clinic_settings (
  clinic text primary key,
  pos int not null,
  max_absent int not null default 2 check (max_absent between 1 and 50)
);
insert into public.absence_clinic_settings (clinic, pos) values
  ('Sénologie', 1), ('Gynécologie', 2), ('Urologie', 3), ('Thoracique', 4), ('Neuro-oncologie', 5), ('Mélanome', 6),
  ('Lower GI', 7), ('Upper GI', 8), ('ORL', 9), ('Sarcomes', 10), ('Radiologie interventionnelle', 11), ('Administration', 12)
on conflict (clinic) do nothing;

-- Cadres qui valident les absences d'une clinique (désignés par l'admin)
create table if not exists public.absence_validators (
  clinic text not null references public.absence_clinic_settings (clinic) on update cascade on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (clinic, user_id)
);
create index if not exists absence_validators_user on public.absence_validators (user_id);

create table if not exists public.absences (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('vacances', 'congres', 'autre')),
  note text check (char_length(note) <= 200),
  start_date date not null,
  end_date date not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  -- demande de modification ou de suppression d'une absence validée (l'absence reste validée jusqu'à la décision)
  change_type text check (change_type in ('modify', 'delete')),
  change_kind text check (change_kind in ('vacances', 'congres', 'autre')),
  change_note text check (char_length(change_note) <= 200),
  change_start date,
  change_end date,
  change_requested_at timestamptz,
  -- dernière décision d'un valideur
  decision text check (decision in ('approved', 'rejected', 'change_approved', 'change_rejected')),
  decision_comment text check (char_length(decision_comment) <= 500),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  -- garde-fous des notifications (une rafale ne peut pas être déclenchée en boucle)
  notified_at timestamptz,
  notified_decision_at timestamptz,
  created_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (end_date - start_date <= 366),
  check ((change_type is null) = (change_requested_at is null)),
  check (change_type is distinct from 'modify'
         or (change_kind is not null and change_start is not null and change_end is not null and change_end >= change_start))
);
create index if not exists absences_user on public.absences (user_id);
create index if not exists absences_active_dates on public.absences (start_date, end_date) where status in ('requested', 'approved');

alter table public.absence_clinic_settings enable row level security;
alter table public.absence_validators enable row level security;
alter table public.absences enable row level security;
revoke all on public.absence_clinic_settings, public.absence_validators, public.absences from anon, authenticated;

-- ===== 2. Accès à l'outil, droits par défaut =====
alter table public.tool_access drop constraint if exists tool_access_tool_check;
alter table public.tool_access add constraint tool_access_tool_check
  check (tool in ('congres', 'trials', 'lettres', 'limitations', 'duree', 'absences'));

create or replace function public.tool_allowed(p_user uuid, p_tool text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare r text; i text; m boolean; o boolean;
begin
  select role, institution, med_plus into r, i, m from public.profiles where id = p_user;
  if r is null or r = 'member' then return false; end if;
  if r = 'admin' then return true; end if;
  if p_tool = 'medletters' then return r in ('clinician', 'cdc', 'pharmacist') and coalesce(m, false); end if;
  select allowed into o from public.tool_access where user_id = p_user and tool = p_tool;
  if found then return o; end if;
  i := coalesce(i, '');
  return case p_tool
    when 'absences' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist')
    when 'congres' then r in ('clinician', 'cdc', 'assistant', 'pharmacist')
    when 'trials' then r in ('clinician', 'cdc', 'assistant', 'pharmacist')
    when 'formation' then r in ('clinician', 'cdc', 'assistant', 'pharmacist')
    when 'annuaire' then r in ('clinician', 'cdc', 'assistant', 'pharmacist') and i = 'CHUV'
    when 'contacts' then r in ('clinician', 'cdc', 'assistant', 'pharmacist') and i = 'CHUV'
    when 'lettres' then r = 'pharmacist' or (r in ('clinician', 'cdc', 'assistant') and i = 'CHUV')
    when 'limitations' then r in ('clinician', 'cdc', 'pharmacist')
    when 'duree' then r = 'pharmacist' or (r in ('assistant', 'clinician', 'cdc') and i = 'CHUV')
    else false end;
end;
$$;

create or replace function public.my_tools()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(t), '{}') from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'medletters', 'annuaire', 'contacts', 'formation', 'absences']) t
  where public.tool_allowed(auth.uid(), t);
$$;

-- ===== 3. Fonctions internes =====
create or replace function public.ch_today() returns date language sql stable set search_path = public as $$
  select (now() at time zone 'Europe/Zurich')::date;
$$;

create or replace function public.member_name(p_user uuid) returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), p.full_name, '(sans nom)') from public.profiles p where p.id = p_user;
$$;

-- Cliniques d'un membre : celles de ses fiches pour les médecins, Administration pour les autres rôles
create or replace function public.member_clinics(p_user uuid) returns text[] language sql stable security definer set search_path = public as $$
  select coalesce((select case when p.role in ('clinician', 'cdc') then p.clinics
                               when p.role in ('cadre', 'assistant', 'pharmacist', 'admin') then array['Administration']
                               else '{}'::text[] end
                   from public.profiles p where p.id = p_user), '{}'::text[]);
$$;

create or replace function public.absence_guard() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.tool_allowed(auth.uid(), 'absences') then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
end;
$$;

-- Le valideur peut-il décider des absences de ce membre ? Admin : toujours. Cadre : s'il est désigné pour l'une de ses
-- cliniques, jamais pour lui-même.
create or replace function public.can_validate_absence(p_validator uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles v where v.id = p_validator and v.role = 'admin')
      or (p_validator <> p_user
          and public.tool_allowed(p_validator, 'absences')
          and exists (select 1 from public.absence_validators av join public.profiles v on v.id = av.user_id and v.role = 'cadre'
                      where av.user_id = p_validator and av.clinic = any (public.member_clinics(p_user))));
$$;

-- Destinataires d'une demande : cadres désignés pour les cliniques du demandeur ; à défaut, les admins
create or replace function public.absence_validator_ids(p_user uuid) returns uuid[] language sql stable security definer set search_path = public as $$
  with cadres as (
    select distinct av.user_id from public.absence_validators av join public.profiles v on v.id = av.user_id and v.role = 'cadre'
    where av.clinic = any (public.member_clinics(p_user)) and av.user_id <> p_user and public.tool_allowed(av.user_id, 'absences')
  )
  select coalesce(
    nullif((select array_agg(user_id) from cadres), '{}'),
    (select array_agg(id) from public.profiles where role = 'admin' and id <> p_user),
    '{}');
$$;
revoke execute on function public.ch_today(), public.member_name(uuid), public.member_clinics(uuid), public.absence_guard(),
  public.can_validate_absence(uuid, uuid), public.absence_validator_ids(uuid) from public, anon, authenticated;

-- Chevauchements : pour chaque clinique du membre, jours où le nombre d'absents (demandes comprises), lui inclus,
-- dépasse le seuil de la clinique
create or replace function public.absence_conflicts(p_user uuid, p_start date, p_end date)
returns table (clinic text, max_absent int, peak int, first_day date, last_day date, others text[])
language sql stable security definer set search_path = public as $$
  with days as (select d::date as d from generate_series(p_start, p_end, interval '1 day') d),
  mine as (select unnest(public.member_clinics(p_user)) as clinic),
  occ as (
    select m.clinic, days.d, a.user_id
    from mine m cross join days
    join public.absences a on a.status in ('requested', 'approved') and a.user_id <> p_user and days.d between a.start_date and a.end_date
    where m.clinic = any (public.member_clinics(a.user_id))
  ),
  per_day as (select clinic, d, count(distinct user_id)::int as n from occ group by clinic, d),
  over_days as (
    select pd.clinic, pd.d, pd.n, s.max_absent
    from per_day pd join public.absence_clinic_settings s on s.clinic = pd.clinic where pd.n + 1 > s.max_absent
  )
  select od.clinic, od.max_absent, max(od.n) + 1, min(od.d), max(od.d),
    (select array_agg(distinct public.member_name(o.user_id)) from occ o
       where o.clinic = od.clinic and o.d in (select x.d from over_days x where x.clinic = od.clinic))
  from over_days od group by od.clinic, od.max_absent;
$$;
revoke execute on function public.absence_conflicts(uuid, date, date) from public, anon, authenticated;

create or replace function public.absence_conflicts_json(p_user uuid, p_start date, p_end date) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.first_day), '[]'::jsonb) from public.absence_conflicts(p_user, p_start, p_end) c;
$$;
revoke execute on function public.absence_conflicts_json(uuid, date, date) from public, anon, authenticated;

-- Contrôle commun des saisies
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
  if exists (select 1 from public.absences a where a.user_id = p_user and a.status in ('requested', 'approved')
             and a.id is distinct from p_exclude and a.start_date <= p_end and a.end_date >= p_start) then
    raise exception 'Cette période chevauche une de vos absences déjà demandée ou validée.';
  end if;
end;
$$;
revoke execute on function public.absence_check(uuid, bigint, text, text, date, date) from public, anon, authenticated;

-- ===== 4. Fonctions pour les membres =====
-- Contexte de l'utilisateur : rôle, cliniques, cliniques dont il valide les absences, nombre de demandes en attente
create or replace function public.absence_context() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); r text; v text[];
begin
  perform public.absence_guard();
  select role into r from public.profiles where id = uid;
  v := case when r = 'admin' then array(select clinic from public.absence_clinic_settings order by pos)
            else array(select av.clinic from public.absence_validators av join public.absence_clinic_settings s using (clinic) where av.user_id = uid and r = 'cadre' order by s.pos) end;
  return jsonb_build_object('me', uid, 'role', r, 'clinics', public.member_clinics(uid), 'validates', to_jsonb(v), 'pending', public.absence_pending_count());
end;
$$;

create or replace function public.absence_pending_count() returns int language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null or not public.tool_allowed(auth.uid(), 'absences') then 0
    else (select count(*)::int from public.absences a
          where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
            and public.can_validate_absence(auth.uid(), a.user_id)) end;
$$;

create or replace function public.absence_clinics() returns table (clinic text, max_absent int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  return query select s.clinic, s.max_absent from public.absence_clinic_settings s order by s.pos;
end;
$$;

-- Collaborateurs affichables dans le planning : tous les membres qui ont l'outil
create or replace function public.absence_people() returns table (id uuid, name text, role text, clinics text[], is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  return query
    select p.id, public.member_name(p.id), p.role, public.member_clinics(p.id), p.id = auth.uid()
    from public.profiles p where p.role <> 'member' and public.tool_allowed(p.id, 'absences')
    order by lower(public.member_name(p.id));
end;
$$;

-- Planning : demandes et absences validées qui touchent la période. Le motif (kind) est visible de tous ;
-- la précision (note) seulement de l'intéressé et de ses valideurs.
create or replace function public.absence_grid(p_from date, p_to date)
returns table (id bigint, user_id uuid, kind text, status text, start_date date, end_date date, note text,
               change_type text, change_start date, change_end date)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Période invalide.'; end if;
  return query
    select a.id, a.user_id, a.kind, a.status, a.start_date, a.end_date,
           case when a.user_id = auth.uid() or public.can_validate_absence(auth.uid(), a.user_id) then a.note end,
           a.change_type, a.change_start, a.change_end
    from public.absences a
    where a.status in ('requested', 'approved') and a.start_date <= p_to and a.end_date >= p_from
    order by a.start_date;
end;
$$;

-- Absences d'un membre (les siennes, ou celles d'un membre dont on est valideur)
create or replace function public.absence_list(p_user uuid default null) returns setof public.absences
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid and not public.can_validate_absence(uid, p_user) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  return query select * from public.absences a where a.user_id = coalesce(p_user, uid) order by a.start_date desc;
end;
$$;

create or replace function public.absence_request(p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); new_id bigint;
begin
  perform public.absence_guard();
  perform public.absence_check(uid, null, p_kind, n, p_start, p_end);
  insert into public.absences (user_id, kind, note, start_date, end_date) values (uid, p_kind, n, p_start, p_end) returning id into new_id;
  return jsonb_build_object('id', new_id, 'conflicts', public.absence_conflicts_json(uid, p_start, p_end));
end;
$$;

-- Modifier une demande encore en attente (ou refusée : elle repart alors en validation)
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
  update public.absences set kind = p_kind, note = n, start_date = p_start, end_date = p_end, status = 'requested',
    decision = null, decision_comment = null, decided_by = null, decided_at = null, notified_at = null,
    created_at = case when a.status = 'rejected' then now() else a.created_at end
    where id = p_id;
  return jsonb_build_object('id', p_id, 'conflicts', public.absence_conflicts_json(uid, p_start, p_end));
end;
$$;

-- Retirer une demande en attente ou refusée
create or replace function public.absence_withdraw(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); s text;
begin
  perform public.absence_guard();
  select status into s from public.absences where id = p_id and user_id = uid for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if s = 'approved' then raise exception 'Une absence validée se supprime par une demande de suppression.'; end if;
  update public.absences set status = 'cancelled', change_type = null, change_kind = null, change_note = null, change_start = null,
    change_end = null, change_requested_at = null where id = p_id and status in ('requested', 'rejected');
end;
$$;

-- Demande de modification ou de suppression d'une absence validée : elle reste validée jusqu'à la décision
create or replace function public.absence_request_change(p_id bigint, p_type text, p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); a public.absences;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id and user_id = uid for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if a.status <> 'approved' then raise exception 'Seule une absence validée appelle une demande de modification.'; end if;
  if a.change_type is not null then raise exception 'Une demande est déjà en cours pour cette absence.'; end if;
  if p_type = 'delete' then
    update public.absences set change_type = 'delete', change_requested_at = now(), notified_at = null where id = p_id;
    return jsonb_build_object('id', p_id, 'conflicts', '[]'::jsonb);
  elsif p_type = 'modify' then
    perform public.absence_check(uid, p_id, p_kind, n, p_start, p_end);
    update public.absences set change_type = 'modify', change_kind = p_kind, change_note = n, change_start = p_start, change_end = p_end,
      change_requested_at = now(), notified_at = null where id = p_id;
    return jsonb_build_object('id', p_id, 'conflicts', public.absence_conflicts_json(uid, p_start, p_end));
  end if;
  raise exception 'Type de demande inconnu.';
end;
$$;

create or replace function public.absence_cancel_change(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.absence_guard();
  update public.absences set change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null,
    change_requested_at = null where id = p_id and user_id = auth.uid() and status = 'approved';
  if not found then raise exception 'Aucune demande en cours.'; end if;
end;
$$;

-- Demandes à traiter (nouvelles absences et demandes de changement) pour les membres que l'on valide
create or replace function public.absence_to_validate()
returns table (id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text,
               change_type text, change_kind text, change_note text, change_start date, change_end date,
               created_at timestamptz, change_requested_at timestamptz, conflicts jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), public.member_clinics(a.user_id), a.kind, a.note, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, a.change_note, a.change_start, a.change_end, a.created_at, a.change_requested_at,
           case when a.change_type = 'delete' then '[]'::jsonb
                when a.change_type = 'modify' then public.absence_conflicts_json(a.user_id, a.change_start, a.change_end)
                else public.absence_conflicts_json(a.user_id, a.start_date, a.end_date) end
    from public.absences a
    where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
      and public.can_validate_absence(auth.uid(), a.user_id)
    order by coalesce(a.change_requested_at, a.created_at);
end;
$$;

create or replace function public.absence_decide(p_id bigint, p_approve boolean, p_comment text) returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); a public.absences; c text := nullif(trim(coalesce(p_comment, '')), '');
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if not public.can_validate_absence(uid, a.user_id) then raise exception 'Vous ne validez pas les absences de ce membre.' using errcode = '42501'; end if;
  if not coalesce(p_approve, false) and char_length(coalesce(c, '')) < 3 then raise exception 'Un refus demande un commentaire.'; end if;
  if char_length(coalesce(c, '')) > 500 then raise exception 'Commentaire trop long (500 caractères au plus).'; end if;

  if a.change_type is not null and a.status = 'approved' then
    if p_approve and a.change_type = 'delete' then
      update public.absences set status = 'cancelled', decision = 'change_approved' where id = p_id;
    elsif p_approve then
      perform public.absence_check(a.user_id, p_id, a.change_kind, a.change_note, a.change_start, a.change_end);
      update public.absences set kind = change_kind, note = change_note, start_date = change_start, end_date = change_end,
        decision = 'change_approved' where id = p_id;
    else
      update public.absences set decision = 'change_rejected' where id = p_id;
    end if;
    update public.absences set change_type = null, change_kind = null, change_note = null, change_start = null, change_end = null,
      change_requested_at = null, decision_comment = c, decided_by = uid, decided_at = now(), notified_decision_at = null where id = p_id;
  elsif a.status = 'requested' then
    update public.absences set status = case when p_approve then 'approved' else 'rejected' end,
      decision = case when p_approve then 'approved' else 'rejected' end, decision_comment = c, decided_by = uid, decided_at = now(),
      notified_decision_at = null where id = p_id;
  else
    raise exception 'Cette absence n''attend aucune décision.';
  end if;
  return (select status from public.absences where id = p_id);
end;
$$;

-- ===== 5. Administration (admin seulement) =====
create or replace function public.admin_absence_config() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  return jsonb_build_object(
    'clinics', coalesce((select jsonb_agg(jsonb_build_object(
        'clinic', s.clinic, 'max_absent', s.max_absent,
        'validators', coalesce((select jsonb_agg(av.user_id) from public.absence_validators av where av.clinic = s.clinic), '[]'::jsonb),
        'members', (select count(*) from public.profiles p where p.role <> 'member' and s.clinic = any (public.member_clinics(p.id))))
        order by s.pos) from public.absence_clinic_settings s), '[]'::jsonb),
    'cadres', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', public.member_name(p.id)) order by lower(public.member_name(p.id)))
                        from public.profiles p where p.role = 'cadre'), '[]'::jsonb));
end;
$$;

create or replace function public.admin_set_absence_validators(p_clinic text, p_users uuid[]) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare bad uuid;
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  if not exists (select 1 from public.absence_clinic_settings where clinic = p_clinic) then raise exception 'Clinique inconnue : %', p_clinic; end if;
  select u into bad from unnest(coalesce(p_users, '{}')) u where not exists (select 1 from public.profiles p where p.id = u and p.role = 'cadre') limit 1;
  if bad is not null then raise exception 'Seuls les membres du rôle Cadre peuvent valider des absences.'; end if;
  delete from public.absence_validators where clinic = p_clinic;
  insert into public.absence_validators (clinic, user_id) select p_clinic, u from (select distinct u from unnest(coalesce(p_users, '{}')) u) x;
  return array(select user_id from public.absence_validators where clinic = p_clinic);
end;
$$;

create or replace function public.admin_set_absence_threshold(p_clinic text, p_max int) returns int
language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  if p_max is null or p_max < 1 or p_max > 50 then raise exception 'Seuil invalide (1 à 50).'; end if;
  update public.absence_clinic_settings set max_absent = p_max where clinic = p_clinic;
  if not found then raise exception 'Clinique inconnue : %', p_clinic; end if;
  return p_max;
end;
$$;

-- Cliniques de rattachement d'un médecin (clinician ou cdc)
create or replace function public.admin_set_clinics(p_user uuid, p_clinics text[]) returns text[]
language plpgsql security definer set search_path = public as $$
declare r text; bad text;
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r not in ('clinician', 'cdc') then raise exception 'Seuls les médecins sont rattachés à une clinique.'; end if;
  select c into bad from unnest(coalesce(p_clinics, '{}')) c
    where not exists (select 1 from public.absence_clinic_settings s where s.clinic = c and s.clinic <> 'Administration') limit 1;
  if bad is not null then raise exception 'Clinique inconnue : %', bad; end if;
  update public.profiles set clinics = coalesce(array(select distinct c from unnest(coalesce(p_clinics, '{}')) c order by c), '{}') where id = p_user;
  return (select clinics from public.profiles where id = p_user);
end;
$$;

drop function if exists public.admin_members();
create or replace function public.admin_members()
returns table (id uuid, email text, first_name text, last_name text, full_name text, role text, institution text,
               created_at timestamptz, last_sign_in_at timestamptz, tools jsonb, cdc_clinics text[], clinics text[])
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select p.id, u.email::text, p.first_name, p.last_name, p.full_name, p.role, p.institution, u.created_at, u.last_sign_in_at,
      (select jsonb_object_agg(t, jsonb_build_object(
          'allowed', public.tool_allowed(p.id, t),
          'custom', exists (select 1 from public.tool_access a where a.user_id = p.id and a.tool = t)))
       from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'absences', 'medletters']) t),
      p.cdc_clinics, p.clinics
    from public.profiles p join auth.users u on u.id = p.id
    order by (p.role = 'member') desc, lower(coalesce(p.last_name, p.full_name, u.email));
end;
$$;

create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'Vous ne pouvez pas modifier votre propre rôle.';
  end if;
  if p_role not in ('member', 'clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'admin') then
    raise exception 'Rôle inconnu : %', p_role;
  end if;
  update public.profiles set role = p_role,
    cdc_clinics = case when p_role = 'cdc' then cdc_clinics else '{}' end,
    clinics = case when p_role in ('clinician', 'cdc') then clinics else '{}' end
    where id = p_user;
  if not found then raise exception 'Membre introuvable.'; end if;
  if p_role <> 'cadre' then delete from public.absence_validators where user_id = p_user; end if;
  delete from public.tool_access where user_id = p_user;
end;
$$;

create or replace function public.admin_set_tool(p_user uuid, p_tool text, p_allowed boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r in ('admin', 'member') then raise exception 'Accès fixé par le rôle (%)', r; end if;
  if p_tool = 'medletters' then
    if p_allowed and r not in ('clinician', 'cdc', 'pharmacist') then
      raise exception 'Lettres médicales : réservé aux médecins et pharmaciens.';
    end if;
    update public.profiles set med_plus = p_allowed where id = p_user;
  elsif p_tool in ('congres', 'trials', 'lettres', 'limitations', 'duree', 'absences') then
    delete from public.tool_access where user_id = p_user and tool = p_tool;
    if public.tool_allowed(p_user, p_tool) is distinct from p_allowed then
      insert into public.tool_access (user_id, tool, allowed) values (p_user, p_tool, p_allowed);
    end if;
  else
    raise exception 'Outil inconnu : %', p_tool;
  end if;
  return public.tool_allowed(p_user, p_tool);
end;
$$;

-- ===== 6. Droits d'exécution =====
do $$
declare f text;
begin
  foreach f in array array[
    'absence_context()', 'absence_pending_count()', 'absence_clinics()', 'absence_people()', 'absence_grid(date, date)', 'absence_list(uuid)',
    'absence_request(text, text, date, date)', 'absence_update(bigint, text, text, date, date)', 'absence_withdraw(bigint)',
    'absence_request_change(bigint, text, text, text, date, date)', 'absence_cancel_change(bigint)', 'absence_to_validate()',
    'absence_decide(bigint, boolean, text)', 'admin_absence_config()', 'admin_set_absence_validators(text, uuid[])',
    'admin_set_absence_threshold(text, int)', 'admin_set_clinics(uuid, text[])', 'admin_members()', 'admin_set_role(uuid, text)',
    'admin_set_tool(uuid, text, boolean)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
-- Le service (Edge Function de notification) lit les valideurs d'un membre
grant execute on function public.absence_validator_ids(uuid), public.member_name(uuid) to service_role;
