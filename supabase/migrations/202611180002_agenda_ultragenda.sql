-- Diffusion des formulaires d'absence validés, blocage de l'agenda Ultragenda et secrétaires de médecin cadre (18.11.2026).
-- Transactionnel et réexécutable. À appliquer après 202611180001 (circuit configurable) ; aucune donnée de blocs ni de routage n'est créée ici.
--
-- 1. Blocs (groupes de cliniques avec boîte commune et cadres administratifs responsables) et fonction d'assistante « Gestion des agendas médecins ».
-- 2. Secrétaires de médecin cadre : voient et demandent pour leurs cadres (absences.requested_by), reçoivent les décisions.
-- 3. Diffusion du PDF validé : destinataires par défaut (blocs, responsables, secrétaires) et personnalisation par médecin (ajouter ou remplacer).
-- 4. Liste de tâches « Blocage Ultragenda » : une tâche par document de médecin, case à cocher tracée, journal.
-- Aucune adresse réelle dans ce fichier : les blocs et le routage se saisissent dans l'administration.
begin;

do $$
begin
  if to_regclass('public.absence_circuits') is null or to_regprocedure('public.absence_circuit_resolve(uuid,date,date)') is null
     or to_regclass('public.absence_documents') is null or to_regclass('public.onconic_migrations') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'admin_lead') then
    raise exception 'Appliquer d''abord 202611110001, 202611160002 et 202611180001.';
  end if;
end $$;

-- 1. Colonnes et tables -----------------------------------------------------------------------------------------------------

alter table public.profiles add column if not exists agenda_manager boolean not null default false;
alter table public.profiles add column if not exists agenda_clinics text[] not null default '{}';
alter table public.profiles add column if not exists cadre_secretary boolean not null default false;
comment on column public.profiles.agenda_manager is 'Assistante qui gère les agendas de consultation des médecins (rôle assistant seulement).';
comment on column public.profiles.agenda_clinics is 'Cliniques dont l''assistante gère les agendas médecins.';
comment on column public.profiles.cadre_secretary is 'Secrétaire de médecin cadre (rôle assistant seulement) ; cadres dans cadre_secretaries.';

alter table public.absences add column if not exists requested_by uuid references public.profiles (id) on delete set null;
alter table public.absences add column if not exists requested_by_name text;
comment on column public.absences.requested_by is 'Secrétaire qui a saisi la demande pour le médecin cadre ; vide = saisie par l''intéressé.';

-- Blocs : plusieurs cliniques, une boîte commune facultative et des cadres administratifs responsables
create table if not exists public.absence_blocs (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 40),
  clinics text[] not null default '{}',
  email text check (email is null or (char_length(email) <= 254 and email ~ '^[^@[:space:],;<>]+@[^@[:space:],;<>]+\.[^@[:space:],;<>]+$')),
  lead_ids uuid[] not null default '{}',
  pos int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists absence_blocs_name_once on public.absence_blocs (lower(name));
alter table public.absence_blocs enable row level security;
revoke all on public.absence_blocs from public, anon, authenticated;

create or replace function public.absence_blocs_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if 'Administration' = any (new.clinics) then raise exception 'La clinique Administration ne se range dans aucun bloc.'; end if;
  if exists (select 1 from public.absence_blocs b where b.id is distinct from new.id and b.clinics && new.clinics) then
    raise exception 'Une clinique ne peut appartenir qu''à un seul bloc.';
  end if;
  return new;
end;
$$;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'absence_blocs_guard' and tgrelid = 'public.absence_blocs'::regclass) then
    create trigger absence_blocs_guard before insert or update of clinics on public.absence_blocs for each row execute function public.absence_blocs_guard();
  end if;
end $$;

-- Secrétaires de médecin cadre
create table if not exists public.cadre_secretaries (
  secretary_id uuid not null references public.profiles (id) on delete cascade,
  cadre_id uuid not null references public.profiles (id) on delete cascade,
  primary key (secretary_id, cadre_id),
  check (secretary_id <> cadre_id)
);
create index if not exists cadre_secretaries_cadre on public.cadre_secretaries (cadre_id);
alter table public.cadre_secretaries enable row level security;
revoke all on public.cadre_secretaries from public, anon, authenticated;

-- Personnalisation de la diffusion du PDF, par médecin
create table if not exists public.absence_form_routing (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  mode text not null check (mode in ('add', 'replace')),
  emails text[] not null default '{}' check (cardinality(emails) <= 20),
  member_ids uuid[] not null default '{}' check (cardinality(member_ids) <= 20),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.absence_form_routing enable row level security;
revoke all on public.absence_form_routing from public, anon, authenticated;

-- Tâches de blocage de l'agenda : une par document de médecin (instantané immuable)
create table if not exists public.absence_agenda_tasks (
  id bigint generated always as identity primary key,
  document_id bigint not null unique references public.absence_documents (id) on delete cascade,
  owner_id uuid not null,
  action text not null,
  block jsonb not null default '[]'::jsonb,
  unblock jsonb not null default '[]'::jsonb,
  status text not null default 'todo' check (status in ('todo', 'done', 'superseded')),
  done_by uuid,
  done_at timestamptz,
  superseded_by bigint references public.absence_agenda_tasks (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.absence_agenda_tasks add column if not exists notified_at timestamptz;
create index if not exists absence_agenda_tasks_status on public.absence_agenda_tasks (status, id);
create index if not exists absence_agenda_tasks_owner on public.absence_agenda_tasks (owner_id);
alter table public.absence_agenda_tasks enable row level security;
revoke all on public.absence_agenda_tasks from public, anon, authenticated;

create table if not exists public.absence_agenda_log (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.absence_agenda_tasks (id) on delete cascade,
  by_user uuid,
  at timestamptz not null default now(),
  action text not null check (action in ('done', 'undone'))
);
create index if not exists absence_agenda_log_task on public.absence_agenda_log (task_id);
alter table public.absence_agenda_log enable row level security;
revoke all on public.absence_agenda_log from public, anon, authenticated;

-- Journal des réglages de diffusion (blocs, routage, fonctions d'assistante)
create table if not exists public.absence_diffusion_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  target text,
  detail jsonb not null default '{}'::jsonb
);
alter table public.absence_diffusion_log enable row level security;
revoke all on public.absence_diffusion_log from public, anon, authenticated;

-- Une seule copie diffusée par document, même si la ligne « form » est reposée (renvoi)
create unique index if not exists absence_outbox_form_copy_once on public.absence_outbox ((payload ->> 'document_id')) where kind = 'form_copy';

-- Boîte d'envoi : types « on_behalf » (saisie par une secrétaire) et « form_copy » (diffusion du PDF), sans destinataire interne pour form_copy
do $$
declare n text; d text;
begin
  select conname, pg_get_constraintdef(oid) into n, d from pg_constraint where conrelid = 'public.absence_outbox'::regclass and conname = 'absence_outbox_kind_check';
  if n is null or position('on_behalf' in d) = 0 or position('form_copy' in d) = 0 or position('agenda_done' in d) = 0 then
    if n is not null then execute format('alter table public.absence_outbox drop constraint %I', n); end if;
    alter table public.absence_outbox add constraint absence_outbox_kind_check check (kind in
      ('to_validate', 'to_validate_change', 'approved', 'rejected', 'change_approved', 'change_rejected', 'form', 'to_direction', 'direction_change', 'to_opinion', 'peer_rejected', 'on_behalf', 'form_copy', 'agenda_done'));
  end if;
  select pg_get_constraintdef(oid) into d from pg_constraint where conrelid = 'public.absence_outbox'::regclass and conname = 'absence_outbox_recipient_check';
  if d is null or position('form_copy' in d) = 0 then
    if d is not null then alter table public.absence_outbox drop constraint absence_outbox_recipient_check; end if;
    alter table public.absence_outbox add constraint absence_outbox_recipient_check check (recipient is not null or kind in ('form', 'form_copy'));
  end if;
end $$;

-- 2. Fonctions de base ------------------------------------------------------------------------------------------------------

-- Membre dont l'accès est actif (compte validé, accès non échu)
create or replace function public.absence_member_active(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select p.role <> 'member' and (p.access_until is null or p.access_until >= public.ch_date()) from public.profiles p where p.id = p_user), false);
$$;

-- Secrétaire active d'un médecin cadre : fonction cochée, rôle assistant, accès non échu, attribution présente, cadre toujours au rôle cadre
create or replace function public.is_secretary_of(p_secretary uuid, p_cadre uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.cadre_secretaries cs
      join public.profiles s on s.id = cs.secretary_id
      join public.profiles c on c.id = cs.cadre_id
     where cs.secretary_id = p_secretary and cs.cadre_id = p_cadre
       and s.cadre_secretary and s.role = 'assistant' and (s.access_until is null or s.access_until >= public.ch_date())
       and c.role = 'cadre');
$$;

-- Jours ouvrables (hors week-ends et fériés vaudois), 400 jours au plus
create or replace function public.absence_workday_list(p_from date, p_to date) returns date[]
language sql stable set search_path = public, pg_temp as $$
  select coalesce(array_agg(g.d::date order by g.d), '{}'::date[])
    from generate_series(p_from, least(p_to, p_from + 400), interval '1 day') g (d)
   where extract(isodow from g.d) < 6 and not (g.d::date = any (public.vd_holiday_dates(extract(year from g.d)::int)));
$$;

create or replace function public.absence_diffusion_log_add(p_action text, p_target text, p_detail jsonb) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.absence_diffusion_log (actor, action, target, detail) values (auth.uid(), p_action, p_target, coalesce(p_detail, '{}'::jsonb));
$$;

-- Plages valides d'un contrôle de cliniques : liste triée, sans doublon, hors « Administration »
create or replace function public.absence_clinics_check(p_clinics text[]) returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text[] := coalesce(array(select distinct c from unnest(coalesce(p_clinics, '{}'::text[])) c where c is not null order by c), '{}'::text[]);
begin
  if exists (select 1 from unnest(v) c where not exists (select 1 from public.absence_clinic_settings s where s.clinic = c and s.clinic <> 'Administration')) then
    raise exception 'Clinique inconnue.';
  end if;
  return v;
end;
$$;

-- 3. Visibilité et lecture pour les secrétaires ----------------------------------------------------------------------------

-- Une secrétaire voit les absences de ses médecins cadres comme eux-mêmes
create or replace function public.absence_can_see(p_target uuid, p_from date default null, p_to date default null)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid := auth.uid(); vc text[]; tc text[]; hidden boolean;
begin
  if v is null or v = p_target or public.is_direction_admin() or public.is_secretary_of(v, p_target) then return true; end if;
  if p_from is null then
    vc := coalesce(public.member_clinics(v), '{}');
    tc := coalesce(public.member_clinics(p_target), '{}');
  else
    vc := coalesce(public.member_clinics(v, p_from, coalesce(p_to, p_from)), '{}');
    tc := coalesce(public.member_clinics(p_target, p_from, coalesce(p_to, p_from)), '{}');
  end if;
  if exists (select 1 from public.absence_validators av join public.profiles q on q.id = av.user_id
             where av.user_id = v and q.absence_validator and q.role in ('cadre', 'direction') and av.clinic = any (tc)) then
    return true;
  end if;
  if not (vc && tc) then return false; end if;
  select (p.role = 'cadre' and not p.absence_visible) into hidden from public.profiles p where p.id = p_target;
  return not coalesce(hidden, false);
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
      || jsonb_build_object('stage', public.absence_stage_compat(a), 'circuit', public.absence_circuit_public(a)))).*
    from public.absences a where a.user_id = coalesce(p_user, uid) and (perm or public.absence_in_personnes_step(uid, a))
    and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
    -- les brouillons restent à l'intéressé ; une secrétaire voit ceux qu'elle a saisis pour son cadre
    and (a.status <> 'draft' or a.user_id = uid or (a.requested_by = uid and public.is_secretary_of(uid, a.user_id)))
    order by a.start_date desc;
end;
$$;

create or replace function public.absence_approvals_all(p_user uuid default null)
returns table(absence_id bigint, validator_name text, decision text, comment text, decided_at timestamptz, step int, step_label text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); perm boolean := true;
begin
  perform public.absence_guard();
  if p_user is not null and p_user <> uid then
    perm := public.can_validate_absence(uid, p_user) or public.is_direction_admin() or public.is_secretary_of(uid, p_user);
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

-- Solde : lecture seule pour la secrétaire de ce cadre
create or replace function public.absence_balance(p_user uuid default null, p_year int default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); u uuid := coalesce(p_user, auth.uid());
begin
  perform public.absence_guard();
  if u <> uid and not (public.can_validate_absence(uid, u) or public.is_direction_admin() or public.is_secretary_of(uid, u)) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  return public.absence_balance_calc(u, coalesce(p_year, extract(year from public.ch_today())::int), null, u = uid);
end;
$$;

create or replace function public.absence_history(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare owner uuid; conf boolean;
begin
 perform public.absence_guard();
 select user_id into owner from public.absence_audit where absence_id=p_id order by id limit 1;
 if owner is null then return '[]'; end if;
 -- L'historique détaillé reste réservé à la personne, à son ou sa secrétaire et à l'administration ; aucun contournement de confidentialité.
 if owner<>auth.uid() and not public.is_direction_admin() and not public.is_secretary_of(auth.uid(), owner) then raise exception 'Accès refusé.' using errcode='42501'; end if;
 -- Pour la secrétaire (ni l'intéressé, ni la direction) : dès qu'une version de l'absence est confidentielle, aucun texte libre ne sort, quelle que soit la version
 conf := owner<>auth.uid() and not public.is_direction_admin()
   and exists (select 1 from public.absence_audit x where x.absence_id=p_id and x.entity='absences'
               and (coalesce((x.before_data->>'confidential')::boolean,false) or coalesce((x.after_data->>'confidential')::boolean,false)));
 return coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('actor_name',public.member_name(actor),
   'before_data',a.before_data - 'circuit' - (case when conf then array['note','change_note','decision_comment','comment'] else '{}'::text[] end),
   'after_data',a.after_data - 'circuit' - (case when conf then array['note','change_note','decision_comment','comment'] else '{}'::text[] end)) order by id) from public.absence_audit a where absence_id=p_id),'[]');
end $$;

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
  -- tâche Ultragenda : document figé sans ligne « form » dans la boîte d'envoi (aucun PDF envoyé ni copie) ; rôles médecins seulement
  perform public.absence_document_create(array[new_id], 'approved_direct');
  if p_user <> uid then
    perform public.absence_enqueue('direction_change', p_user, array[new_id], jsonb_build_object('action', 'added', 'by', public.member_name(uid)));
  end if;
  return jsonb_build_object('id', new_id, 'conflicts', public.absence_conflicts_json(p_user, p_start, p_end),
                            'balance', public.absence_balance_check(p_user, p_kind, p_start, p_end, new_id));
end;
$$;

-- Téléchargement du PDF : l'intéressé, ses validateurs, l'administration, et la secrétaire du médecin cadre
create or replace function public.absence_form_access(p_caller uuid,p_ids bigint[]) returns boolean language sql stable security definer set search_path = public, pg_temp as $$
 select p_caller is not null and cardinality(p_ids)>0 and cardinality(p_ids)<=50
 and (select count(*) from public.absences where id=any(p_ids))=cardinality(p_ids)
 and (select count(distinct user_id) from public.absences where id=any(p_ids))=1
 and not exists(select 1 from public.absences a where id=any(p_ids) and not (
  a.user_id=p_caller or (select role from public.profiles where id=p_caller) in ('admin','direction')
  or public.can_validate_absence(p_caller,a.user_id,public.absence_lo(a),public.absence_hi(a))
  or public.is_secretary_of(p_caller,a.user_id)))
 and public.tool_allowed(p_caller,'absences');
$$;

-- 4. Demandes saisies par une secrétaire pour son médecin cadre ----------------------------------------------------------

-- Qui sera prévenu : le calcul prend le propriétaire des brouillons (et, pour une secrétaire, seulement ceux qu'elle a saisis)
create or replace function public.absence_validators_calc(p_owner uuid, p_by uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid[] := '{}'; fb boolean := false; a record; fs jsonb; first_step jsonb; fsteps jsonb;
begin
  if exists (select 1 from public.absences where user_id = p_owner and status = 'draft' and (p_by is null or requested_by = p_by)) then
    for a in select x.kind, x.start_date, x.end_date from public.absences x
              where x.user_id = p_owner and x.status = 'draft' and (p_by is null or x.requested_by = p_by) order by x.start_date, x.id loop
      fs := public.absence_first_stop(p_owner, a.start_date, a.end_date, public.absence_circuit_build(a.kind, a.start_date, a.end_date, null, p_owner));
      first_step := coalesce(first_step, fs -> 'step'); fsteps := coalesce(fsteps, fs -> 'steps');
      if fs -> 'step' ->> 'kind' = 'visa' then fb := true; end if;
      v := v || array(select p::uuid from jsonb_array_elements_text(fs -> 'people') p where not (p::uuid = any (v)));
    end loop;
  else
    fs := public.absence_first_stop(p_owner, public.ch_today(), public.ch_today(), public.absence_circuit_build('vacances', public.ch_today(), public.ch_today(), null, p_owner));
    first_step := fs -> 'step'; fsteps := fs -> 'steps';
    fb := fs -> 'step' ->> 'kind' = 'visa';
    v := array(select p::uuid from jsonb_array_elements_text(fs -> 'people') p);
  end if;
  return jsonb_build_object('fallback', fb, 'steps', coalesce((select jsonb_agg(jsonb_build_object('label', x ->> 'label', 'rule', coalesce(x ->> 'rule', 'all'))) from jsonb_array_elements(coalesce(fsteps, '[]'::jsonb)) x), '[]'::jsonb), 'step_kind', first_step ->> 'kind', 'step_label', first_step ->> 'label', 'step_rule', coalesce(first_step ->> 'rule', 'all'),
    'validators', coalesce((select jsonb_agg(jsonb_build_object('id', x, 'name', public.member_name(x)) order by public.member_name(x)) from unnest(v) x), '[]'::jsonb));
end;
$$;

create or replace function public.absence_my_validators_full() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  return public.absence_validators_calc(auth.uid(), null);
end;
$$;

create or replace function public.absence_my_validators_for(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  if not public.is_secretary_of(auth.uid(), p_user) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  return public.absence_validators_view(public.absence_validators_calc(p_user, auth.uid()));
end;
$$;

create or replace function public.absence_request_for(p_user uuid, p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); n text := nullif(trim(coalesce(p_note, '')), ''); new_id bigint;
begin
  perform public.absence_guard();
  perform public.absence_purge();
  if not public.is_secretary_of(uid, p_user) or not public.tool_allowed(p_user, 'absences') then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  perform public.absence_check(p_user, null, p_kind, n, p_start, p_end);
  insert into public.absences (user_id, kind, note, start_date, end_date, status, requested_by, requested_by_name)
    values (p_user, p_kind, n, p_start, p_end, 'draft', uid, public.member_name(uid)) returning id into new_id;
  return jsonb_build_object('id', new_id, 'conflicts', public.absence_conflicts_json(p_user, p_start, p_end));
end;
$$;

-- Envoi : tous les brouillons du propriétaire (p_by vide) ou, pour une secrétaire, ceux qu'elle a saisis
create or replace function public.absence_submit_core(p_owner uuid, p_by uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare ids bigint[]; rec uuid[]; who jsonb; fb boolean; rcp uuid; oi bigint[];
begin
  who := public.absence_validators_calc(p_owner, p_by);
  fb := (who ->> 'fallback')::boolean;
  select array_agg(id order by start_date) into ids from public.absences where user_id = p_owner and status = 'draft' and (p_by is null or requested_by = p_by);
  if ids is null then raise exception 'Aucune demande en brouillon à envoyer.'; end if;
  update public.absences set status = 'requested', submitted_at = now(), notified_at = null, decision = null, decision_comment = null,
    decided_by = null, decided_at = null where id = any (ids);
  perform public.absence_open_round(i) from unnest(ids) i;
  select coalesce(array_agg((x ->> 'id')::uuid), '{}') into rec from jsonb_array_elements(who -> 'validators') x;
  perform public.absence_enqueue('to_validate', r, ids, jsonb_build_object('owner', public.member_name(p_owner))) from unnest(rec) r;
  -- Pré-avis de la direction, en parallèle et sans bloquer : demande par demande, sans doublon pour qui reçoit déjà le message de validation de cette demande
  foreach rcp in array public.absence_opinion_recipients(p_owner) loop
    oi := array(select x.id from public.absences x where x.id = any (ids) and public.absence_preavis_of(x)
                   and not (rcp = any (public.absence_col_people(x))) order by x.start_date, x.id);
    if coalesce(array_length(oi, 1), 0) > 0 then
      perform public.absence_enqueue('to_opinion', rcp, oi, jsonb_build_object('owner', public.member_name(p_owner)));
    end if;
  end loop;
  -- Le médecin cadre est prévenu qu'une demande a été saisie en son nom
  if p_by is not null then
    perform public.absence_enqueue('on_behalf', p_owner, ids, jsonb_build_object('by', public.member_name(p_by), 'action', 'request'));
  end if;
  who := public.absence_validators_view(who);
  return jsonb_build_object('count', array_length(ids, 1), 'ids', to_jsonb(ids), 'fallback', fb, 'validators', who -> 'validators', 'more', who -> 'more', 'summary', who -> 'summary');
end;
$$;

create or replace function public.absence_submit() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  perform public.absence_purge();
  return public.absence_submit_core(auth.uid(), null);
end;
$$;

create or replace function public.absence_submit_for(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  perform public.absence_purge();
  if not public.is_secretary_of(auth.uid(), p_user) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  return public.absence_submit_core(p_user, auth.uid());
end;
$$;

-- Retrait d'une demande saisie par la secrétaire (brouillon ou demande en cours)
create or replace function public.absence_withdraw_for(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); s text; o uuid; rb uuid;
begin
  perform public.absence_guard();
  select user_id, status, requested_by into o, s, rb from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if not public.is_secretary_of(uid, o) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  if rb is distinct from uid then raise exception 'Vous ne retirez que les demandes que vous avez saisies.' using errcode = '42501'; end if;
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

create or replace function public.absence_request_change_core(p_owner uuid, p_by uuid, p_id bigint, p_type text, p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n text := nullif(trim(coalesce(p_note, '')), ''); a public.absences; res jsonb; rec uuid[]; op uuid[];
begin
  select * into a from public.absences where id = p_id and user_id = p_owner for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if a.status <> 'approved' then raise exception 'Seule une absence validée appelle une demande de modification.'; end if;
  if a.change_type is not null then raise exception 'Une demande est déjà en cours pour cette absence.'; end if;
  if p_type = 'delete' then
    update public.absences set change_type = 'delete', change_requested_at = now(), notified_at = null where id = p_id;
    res := jsonb_build_object('id', p_id, 'conflicts', '[]'::jsonb);
  elsif p_type = 'modify' then
    perform public.absence_check(p_owner, p_id, p_kind, n, p_start, p_end);
    update public.absences set change_type = 'modify', change_kind = p_kind, change_note = n, change_start = p_start, change_end = p_end,
      change_requested_at = now(), notified_at = null where id = p_id;
    res := jsonb_build_object('id', p_id, 'conflicts', public.absence_conflicts_json(p_owner, p_start, p_end));
  else
    raise exception 'Type de demande inconnu.';
  end if;
  perform public.absence_open_round(p_id);
  select * into a from public.absences where id = p_id;
  rec := public.absence_col_people(a);
  perform public.absence_enqueue('to_validate_change', r, array[p_id], jsonb_build_object('owner', public.member_name(p_owner))) from unnest(rec) r;
  if public.absence_preavis_of(a) then
    op := array(select x from unnest(public.absence_opinion_recipients(p_owner)) x where not (x = any (rec)));
    perform public.absence_enqueue('to_opinion', r, array[p_id], jsonb_build_object('owner', public.member_name(p_owner))) from unnest(op) r;
  end if;
  if p_by is not null then
    perform public.absence_enqueue('on_behalf', p_owner, array[p_id], jsonb_build_object('by', public.member_name(p_by), 'action', p_type));
  end if;
  return res;
end;
$$;

create or replace function public.absence_request_change(p_id bigint, p_type text, p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  return public.absence_request_change_core(auth.uid(), null, p_id, p_type, p_kind, p_note, p_start, p_end);
end;
$$;

create or replace function public.absence_request_change_for(p_user uuid, p_id bigint, p_type text, p_kind text, p_note text, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  if not public.is_secretary_of(auth.uid(), p_user) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  return public.absence_request_change_core(p_user, auth.uid(), p_id, p_type, p_kind, p_note, p_start, p_end);
end;
$$;

-- Notifications : saisie par une secrétaire (au cadre) et décisions (aussi à ses secrétaires)
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
    else false end;
$$;

-- Types de notification proposés dans Mon compte : on_behalf pour les médecins cadres
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
    if r = 'cadre' then k := k || array['on_behalf']; end if;
    if r in ('clinician', 'cdc', 'cadre') then k := k || array['agenda_done']; end if;
  end if;
  if public.tool_allowed(p_user, 'congres') then k := k || array['event_join']; end if;
  return k;
end;
$$;

-- 5. Documents : file d'attente de diffusion et tâches de blocage -----------------------------------------------------------

-- La boîte d'envoi garde une référence vers le document (inchangé), sans instantané pour la copie diffusée
create or replace function public.absence_form_freeze() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare doc bigint; prior jsonb:='[]';
begin
 if tg_op='UPDATE' then prior:=coalesce(old.payload->'absences','[]'); end if;
 if new.kind='form' and not (new.payload ? 'document_id') then
  doc:=public.absence_document_create(new.absence_ids,coalesce(new.payload->>'action','approved'));
  new.payload:=new.payload||jsonb_build_object('document_id',doc);
 elsif new.kind not in ('form', 'form_copy') then
  new.payload:=(new.payload-'comment')||jsonb_build_object('absences',(
   select jsonb_agg(coalesce((select x from jsonb_array_elements(prior) x where (x->>'id')::bigint=a.id limit 1),
   jsonb_build_object('id',a.id,'user_id',user_id,'kind',kind,'start_date',start_date,'end_date',end_date,
    'note',null,'change_type',change_type,'change_kind',change_kind,'change_note',null,'change_start',change_start,'change_end',change_end)) order by start_date,a.id)
   from public.absences a where a.id=any(new.absence_ids)));
 end if;
 return new;
end $$;

-- Périodes de blocage entre deux dates : entrée { absence_id, start, end }
create or replace function public.absence_agenda_entry(p_absence bigint, p_start date, p_end date) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('absence_id', p_absence, 'start', p_start, 'end', p_end);
$$;

-- Période actuellement bloquée dans Ultragenda pour cette absence (tâches cochées), sinon null.
-- Sans aucune tâche connue (absence validée avant cette fonction) : période du document précédent, sauf à la reprise.
create or replace function public.absence_agenda_blocked(p_absence bigint, p_before_doc bigint, p_retro boolean) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare latest record; prev record; any_task boolean;
begin
  select q.kind, q.entry into latest from (
    select t.id, 'block' as kind, x as entry from public.absence_agenda_tasks t, jsonb_array_elements(t.block) x
     where t.status = 'done' and (x ->> 'absence_id')::bigint = p_absence and not coalesce((x ->> 'void')::boolean, false)
    union all
    select t.id, 'unblock', x from public.absence_agenda_tasks t, jsonb_array_elements(t.unblock) x
     where t.status = 'done' and (x ->> 'absence_id')::bigint = p_absence and not coalesce((x ->> 'void')::boolean, false)
  ) q order by q.id desc, (q.kind = 'block') desc limit 1;
  if found then
    if latest.kind = 'block' then return latest.entry - 'void'; end if;
    return null;
  end if;
  select exists (select 1 from public.absence_agenda_tasks t where exists (select 1 from jsonb_array_elements(t.block || t.unblock) x where (x ->> 'absence_id')::bigint = p_absence)) into any_task;
  if any_task or p_retro then return null; end if;
  select pd.action, e into prev from public.absence_documents pd, jsonb_array_elements(pd.data -> 'absences') e
   where pd.id < p_before_doc and p_absence = any (pd.absence_ids) and (e ->> 'id')::bigint = p_absence order by pd.id desc limit 1;
  if found and prev.action not like 'cancelled%' and prev.e ->> 'status' = 'approved' then
    return public.absence_agenda_entry(p_absence, (prev.e ->> 'start_date')::date, (prev.e ->> 'end_date')::date);
  end if;
  return null;
end;
$$;

-- Annule (void) les lignes encore à faire de cette absence dans les tâches ouvertes ; une tâche sans ligne active devient « remplacée »
create or replace function public.absence_agenda_void(p_absence bigint) returns bigint[]
language plpgsql security definer set search_path = public, pg_temp as $$
declare t record; touched bigint[] := '{}'; nb jsonb; nu jsonb;
begin
  for t in select * from public.absence_agenda_tasks
            where status = 'todo' and exists (select 1 from jsonb_array_elements(block || unblock) x
                                              where (x ->> 'absence_id')::bigint = p_absence and not coalesce((x ->> 'void')::boolean, false)) for update loop
    select coalesce(jsonb_agg(case when (x ->> 'absence_id')::bigint = p_absence then x || '{"void": true}'::jsonb else x end order by o), '[]'::jsonb) into nb from jsonb_array_elements(t.block) with ordinality v(x, o);
    select coalesce(jsonb_agg(case when (x ->> 'absence_id')::bigint = p_absence then x || '{"void": true}'::jsonb else x end order by o), '[]'::jsonb) into nu from jsonb_array_elements(t.unblock) with ordinality v(x, o);
    update public.absence_agenda_tasks set block = nb, unblock = nu,
      status = case when exists (select 1 from jsonb_array_elements(nb || nu) x where not coalesce((x ->> 'void')::boolean, false)) then 'todo' else 'superseded' end
     where id = t.id;
    touched := touched || t.id;
  end loop;
  return touched;
end;
$$;

-- Crée la tâche d'un document de médecin. p_retro : reprise des documents existants (périodes passées ignorées, aucun déblocage supposé)
create or replace function public.absence_agenda_task_make(p_doc bigint, p_retro boolean default false) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare d public.absence_documents; k text; e jsonb; aid bigint; s date; en date; cur jsonb; prev jsonb; blk jsonb := '[]'::jsonb; unb jsonb := '[]'::jsonb;
  touched bigint[] := '{}'; tid bigint; today date := public.ch_today();
begin
  select * into d from public.absence_documents where id = p_doc;
  if not found then return null; end if;
  select id into tid from public.absence_agenda_tasks where document_id = p_doc;
  if found then return tid; end if;
  perform pg_advisory_xact_lock(hashtext('absence_agenda:' || d.user_id::text));
  k := case when d.action like 'cancelled%' then 'cancelled' when d.action like 'modified%' then 'modified' else 'approved' end;
  for e in select value from jsonb_array_elements(coalesce(d.data -> 'absences', '[]'::jsonb)) order by value ->> 'start_date', (value ->> 'id')::bigint loop
    aid := (e ->> 'id')::bigint; s := (e ->> 'start_date')::date; en := (e ->> 'end_date')::date;
    prev := public.absence_agenda_blocked(aid, d.id, p_retro);
    touched := touched || public.absence_agenda_void(aid);
    cur := case when k <> 'cancelled' and e ->> 'status' = 'approved' then public.absence_agenda_entry(aid, s, en) end;
    -- rien ne change si la période bloquée est déjà la bonne
    if cur is not null and prev is not null and (prev ->> 'start') = (cur ->> 'start') and (prev ->> 'end') = (cur ->> 'end') then prev := null; cur := null; end if;
    if p_retro then
      if cur is not null and (cur ->> 'end')::date < today then cur := null; end if;
      prev := null;
    end if;
    if prev is not null then unb := unb || jsonb_build_array(prev - 'void'); end if;
    if cur is not null then blk := blk || jsonb_build_array(cur); end if;
  end loop;
  if jsonb_array_length(blk) + jsonb_array_length(unb) = 0 then return null; end if;
  -- reprise : tâches silencieuses (le médecin ne reçoit jamais d'avis pour elles)
  insert into public.absence_agenda_tasks (document_id, owner_id, action, block, unblock, notified_at) values (d.id, d.user_id, d.action, blk, unb, case when p_retro then now() end) returning id into tid;
  update public.absence_agenda_tasks set superseded_by = tid where id = any (touched) and status = 'superseded' and superseded_by is null;
  return tid;
end;
$$;

create or replace function public.absence_agenda_after_document() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- une erreur ici ne doit jamais annuler la décision de validation
  begin
    perform public.absence_agenda_task_make(new.id, false);
  exception when others then
    raise warning 'absence_agenda_after_document : %', sqlerrm;
    begin
      insert into public.absence_diffusion_log (action, target, detail) values ('agenda_task_error', new.id::text, jsonb_build_object('error', left(sqlerrm, 200)));
    exception when others then null;
    end;
  end;
  return new;
end;
$$;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'absence_agenda_after_document' and tgrelid = 'public.absence_documents'::regclass) then
    create trigger absence_agenda_after_document after insert on public.absence_documents for each row execute function public.absence_agenda_after_document();
  end if;
end $$;

-- Reprise : documents existants dont une absence n'est pas terminée (tâches « à faire »), une seule fois
do $$
declare r record;
begin
  if not exists (select 1 from public.onconic_migrations where version = '202611180002') then
    for r in select id from public.absence_documents order by id loop
      perform public.absence_agenda_task_make(r.id, true);
    end loop;
  end if;
end $$;

-- 6. Diffusion du PDF : destinataires -------------------------------------------------------------------------------------

-- Secrétaires actives d'un médecin cadre (vide pour tout autre rôle)
create or replace function public.absence_active_secretaries(p_owner uuid) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(cs.secretary_id order by cs.secretary_id), '{}'::uuid[]) from public.cadre_secretaries cs
   where cs.cadre_id = p_owner and public.is_secretary_of(cs.secretary_id, p_owner);
$$;

-- Destinataires par défaut d'un médecin sur une période : boîtes communes des blocs concernés, responsables des blocs, secrétaires (médecin cadre)
create or replace function public.absence_form_default(p_owner uuid, p_lo date, p_hi date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare cl text[]; r text; mem uuid[]; em text[]; blocs jsonb; sec uuid[];
begin
  select role into r from public.profiles where id = p_owner;
  cl := coalesce(public.member_clinics(p_owner, p_lo, p_hi), '{}'::text[]);
  -- médecin cadre avec au moins une secrétaire active : ses secrétaires seules (ni boîte de bloc, ni responsables de bloc)
  sec := public.absence_active_secretaries(p_owner);
  if cardinality(sec) > 0 then
    return jsonb_build_object('clinics', to_jsonb(cl), 'blocs', '[]'::jsonb, 'emails', '[]'::jsonb, 'members', to_jsonb(sec), 'secretary_only', true);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'email', b.email) order by b.pos, b.id), '[]'::jsonb),
         coalesce(array_agg(lower(b.email)) filter (where b.email is not null), '{}'::text[])
    into blocs, em from public.absence_blocs b where b.clinics && cl;
  select coalesce(array_agg(distinct m), '{}'::uuid[]) into mem from (
    select l as m from public.absence_blocs b cross join lateral unnest(b.lead_ids) l
      join public.profiles lp on lp.id = l and lp.role = 'assistant' and lp.admin_lead
     where b.clinics && cl
    union
    select cs.secretary_id from public.cadre_secretaries cs where r = 'cadre' and cs.cadre_id = p_owner and public.is_secretary_of(cs.secretary_id, p_owner)) q
   where public.absence_member_active(q.m);
  return jsonb_build_object('clinics', to_jsonb(cl), 'blocs', blocs, 'emails', to_jsonb(em), 'members', to_jsonb(mem));
end;
$$;

-- Destinataires effectifs : défaut, puis personnalisation du médecin (ajouter ou remplacer)
create or replace function public.absence_form_effective(p_owner uuid, p_lo date, p_hi date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d jsonb := public.absence_form_default(p_owner, p_lo, p_hi); rt public.absence_form_routing; em text[]; mem uuid[]; role_ text;
begin
  select role into role_ from public.profiles where id = p_owner;
  if role_ is null or role_ not in ('clinician', 'cdc', 'cadre') then return jsonb_build_object('emails', '[]'::jsonb, 'members', '[]'::jsonb, 'mode', null); end if;
  em := array(select jsonb_array_elements_text(d -> 'emails'));
  mem := array(select (jsonb_array_elements_text(d -> 'members'))::uuid);
  select * into rt from public.absence_form_routing where user_id = p_owner;
  if found then
    if rt.mode = 'replace' then em := rt.emails; mem := rt.member_ids; else em := em || rt.emails; mem := mem || rt.member_ids; end if;
  end if;
  return jsonb_build_object('mode', rt.mode,
    'emails', to_jsonb(coalesce(array(select distinct lower(x) from unnest(em) x where x is not null order by 1), '{}'::text[])),
    'members', to_jsonb(coalesce(array(select distinct m from unnest(mem) m where public.absence_member_active(m) order by 1), '{}'::uuid[])));
end;
$$;

-- Destinataires d'un document (Edge Function) : adresses (boîtes communes, adresses ajoutées, adresses personnelles des membres) et membres
create or replace function public.absence_form_recipients(p_document bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d public.absence_documents; lo date; hi date; eff jsonb; em text[]; mem uuid[];
begin
  select * into d from public.absence_documents where id = p_document;
  if not found then return jsonb_build_object('emails', '[]'::jsonb, 'members', '[]'::jsonb); end if;
  select min((x ->> 'start_date')::date), max((x ->> 'end_date')::date) into lo, hi from jsonb_array_elements(coalesce(d.data -> 'absences', '[]'::jsonb)) x;
  lo := coalesce(lo, public.ch_today()); hi := coalesce(hi, lo);
  eff := public.absence_form_effective(d.user_id, lo, hi);
  mem := array(select (jsonb_array_elements_text(eff -> 'members'))::uuid);
  em := array(select jsonb_array_elements_text(eff -> 'emails')) || array(select lower(u.email) from auth.users u where u.id = any (mem) and u.email is not null);
  return jsonb_build_object('emails', to_jsonb(coalesce(array(select distinct x from unnest(em) x where x <> '' order by 1), '{}'::text[])), 'members', to_jsonb(mem));
end;
$$;

-- Message à diffuser : la copie du PDF part à ces destinataires, seulement s'il y en a
create or replace function public.absence_form_copy_queue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare doc bigint := nullif(new.payload ->> 'document_id', '')::bigint; r jsonb;
begin
  if new.kind <> 'form' or doc is null then return new; end if;
  -- une erreur ici ne doit jamais annuler la décision de validation ; une seule copie par document
  begin
    r := public.absence_form_recipients(doc);
    if jsonb_array_length(coalesce(r -> 'emails', '[]'::jsonb)) = 0 then return new; end if;
    insert into public.absence_outbox (kind, recipient, absence_ids, payload) values ('form_copy', null, new.absence_ids, jsonb_build_object('document_id', doc, 'action', new.payload ->> 'action'))
      on conflict ((payload ->> 'document_id')) where kind = 'form_copy' do nothing;
  exception when others then
    raise warning 'absence_form_copy_queue : %', sqlerrm;
    begin
      insert into public.absence_diffusion_log (action, target, detail) values ('form_copy_error', doc::text, jsonb_build_object('error', left(sqlerrm, 200)));
    exception when others then null;
    end;
  end;
  return new;
end;
$$;
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'absence_form_copy_queue' and tgrelid = 'public.absence_outbox'::regclass) then
    create trigger absence_form_copy_queue after insert on public.absence_outbox for each row execute function public.absence_form_copy_queue();
  end if;
end $$;

-- Données du message de diffusion (Edge Function) : périodes encore à traiter, jours ouvrables, sans aucun texte libre
create or replace function public.absence_agenda_mail(p_document bigint) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.absence_agenda_tasks;
begin
  select * into t from public.absence_agenda_tasks where document_id = p_document;
  if not found or t.status = 'superseded' then return null; end if;
  return jsonb_build_object('owner', public.member_name(t.owner_id), 'action', t.action,
    'block', public.absence_agenda_view(t.block, false), 'unblock', public.absence_agenda_view(t.unblock, false));
end;
$$;

-- Entrées d'une tâche pour l'affichage : période et jours ouvrables ; les lignes annulées n'apparaissent que si p_all
create or replace function public.absence_agenda_view(p_entries jsonb, p_all boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('absence_id', (x ->> 'absence_id')::bigint, 'start', x ->> 'start', 'end', x ->> 'end',
           'void', coalesce((x ->> 'void')::boolean, false),
           'days', to_jsonb(public.absence_workday_list((x ->> 'start')::date, (x ->> 'end')::date)))
         order by x ->> 'start', o), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) with ordinality v(x, o)
  where p_all or not coalesce((x ->> 'void')::boolean, false);
$$;

-- 7. Tâches : audience, lecture, case à cocher ----------------------------------------------------------------------------

create or replace function public.absence_agenda_audience(p_owner uuid, p_document bigint) returns uuid[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare lo date; hi date; cl text[]; res uuid[]; rt public.absence_form_routing;
begin
  -- mode « remplacer » : seuls les membres choisis (comme pour la diffusion du PDF)
  select * into rt from public.absence_form_routing where user_id = p_owner;
  if found and rt.mode = 'replace' then
    return coalesce(array(select distinct m from unnest(rt.member_ids) m where public.absence_member_active(m)), '{}'::uuid[]);
  end if;
  select min(q.d), max(q.e) into lo, hi from (
    select (x ->> 'start_date')::date d, (x ->> 'end_date')::date e from public.absence_documents ad, jsonb_array_elements(coalesce(ad.data -> 'absences', '[]'::jsonb)) x where ad.id = p_document
    union all
    select (x ->> 'start')::date, (x ->> 'end')::date from public.absence_agenda_tasks t, jsonb_array_elements(t.block || t.unblock) x where t.document_id = p_document) q;
  lo := coalesce(lo, public.ch_today()); hi := coalesce(hi, lo);
  cl := coalesce(public.member_clinics(p_owner, lo, hi), '{}'::text[]);
  -- médecin cadre avec secrétaire active : ses secrétaires, pas les assistantes des agendas ni les responsables de bloc
  select coalesce(array_agg(distinct q.m), '{}'::uuid[]) into res from (
    select p.id as m from public.profiles p where p.role = 'assistant' and p.agenda_manager and p.agenda_clinics && cl and cardinality(public.absence_active_secretaries(p_owner)) = 0
    union
    select l from public.absence_blocs b cross join lateral unnest(b.lead_ids) l
      join public.profiles lp on lp.id = l and lp.role = 'assistant' and lp.admin_lead where b.clinics && cl and cardinality(public.absence_active_secretaries(p_owner)) = 0
    union
    select unnest(public.absence_active_secretaries(p_owner))
    union
    select unnest(r.member_ids) from public.absence_form_routing r where r.user_id = p_owner) q
   where public.absence_member_active(q.m);
  return res;
end;
$$;

-- Droit de voir et de cocher une tâche : audience, administrateurs et direction
create or replace function public.absence_agenda_can(p_user uuid, p_task bigint) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t public.absence_agenda_tasks;
begin
  if p_user is null or not public.absence_member_active(p_user) then return false; end if;
  if exists (select 1 from public.profiles p where p.id = p_user and p.role in ('admin', 'direction')) then return true; end if;
  select * into t from public.absence_agenda_tasks where id = p_task;
  if not found then return false; end if;
  return p_user = any (public.absence_agenda_audience(t.owner_id, t.document_id));
end;
$$;

-- Contexte de l'onglet : visible pour qui a une audience ; secrétaires et leurs médecins cadres
create or replace function public.absence_agenda_context() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); p public.profiles; tab boolean;
begin
  perform public.absence_guard();
  select * into p from public.profiles where id = uid;
  tab := public.is_direction_admin()
    or (p.role = 'assistant' and (p.agenda_manager or p.admin_lead or p.cadre_secretary))
    or exists (select 1 from public.absence_form_routing r where uid = any (r.member_ids));
  return jsonb_build_object('tab', coalesce(tab, false), 'pending', public.absence_agenda_pending_count(),
    'secretary_of', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', public.member_name(c.id)) order by lower(public.member_name(c.id)))
                               from public.cadre_secretaries cs join public.profiles c on c.id = cs.cadre_id
                              where cs.secretary_id = uid and public.is_secretary_of(uid, cs.cadre_id)), '[]'::jsonb));
end;
$$;

create or replace function public.absence_agenda_pending_count() returns int
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.tool_allowed(auth.uid(), 'absences') then return 0; end if;
  return (select count(*)::int from public.absence_agenda_tasks t where t.status = 'todo' and public.absence_agenda_can(auth.uid(), t.id));
end;
$$;

create or replace function public.absence_agenda_tasks_list(p_status text default 'todo') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  perform public.absence_guard();
  if p_status is null or p_status not in ('todo', 'done', 'all') then raise exception 'Filtre inconnu.'; end if;
  return coalesce((
    select jsonb_agg(x.j order by x.o1 nulls last, x.o2 desc) from (
      select jsonb_build_object(
               'id', t.id, 'document_id', t.document_id, 'owner_id', t.owner_id, 'owner_name', public.member_name(t.owner_id),
               'clinics', public.member_clinics(t.owner_id, sp.lo, sp.hi),
               'action', t.action,
               'kind', case when t.action like 'cancelled%' then 'cancelled' when t.action like 'modified%' then 'modified' else 'approved' end,
               'status', t.status,
               'block', public.absence_agenda_view(t.block, t.status = 'superseded'),
               'unblock', public.absence_agenda_view(t.unblock, t.status = 'superseded'),
               'done_by_name', case when t.done_by is null then null else public.member_name(t.done_by) end, 'done_at', t.done_at,
               'created_at', t.created_at,
               'past', t.status = 'todo' and sp.live_hi is not null and sp.live_hi < public.ch_today()) as j,
             case when t.status = 'todo' then sp.live_lo end as o1, t.id as o2
        from public.absence_agenda_tasks t
        cross join lateral (
          select min((e ->> 'start')::date) as lo, max((e ->> 'end')::date) as hi,
                 min((e ->> 'start')::date) filter (where not coalesce((e ->> 'void')::boolean, false)) as live_lo,
                 max((e ->> 'end')::date) filter (where not coalesce((e ->> 'void')::boolean, false)) as live_hi
            from jsonb_array_elements(t.block || t.unblock) e) sp
       where (p_status = 'all' or t.status = p_status) and (t.status = 'todo' or t.created_at >= now() - interval '180 days')
         and public.absence_agenda_can(uid, t.id)
       order by o1 nulls last, o2 desc limit 500) x), '[]'::jsonb);
end;
$$;

-- État Ultragenda des absences validées d'une personne (soi-même, son ou sa secrétaire, ses validateurs, la direction) : état et date seulement
create or replace function public.absence_agenda_status(p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); u uuid := coalesce(p_user, auth.uid());
begin
  perform public.absence_guard();
  if u <> uid and not (public.can_validate_absence(uid, u) or public.is_direction_admin() or public.is_secretary_of(uid, u)) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_object_agg(a.id::text, jsonb_build_object('status', x.status, 'done_at', x.done_at))
      from public.absences a
      cross join lateral (
        select t.status, t.done_at from public.absence_agenda_tasks t
         where t.owner_id = u and t.status <> 'superseded'
           and exists (select 1 from jsonb_array_elements(t.block || t.unblock) e where (e ->> 'absence_id')::bigint = a.id and not coalesce((e ->> 'void')::boolean, false))
         order by t.id desc limit 1) x
     where a.user_id = u and a.status = 'approved'), '{}'::jsonb);
end;
$$;

create or replace function public.absence_agenda_set(p_task bigint, p_done boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); t public.absence_agenda_tasks;
begin
  perform public.absence_guard();
  if p_done is null then raise exception 'Choix manquant.'; end if;
  select * into t from public.absence_agenda_tasks where id = p_task for update;
  if not found or not public.absence_agenda_can(uid, p_task) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  if t.status = 'superseded' then raise exception 'Cette tâche est remplacée par une plus récente.'; end if;
  if p_done and t.status = 'todo' then
    update public.absence_agenda_tasks set status = 'done', done_by = uid, done_at = now() where id = p_task;
    insert into public.absence_agenda_log (task_id, by_user, action) values (p_task, uid, 'done');
    -- le médecin est prévenu la première fois seulement (jamais au décochage ni au recochage)
    if t.notified_at is null then
      update public.absence_agenda_tasks set notified_at = now() where id = p_task;
      perform public.absence_enqueue('agenda_done', t.owner_id,
        array(select distinct (x ->> 'absence_id')::bigint from jsonb_array_elements(t.block || t.unblock) x where not coalesce((x ->> 'void')::boolean, false)),
        jsonb_build_object('action', case when jsonb_array_length(t.block) > 0 and exists (select 1 from jsonb_array_elements(t.block) x where not coalesce((x ->> 'void')::boolean, false)) then 'blocked' else 'unblocked' end,
          'by', public.member_name(uid),
          'periods', coalesce((select jsonb_agg(jsonb_build_object('start', x ->> 'start', 'end', x ->> 'end') order by x ->> 'start')
                                 from jsonb_array_elements(case when exists (select 1 from jsonb_array_elements(t.block) b where not coalesce((b ->> 'void')::boolean, false)) then t.block else t.unblock end) x
                                where not coalesce((x ->> 'void')::boolean, false)), '[]'::jsonb)));
    end if;
  elsif not p_done and t.status = 'done' then
    update public.absence_agenda_tasks set status = 'todo', done_by = null, done_at = null where id = p_task;
    insert into public.absence_agenda_log (task_id, by_user, action) values (p_task, uid, 'undone');
  end if;
  select * into t from public.absence_agenda_tasks where id = p_task;
  return jsonb_build_object('status', t.status, 'done_by_name', case when t.done_by is null then null else public.member_name(t.done_by) end, 'done_at', t.done_at);
end;
$$;

-- 8. Administration : fonctions d'assistante ------------------------------------------------------------------------------

-- Accès à Absences nécessaire aux deux fonctions : exception ouverte si l'assistante ne l'a pas déjà (jamais écrasée si l'administrateur l'a refusé)
create or replace function public.absence_ensure_tool(p_user uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.tool_allowed(p_user, 'absences') and not exists (select 1 from public.tool_access where user_id = p_user and tool = 'absences') then
    insert into public.tool_access (user_id, tool, allowed) values (p_user, 'absences', true);
  end if;
  return public.tool_allowed(p_user, 'absences');
end;
$$;

create or replace function public.admin_set_agenda_manager(p_user uuid, p_on boolean, p_clinics text[] default '{}') returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role text; v_cl text[]; v_on boolean := coalesce(p_on, false);
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select role into v_role from public.profiles where id = p_user for update;
  if v_role is null then raise exception 'Membre introuvable.'; end if;
  if v_on and v_role <> 'assistant' then raise exception 'La gestion des agendas médecins est réservée au rôle Assistante.'; end if;
  v_cl := public.absence_clinics_check(p_clinics);
  if v_on and cardinality(v_cl) = 0 then raise exception 'Choisissez au moins une clinique.'; end if;
  update public.profiles set agenda_manager = v_on, agenda_clinics = case when v_on then v_cl else '{}'::text[] end where id = p_user;
  perform public.absence_diffusion_log_add(case when v_on then 'agenda_manager_on' else 'agenda_manager_off' end, p_user::text, jsonb_build_object('clinics', to_jsonb(v_cl)));
  return case when v_on then public.absence_ensure_tool(p_user) else public.tool_allowed(p_user, 'absences') end;
end;
$$;

create or replace function public.admin_set_cadre_secretary(p_user uuid, p_on boolean, p_cadres uuid[] default '{}') returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role text; v_on boolean := coalesce(p_on, false); v_ids uuid[] := coalesce(array(select distinct c from unnest(coalesce(p_cadres, '{}'::uuid[])) c where c is not null), '{}'::uuid[]);
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select role into v_role from public.profiles where id = p_user for update;
  if v_role is null then raise exception 'Membre introuvable.'; end if;
  if v_on and v_role <> 'assistant' then raise exception 'La fonction de secrétaire de médecin cadre est réservée au rôle Assistante.'; end if;
  if v_on and cardinality(v_ids) = 0 then raise exception 'Choisissez au moins un médecin cadre.'; end if;
  if v_on and exists (select 1 from unnest(v_ids) c where not exists (select 1 from public.profiles p where p.id = c and p.role = 'cadre')) then
    raise exception 'Seuls des médecins cadres peuvent être choisis.';
  end if;
  delete from public.cadre_secretaries where secretary_id = p_user;
  if v_on then insert into public.cadre_secretaries (secretary_id, cadre_id) select p_user, c from unnest(v_ids) c; end if;
  update public.profiles set cadre_secretary = v_on where id = p_user;
  perform public.absence_diffusion_log_add(case when v_on then 'cadre_secretary_on' else 'cadre_secretary_off' end, p_user::text, jsonb_build_object('cadres', to_jsonb(case when v_on then v_ids else '{}'::uuid[] end)));
  return case when v_on then public.absence_ensure_tool(p_user) else public.tool_allowed(p_user, 'absences') end;
end;
$$;

-- Le changement de rôle remet à zéro les fonctions d'assistante (les lignes des cadres dont le rôle change restent, filtrées à la lecture)
create or replace function public.admin_set_role(p_user uuid, p_role text)
 returns void
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare cur text;
begin
  if not public.is_direction_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'Vous ne pouvez pas modifier votre propre rôle.';
  end if;
  if p_role not in ('member', 'clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'direction', 'nurse', 'admin') then
    raise exception 'Rôle inconnu : %', p_role;
  end if;
  select role into cur from public.profiles where id = p_user;
  if cur is null then raise exception 'Membre introuvable.'; end if;
  if public.current_role_name() = 'direction' and (p_role in ('admin', 'direction') or cur in ('admin', 'direction')) then
    raise exception 'Seul un administrateur donne ou retire les rôles admin et direction.' using errcode = '42501';
  end if;
  update public.profiles set role = p_role,
    cdc_clinics = case when p_role in ('cdc', 'cadre') then cdc_clinics else '{}' end,
    clinics = case when p_role in ('clinician', 'cdc', 'cadre') then clinics else '{}' end,
    absence_validator = case when p_role in ('cadre', 'direction') then absence_validator else false end,
    admin_lead = case when p_role = 'assistant' then admin_lead else false end,
    agenda_manager = case when p_role = 'assistant' then agenda_manager else false end,
    agenda_clinics = case when p_role = 'assistant' then agenda_clinics else '{}'::text[] end,
    cadre_secretary = case when p_role = 'assistant' then cadre_secretary else false end
    where id = p_user;
  if p_role <> 'assistant' then delete from public.cadre_secretaries where secretary_id = p_user; end if;
  if p_role not in ('cadre', 'direction') then delete from public.absence_validators where user_id = p_user; end if;
  delete from public.tool_access where user_id = p_user;
  perform public.absence_recheck();
end;
$function$;

-- Compléments de la liste des membres : nouvelles colonnes (le type de retour change)
do $$
begin
  if to_regprocedure('public.admin_members_extra()') is not null
     and not exists (select 1 from pg_proc where oid = to_regprocedure('public.admin_members_extra()') and 'cadre_secretary' = any (proargnames)) then
    drop function public.admin_members_extra();
  end if;
end $$;
create or replace function public.admin_members_extra() returns table (id uuid, admin_lead boolean, access_until date, created_by_name text,
  agenda_manager boolean, agenda_clinics text[], cadre_secretary boolean, secretary_of uuid[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return query select p.id, p.admin_lead, p.access_until, public.member_name(p.created_by), p.agenda_manager, p.agenda_clinics, p.cadre_secretary,
    coalesce(array(select cs.cadre_id from public.cadre_secretaries cs join public.profiles c on c.id = cs.cadre_id where cs.secretary_id = p.id and c.role = 'cadre' order by cs.cadre_id), '{}'::uuid[])
    from public.profiles p;
end;
$$;

-- 9. Administration : blocs et routage ------------------------------------------------------------------------------------

create or replace function public.admin_blocs_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'blocs', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'clinics', to_jsonb(b.clinics), 'email', b.email, 'lead_ids', to_jsonb(b.lead_ids),
        'leads', coalesce((select jsonb_agg(jsonb_build_object('id', l, 'name', public.member_name(l))) from unnest(b.lead_ids) l), '[]'::jsonb), 'pos', b.pos) order by b.pos, b.id)
      from public.absence_blocs b), '[]'::jsonb),
    'clinics', coalesce((select jsonb_agg(s.clinic order by s.pos) from public.absence_clinic_settings s where s.clinic <> 'Administration'), '[]'::jsonb),
    'leads', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', public.member_name(p.id)) order by lower(public.member_name(p.id)))
                         from public.profiles p where p.role = 'assistant' and p.admin_lead), '[]'::jsonb));
end;
$$;

create or replace function public.admin_bloc_save(p_id bigint, p_name text, p_clinics text[], p_email text, p_lead_ids uuid[]) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare nm text := btrim(coalesce(p_name, '')); cl text[]; em text := nullif(lower(btrim(coalesce(p_email, ''))), ''); leads uuid[]; bid bigint;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  if char_length(nm) not between 1 and 40 then raise exception 'Le nom du bloc compte de 1 à 40 caractères.'; end if;
  cl := public.absence_clinics_check(p_clinics);
  if em is not null and (char_length(em) > 254 or em !~ '^[^@[:space:],;<>]+@[^@[:space:],;<>]+\.[^@[:space:],;<>]+$') then raise exception 'Adresse e-mail invalide.'; end if;
  leads := coalesce(array(select distinct l from unnest(coalesce(p_lead_ids, '{}'::uuid[])) l where l is not null), '{}'::uuid[]);
  if exists (select 1 from unnest(leads) l where not exists (select 1 from public.profiles p where p.id = l and p.role = 'assistant' and p.admin_lead)) then
    raise exception 'Les responsables doivent être des cadres administratifs.';
  end if;
  if exists (select 1 from public.absence_blocs b where lower(b.name) = lower(nm) and b.id is distinct from p_id) then raise exception 'Un bloc porte déjà ce nom.'; end if;
  perform pg_advisory_xact_lock(hashtext('absence_blocs'));
  if p_id is null then
    insert into public.absence_blocs (name, clinics, email, lead_ids, pos) values (nm, cl, em, leads, coalesce((select max(pos) + 1 from public.absence_blocs), 0)) returning id into bid;
  else
    update public.absence_blocs set name = nm, clinics = cl, email = em, lead_ids = leads where id = p_id returning id into bid;
    if bid is null then raise exception 'Bloc introuvable.'; end if;
  end if;
  perform public.absence_diffusion_log_add(case when p_id is null then 'bloc_create' else 'bloc_update' end, bid::text,
    jsonb_build_object('name', nm, 'clinics', to_jsonb(cl), 'has_email', em is not null, 'leads', to_jsonb(leads)));
  return bid;
end;
$$;

create or replace function public.admin_bloc_delete(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare nm text;
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  delete from public.absence_blocs where id = p_id returning name into nm;
  if nm is null then raise exception 'Bloc introuvable.'; end if;
  perform public.absence_diffusion_log_add('bloc_delete', p_id::text, jsonb_build_object('name', nm));
end;
$$;

-- Médecin pouvant recevoir une diffusion
create or replace function public.absence_routing_target(p_user uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.profiles where id = p_user and role in ('clinician', 'cdc', 'cadre')) then raise exception 'Seuls les médecins ont un formulaire diffusé.'; end if;
end;
$$;

create or replace function public.admin_form_routing_get(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare lo date := public.ch_today(); d jsonb; eff jsonb; rt public.absence_form_routing; mem uuid[]; dmem uuid[];
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  perform public.absence_routing_target(p_user);
  d := public.absence_form_default(p_user, lo, lo);
  dmem := array(select (jsonb_array_elements_text(d -> 'members'))::uuid);
  eff := public.absence_form_effective(p_user, lo, lo);
  select * into rt from public.absence_form_routing where user_id = p_user;
  mem := array(select (jsonb_array_elements_text(eff -> 'members'))::uuid);
  return jsonb_build_object('user_id', p_user, 'name', public.member_name(p_user), 'role', (select role from public.profiles where id = p_user),
    'mode', rt.mode, 'emails', to_jsonb(coalesce(rt.emails, '{}'::text[])), 'member_ids', to_jsonb(coalesce(rt.member_ids, '{}'::uuid[])),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m, 'name', public.member_name(m))) from unnest(coalesce(rt.member_ids, '{}'::uuid[])) m), '[]'::jsonb),
    'default', jsonb_build_object('clinics', d -> 'clinics', 'blocs', d -> 'blocs',
       'members', coalesce((select jsonb_agg(jsonb_build_object('id', m, 'name', public.member_name(m))) from unnest(dmem) m), '[]'::jsonb)),
    'effective', jsonb_build_object('emails', eff -> 'emails',
       'members', coalesce((select jsonb_agg(jsonb_build_object('id', m, 'name', public.member_name(m))) from unnest(mem) m), '[]'::jsonb)));
end;
$$;

create or replace function public.admin_form_routing_set(p_user uuid, p_mode text, p_emails text[], p_members uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare em text[]; mem uuid[];
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  perform public.absence_routing_target(p_user);
  if p_mode is null or p_mode not in ('add', 'replace') then raise exception 'Mode inconnu.'; end if;
  em := coalesce(array(select distinct lower(btrim(x)) from unnest(coalesce(p_emails, '{}'::text[])) x where btrim(coalesce(x, '')) <> '' order by 1), '{}'::text[]);
  mem := coalesce(array(select distinct m from unnest(coalesce(p_members, '{}'::uuid[])) m where m is not null), '{}'::uuid[]);
  if cardinality(em) > 20 or cardinality(mem) > 20 then raise exception '20 adresses et 20 membres au plus.'; end if;
  if exists (select 1 from unnest(em) x where char_length(x) > 254 or x !~ '^[^@[:space:],;<>]+@[^@[:space:],;<>]+\.[^@[:space:],;<>]+$') then raise exception 'Adresse e-mail invalide.'; end if;
  if exists (select 1 from unnest(mem) m where not exists (select 1 from public.profiles p where p.id = m and p.role <> 'member')) then raise exception 'Membre introuvable.'; end if;
  if p_mode = 'add' and cardinality(em) = 0 and cardinality(mem) = 0 then
    delete from public.absence_form_routing where user_id = p_user;
  else
    insert into public.absence_form_routing (user_id, mode, emails, member_ids, updated_by, updated_at) values (p_user, p_mode, em, mem, auth.uid(), now())
      on conflict (user_id) do update set mode = excluded.mode, emails = excluded.emails, member_ids = excluded.member_ids, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  end if;
  perform public.absence_diffusion_log_add('routing_set', p_user::text, jsonb_build_object('mode', p_mode, 'emails', cardinality(em), 'members', to_jsonb(mem)));
end;
$$;

create or replace function public.admin_form_routing_delete(p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  delete from public.absence_form_routing where user_id = p_user;
  perform public.absence_diffusion_log_add('routing_delete', p_user::text, '{}'::jsonb);
end;
$$;

-- Vue d'ensemble : chaque médecin, ses blocs, sa personnalisation et le nombre de destinataires effectifs
create or replace function public.admin_form_routing_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare lo date := public.ch_today();
begin
  if not public.is_direction_admin() then raise exception 'Réservé à l''administration.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'name', public.member_name(p.id), 'role', p.role, 'clinics', to_jsonb(public.member_clinics(p.id, lo, lo)),
        'mode', rt.mode, 'custom_emails', coalesce(cardinality(rt.emails), 0), 'custom_members', coalesce(cardinality(rt.member_ids), 0),
        'blocs', (select coalesce(jsonb_agg(b ->> 'name'), '[]'::jsonb) from jsonb_array_elements(public.absence_form_default(p.id, lo, lo) -> 'blocs') b),
        'recipients', jsonb_array_length(public.absence_form_effective(p.id, lo, lo) -> 'emails') + jsonb_array_length(public.absence_form_effective(p.id, lo, lo) -> 'members'))
      order by lower(public.member_name(p.id)))
      from public.profiles p left join public.absence_form_routing rt on rt.user_id = p.id
     where p.role in ('clinician', 'cdc', 'cadre')), '[]'::jsonb);
end;
$$;

-- 10. Droits ----------------------------------------------------------------------------------------------------------------

-- Fonctions internes : jamais appelables par l'API
revoke execute on function
  public.absence_blocs_guard(), public.absence_member_active(uuid), public.is_secretary_of(uuid, uuid), public.absence_workday_list(date, date),
  public.absence_diffusion_log_add(text, text, jsonb), public.absence_clinics_check(text[]), public.absence_validators_calc(uuid, uuid),
  public.absence_submit_core(uuid, uuid), public.absence_request_change_core(uuid, uuid, bigint, text, text, text, date, date),
  public.absence_agenda_entry(bigint, date, date), public.absence_agenda_blocked(bigint, bigint, boolean), public.absence_agenda_void(bigint),
  public.absence_agenda_task_make(bigint, boolean), public.absence_agenda_after_document(), public.absence_form_default(uuid, date, date), public.absence_active_secretaries(uuid),
  public.absence_form_effective(uuid, date, date), public.absence_form_copy_queue(), public.absence_agenda_view(jsonb, boolean),
  public.absence_agenda_audience(uuid, bigint), public.absence_agenda_can(uuid, bigint), public.absence_ensure_tool(uuid), public.absence_routing_target(uuid),
  public.absence_form_freeze(), public.absence_enqueue(text, uuid, bigint[], jsonb), public.absence_my_validators_full(),
  public.notification_kinds_for(uuid)
  from public, anon, authenticated;

-- Fonctions de l'Edge Function
revoke execute on function public.absence_form_recipients(bigint), public.absence_agenda_mail(bigint), public.absence_notification_ids(uuid, bigint[], text), public.absence_form_access(uuid, bigint[])
  from public, anon, authenticated;
grant execute on function public.absence_form_recipients(bigint), public.absence_agenda_mail(bigint), public.absence_notification_ids(uuid, bigint[], text), public.absence_form_access(uuid, bigint[])
  to service_role;

-- Fonctions d'interface (membres connectés ; chaque fonction contrôle elle-même les droits)
revoke execute on function
  public.absence_my_validators_for(uuid), public.absence_request_for(uuid, text, text, date, date), public.absence_submit(), public.absence_submit_for(uuid),
  public.absence_withdraw_for(bigint), public.absence_request_change(bigint, text, text, text, date, date), public.absence_request_change_for(uuid, bigint, text, text, text, date, date),
  public.absence_agenda_context(), public.absence_agenda_pending_count(), public.absence_agenda_tasks_list(text), public.absence_agenda_set(bigint, boolean), public.absence_agenda_status(uuid),
  public.absence_can_see(uuid, date, date), public.absence_list(uuid), public.absence_approvals_all(uuid), public.absence_balance(uuid, int), public.absence_history(bigint),
  public.admin_set_agenda_manager(uuid, boolean, text[]), public.admin_set_cadre_secretary(uuid, boolean, uuid[]), public.admin_members_extra(),
  public.admin_blocs_list(), public.admin_bloc_save(bigint, text, text[], text, uuid[]), public.admin_bloc_delete(bigint),
  public.admin_form_routing_get(uuid), public.admin_form_routing_set(uuid, text, text[], uuid[]), public.admin_form_routing_delete(uuid), public.admin_form_routing_overview()
  from public, anon;
grant execute on function
  public.absence_my_validators_for(uuid), public.absence_request_for(uuid, text, text, date, date), public.absence_submit(), public.absence_submit_for(uuid),
  public.absence_withdraw_for(bigint), public.absence_request_change(bigint, text, text, text, date, date), public.absence_request_change_for(uuid, bigint, text, text, text, date, date),
  public.absence_agenda_context(), public.absence_agenda_pending_count(), public.absence_agenda_tasks_list(text), public.absence_agenda_set(bigint, boolean), public.absence_agenda_status(uuid),
  public.absence_can_see(uuid, date, date), public.absence_list(uuid), public.absence_approvals_all(uuid), public.absence_balance(uuid, int), public.absence_history(bigint),
  public.admin_set_agenda_manager(uuid, boolean, text[]), public.admin_set_cadre_secretary(uuid, boolean, uuid[]), public.admin_members_extra(),
  public.admin_blocs_list(), public.admin_bloc_save(bigint, text, text[], text, uuid[]), public.admin_bloc_delete(bigint),
  public.admin_form_routing_get(uuid), public.admin_form_routing_set(uuid, text, text[], uuid[]), public.admin_form_routing_overview()
  to authenticated;
grant execute on function public.admin_form_routing_delete(uuid) to authenticated;

do $$
begin
  insert into public.onconic_migrations(version) values ('202611180002') on conflict do nothing;
end $$;

commit;
