-- Oncoodle : sondages de dates et de participation pour les membres de The Hive (13.11.2026).
-- Outil ouvert à tous les membres validés (tous rôles sauf « member »), sans invités externes.
--
-- Principes
-- 1. Aucune table n'est lisible directement : RLS sans règle, tout passe par des fonctions qui contrôlent l'appelant.
-- 2. Destinataires = règles « clinique(s) ET fonction(s) » réunies (union), plus des personnes choisies une à une, moins des exclusions.
--    La liste est figée à la création ; le créateur peut ajouter des destinataires ensuite (jamais de retrait silencieux).
-- 3. Conflits : par créneau, nombre d'invités absents (absences validées, uniquement celles que l'appelant a le droit de voir dans
--    Absences, jamais de nom ni de motif) et entrées de l'agenda commun. Réservé aux usagers de l'outil Absences, sauf vacances scolaires.
-- 4. Envoi : file oncoodle_outbox vidée par la fonction Edge notify-oncoodle (même jeton Vault que notify-absence). Relances
--    automatiques et manuelles, jamais la nuit. Aucun texte libre de l'utilisateur dans les push.
-- 5. Abus : « tous les membres » réservé à l'admin et à la direction ; quota de 300 invitations par 24 h et par créateur.
-- 6. Agenda commun : jamais direct. Une demande (désactivée par défaut) attend l'approbation d'un·e autre admin ou membre de la direction.
-- 7. Conservation : sondages clos ou annulés supprimés après 180 jours ; sondages dont le dernier créneau date de plus de 180 jours aussi.
--
-- Partant des définitions en production après 202611130001. Transactionnel et réexécutable.
begin;

-- ===== 1. Accès à l'outil =====
alter table public.tool_access drop constraint if exists tool_access_tool_check;
alter table public.tool_access add constraint tool_access_tool_check
  check (tool in ('congres', 'trials', 'lettres', 'limitations', 'duree', 'medletters', 'annuaire', 'contacts', 'formation', 'absences', 'oncoodle')) not valid;

create or replace function public.tool_allowed(p_user uuid, p_tool text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare r text; i text; m boolean; o boolean;
begin
  select role, institution, med_plus into r, i, m from public.profiles where id = p_user;
  if r is null or r = 'member' then return false; end if;
  if r = 'admin' then return true; end if;
  if p_tool = 'absences' and coalesce(i, '') <> 'CHUV' then return false; end if;
  if r = 'direction' then return p_tool in ('absences', 'congres', 'formation', 'annuaire', 'contacts', 'oncoodle'); end if;
  if p_tool = 'medletters' then return r in ('clinician', 'cdc', 'cadre', 'pharmacist') and coalesce(m, false); end if;
  select allowed into o from public.tool_access where user_id = p_user and tool = p_tool;
  if found then return o; end if;
  i := coalesce(i, '');
  return case p_tool
    when 'absences' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist')
    when 'congres' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist')
    when 'trials' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse')
    when 'formation' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse')
    when 'annuaire' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse') and i = 'CHUV'
    when 'contacts' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse') and i = 'CHUV'
    when 'lettres' then r = 'pharmacist' or (r in ('clinician', 'cdc', 'cadre', 'assistant') and i = 'CHUV')
    when 'limitations' then r in ('clinician', 'cdc', 'cadre', 'pharmacist')
    when 'duree' then r = 'pharmacist' or (r in ('assistant', 'clinician', 'cdc', 'cadre', 'nurse') and i = 'CHUV')
    when 'oncoodle' then true
    else false end;
end;
$$;
revoke execute on function public.tool_allowed(uuid, text) from public, anon, authenticated;

create or replace function public.my_tools()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(t), '{}') from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'medletters', 'annuaire', 'contacts', 'formation', 'absences', 'oncoodle']) t
  where public.tool_allowed(auth.uid(), t);
$$;
revoke execute on function public.my_tools() from public, anon;
grant execute on function public.my_tools() to authenticated;

-- ===== 2. Tables =====
create table if not exists public.oncoodle_polls (
  id bigint generated always as identity primary key,
  created_by uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('slots', 'rsvp')),
  title text not null check (char_length(title) between 3 and 150),
  description text check (char_length(description) <= 1000),
  location text check (char_length(location) <= 200),
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  deadline timestamptz,
  visibility text not null default 'all' check (visibility in ('all', 'creator')),
  audience jsonb not null default '{}',
  final_option_id bigint,
  final_message text check (char_length(final_message) <= 500),
  closed_at timestamptz,
  reminded_at timestamptz,
  auto_reminded_at timestamptz,
  deadline_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists oncoodle_polls_creator on public.oncoodle_polls (created_by, created_at desc);
create index if not exists oncoodle_polls_status on public.oncoodle_polls (status, deadline);

create table if not exists public.oncoodle_options (
  id bigint generated always as identity primary key,
  poll_id bigint not null references public.oncoodle_polls (id) on delete cascade,
  day date not null,
  start_time time,
  end_time time,
  check ((start_time is null) = (end_time is null)),
  check (end_time is null or end_time > start_time)
);
create unique index if not exists oncoodle_options_unique
  on public.oncoodle_options (poll_id, day, coalesce(start_time, time '00:00'), coalesce(end_time, time '00:00'));

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'oncoodle_polls_final_option_fk') then
    alter table public.oncoodle_polls add constraint oncoodle_polls_final_option_fk
      foreign key (final_option_id) references public.oncoodle_options (id) on delete set null;
  end if;
end $$;

create table if not exists public.oncoodle_invitees (
  poll_id bigint not null references public.oncoodle_polls (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  required boolean not null default false,
  via text,
  comment text check (char_length(comment) <= 300),
  responded_at timestamptz,
  invited_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);
create index if not exists oncoodle_invitees_user on public.oncoodle_invitees (user_id);

create table if not exists public.oncoodle_votes (
  option_id bigint not null references public.oncoodle_options (id) on delete cascade,
  poll_id bigint not null,
  user_id uuid not null,
  answer text not null check (answer in ('yes', 'maybe', 'no')),
  updated_at timestamptz not null default now(),
  primary key (option_id, user_id),
  foreign key (poll_id, user_id) references public.oncoodle_invitees (poll_id, user_id) on delete cascade
);
create index if not exists oncoodle_votes_poll on public.oncoodle_votes (poll_id, user_id);

create table if not exists public.oncoodle_outbox (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('invite', 'updated', 'reminder', 'closed', 'cancelled', 'all_responded', 'deadline', 'calendar_proposal')),
  poll_id bigint not null references public.oncoodle_polls (id) on delete cascade,
  recipient uuid references auth.users (id) on delete cascade,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts int not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  skipped_at timestamptz,
  last_error text
);
create unique index if not exists oncoodle_outbox_once on public.oncoodle_outbox (poll_id, recipient, kind)
  where kind in ('invite', 'all_responded', 'deadline');
create index if not exists oncoodle_outbox_pending on public.oncoodle_outbox (next_attempt_at) where sent_at is null and skipped_at is null;

-- Demandes d'ajout à l'agenda commun (jamais direct) : une par sondage, approuvée ou refusée par un·e autre admin ou membre de la direction
create table if not exists public.oncoodle_calendar_requests (
  id bigint generated always as identity primary key,
  poll_id bigint not null unique references public.oncoodle_polls (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete cascade,
  label text not null check (char_length(label) between 2 and 120),
  day date not null,
  start_time time,
  end_time time,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.oncoodle_calendar_requests enable row level security;
revoke all on public.oncoodle_calendar_requests from anon, authenticated;

alter table public.profiles add column if not exists oncoodle_email boolean not null default true;

alter table public.oncoodle_polls enable row level security;
alter table public.oncoodle_options enable row level security;
alter table public.oncoodle_invitees enable row level security;
alter table public.oncoodle_votes enable row level security;
alter table public.oncoodle_outbox enable row level security;
revoke all on public.oncoodle_polls, public.oncoodle_options, public.oncoodle_invitees, public.oncoodle_votes, public.oncoodle_outbox from anon, authenticated;

-- ===== 3. Fonctions internes =====
create or replace function public.oncoodle_guard() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.tool_allowed(auth.uid(), 'oncoodle') then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.oncoodle_role_label(p text) returns text language sql immutable set search_path = public as $$
  select case p when 'clinician' then 'Médecins assistants' when 'cdc' then 'Chefs de clinique' when 'cadre' then 'Médecins cadres'
    when 'assistant' then 'Assistantes médicales' when 'nurse' then 'Infirmier·ères' when 'pharmacist' then 'Pharmaciens'
    when 'direction' then 'Direction' when 'admin' then 'Administrateurs' else p end;
$$;

create or replace function public.oncoodle_parse_date(p text) returns date language plpgsql immutable set search_path = public as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p::date;
exception when others then return null;
end;
$$;

create or replace function public.oncoodle_parse_time(p text) returns time language plpgsql immutable set search_path = public as $$
begin
  if p is null or p !~ '^\d{2}:\d{2}$' then return null; end if;
  return p::time;
exception when others then return null;
end;
$$;

create or replace function public.oncoodle_text_array(j jsonb) returns text[] language plpgsql immutable set search_path = public as $$
begin
  if j is null or jsonb_typeof(j) = 'null' then return '{}'; end if;
  if jsonb_typeof(j) <> 'array' then raise exception 'Destinataires invalides.'; end if;
  return coalesce(array(select jsonb_array_elements_text(j)), '{}');
end;
$$;

create or replace function public.oncoodle_uuid_array(j jsonb) returns uuid[] language plpgsql immutable set search_path = public as $$
begin
  return coalesce(array(select distinct x::uuid from unnest(public.oncoodle_text_array(j)) x), '{}');
exception when invalid_text_representation then
  raise exception 'Destinataires invalides.';
end;
$$;

-- Normalise et valide un descripteur de destinataires :
-- { rules: [{ all: true } | { clinics: [..], roles: [..] }], users: [uuid], exclude: [uuid] }
create or replace function public.oncoodle_check_audience(p_aud jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rules jsonb := '[]'; r jsonb; cl text[]; ro text[]; us uuid[]; ex uuid[]; bad text;
begin
  if p_aud is null or jsonb_typeof(p_aud) <> 'object' then raise exception 'Destinataires invalides.'; end if;
  if jsonb_typeof(coalesce(p_aud->'rules', '[]')) <> 'array' then raise exception 'Destinataires invalides.'; end if;
  if jsonb_array_length(coalesce(p_aud->'rules', '[]')) > 20 then raise exception 'Trop de groupes (20 au maximum).'; end if;
  for r in select value from jsonb_array_elements(coalesce(p_aud->'rules', '[]')) loop
    if jsonb_typeof(r) <> 'object' then raise exception 'Destinataires invalides.'; end if;
    if coalesce(r->>'all', 'false') = 'true' then
      if not public.is_direction_admin() then raise exception 'Seuls l''admin et la direction peuvent inviter tous les membres.'; end if;
      rules := rules || jsonb_build_array(jsonb_build_object('all', true));
    else
      cl := array(select distinct c from unnest(public.oncoodle_text_array(r->'clinics')) c order by c);
      ro := array(select distinct c from unnest(public.oncoodle_text_array(r->'roles')) c order by c);
      select c into bad from unnest(cl) c where c not in (select clinic from public.absence_clinic_settings) limit 1;
      if bad is not null then raise exception 'Clinique inconnue : %', bad; end if;
      select c into bad from unnest(ro) c where c not in ('clinician', 'cdc', 'cadre', 'assistant', 'nurse', 'pharmacist', 'direction', 'admin') limit 1;
      if bad is not null then raise exception 'Fonction inconnue : %', bad; end if;
      if cardinality(cl) = 0 and cardinality(ro) = 0 then
        raise exception 'Un groupe doit préciser au moins une clinique ou une fonction.';
      end if;
      rules := rules || jsonb_build_array(jsonb_build_object('clinics', to_jsonb(cl), 'roles', to_jsonb(ro)));
    end if;
  end loop;
  us := public.oncoodle_uuid_array(p_aud->'users');
  ex := public.oncoodle_uuid_array(p_aud->'exclude');
  if cardinality(us) > 500 or cardinality(ex) > 500 then raise exception 'Trop de personnes sélectionnées (500 au maximum).'; end if;
  return jsonb_build_object('rules', rules, 'users', to_jsonb(us), 'exclude', to_jsonb(ex));
end;
$$;

-- Membres atteints par un descripteur normalisé (membres validés disposant de l'outil, moins les exclusions)
create or replace function public.oncoodle_resolve(p_aud jsonb) returns table(user_id uuid, via text)
language sql stable security definer set search_path = public as $$
  with mem as (
    select p.id, p.role, coalesce(public.member_clinics(p.id), '{}') as cl
    from public.profiles p where p.role <> 'member' and public.tool_allowed(p.id, 'oncoodle')
  ),
  ind as (
    select m.id, 'Individuel'::text as via, 0::bigint as ord from mem m
    where m.id::text in (select jsonb_array_elements_text(coalesce(p_aud->'users', '[]')))
  ),
  rl as (
    select m.id,
      case when coalesce(r.value->>'all', 'false') = 'true' then 'Tous les membres'
           else concat_ws(' · ',
             nullif(array_to_string(array(select jsonb_array_elements_text(r.value->'clinics')), ', '), ''),
             nullif(array_to_string(array(select public.oncoodle_role_label(x) from jsonb_array_elements_text(r.value->'roles') x), ', '), '')) end as via,
      r.ord::bigint as ord
    from mem m
    cross join lateral jsonb_array_elements(coalesce(p_aud->'rules', '[]')) with ordinality as r(value, ord)
    where coalesce(r.value->>'all', 'false') = 'true'
       or ((coalesce(jsonb_array_length(r.value->'clinics'), 0) > 0 or coalesce(jsonb_array_length(r.value->'roles'), 0) > 0)
           and (coalesce(jsonb_array_length(r.value->'clinics'), 0) = 0 or m.cl && array(select jsonb_array_elements_text(r.value->'clinics')))
           and (coalesce(jsonb_array_length(r.value->'roles'), 0) = 0 or m.role in (select jsonb_array_elements_text(r.value->'roles'))))
  ),
  allr as (select id, via, ord from ind union all select id, via, ord from rl)
  select a.id, (array_agg(a.via order by a.ord))[1]
  from allr a
  where a.id::text not in (select jsonb_array_elements_text(coalesce(p_aud->'exclude', '[]')))
  group by a.id;
$$;

-- Prochain moment d'envoi pour une relance : de 08 h à 18 h 59 (heure de Zurich), sinon 08 h le jour suivant ou même jour
create or replace function public.oncoodle_next_send(p_at timestamptz default now()) returns timestamptz
language sql stable set search_path = public as $$
  select case
    when extract(hour from p_at at time zone 'Europe/Zurich') between 8 and 18 then p_at
    when extract(hour from p_at at time zone 'Europe/Zurich') < 8 then (date_trunc('day', p_at at time zone 'Europe/Zurich') + interval '8 hours') at time zone 'Europe/Zurich'
    else (date_trunc('day', p_at at time zone 'Europe/Zurich') + interval '1 day 8 hours') at time zone 'Europe/Zurich' end;
$$;

create or replace function public.oncoodle_last_day(p_poll bigint) returns date language sql stable security definer set search_path = public as $$
  select max(day) from public.oncoodle_options where poll_id = p_poll;
$$;

-- Valide un tableau d'options et renvoie les lignes (day, start_time, end_time)
create or replace function public.oncoodle_parse_options(p_opts jsonb) returns table(day date, start_time time, end_time time)
language plpgsql stable security definer set search_path = public as $$
declare o jsonb; d date; s time; e time; today date := public.ch_today();
begin
  if p_opts is null or jsonb_typeof(p_opts) <> 'array' then raise exception 'Créneaux invalides.'; end if;
  if jsonb_array_length(p_opts) > 40 then raise exception 'Trop de créneaux (40 au maximum).'; end if;
  for o in select value from jsonb_array_elements(p_opts) loop
    if jsonb_typeof(o) <> 'object' then raise exception 'Créneaux invalides.'; end if;
    d := public.oncoodle_parse_date(o->>'day');
    if d is null then raise exception 'Date invalide.'; end if;
    if d < today then raise exception 'Un créneau ne peut pas être dans le passé.'; end if;
    if d > today + 730 then raise exception 'Un créneau ne peut pas dépasser deux ans.'; end if;
    s := public.oncoodle_parse_time(nullif(o->>'start', ''));
    e := public.oncoodle_parse_time(nullif(o->>'end', ''));
    if (s is null) <> (e is null) then raise exception 'Indiquez une heure de début et une heure de fin, ou aucune.'; end if;
    if e is not null and e <= s then raise exception 'L''heure de fin doit suivre l''heure de début.'; end if;
    day := d; start_time := s; end_time := e;
    return next;
  end loop;
end;
$$;

-- Quota d'invitations : 300 par créateur et par 24 h (invitations mises en file, y compris les ajouts de destinataires)
create or replace function public.oncoodle_daily_quota() returns int language sql immutable set search_path = public as $$ select 300; $$;
create or replace function public.oncoodle_check_quota(p_user uuid) returns void language plpgsql stable security definer set search_path = public as $$
declare n int;
begin
  select count(*)::int into n from public.oncoodle_outbox o join public.oncoodle_polls p on p.id = o.poll_id
    where p.created_by = p_user and o.kind = 'invite' and o.created_at > now() - interval '24 hours';
  if n > public.oncoodle_daily_quota() then
    raise exception 'Quota atteint : % invitations par 24 heures au maximum. Réessayez plus tard ou réduisez les destinataires.', public.oncoodle_daily_quota();
  end if;
end;
$$;

-- ===== 4. Annuaire et aperçu des destinataires =====
create or replace function public.oncoodle_people() returns table(id uuid, name text, role text, clinics text[], is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.oncoodle_guard();
  return query
    select p.id, public.member_name(p.id), p.role, coalesce(public.member_clinics(p.id), '{}'), p.id = auth.uid()
    from public.profiles p
    where p.role <> 'member' and public.tool_allowed(p.id, 'oncoodle')
    order by lower(public.member_name(p.id));
end;
$$;

create or replace function public.oncoodle_audience_preview(p_audience jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a jsonb; n int;
begin
  perform public.oncoodle_guard();
  a := public.oncoodle_check_audience(p_audience);
  select count(*) into n from public.oncoodle_resolve(a);
  return jsonb_build_object('count', n, 'truncated', n > 400, 'members', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.user_id, 'name', x.nm, 'role', x.role, 'via', x.via) order by lower(x.nm))
    from (select r.user_id, public.member_name(r.user_id) as nm, p.role, r.via
          from public.oncoodle_resolve(a) r join public.profiles p on p.id = r.user_id
          order by lower(public.member_name(r.user_id)) limit 400) x), '[]'));
end;
$$;

-- ===== 5. Création et modification =====
create or replace function public.oncoodle_create(p_poll jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); k text; t text; d text; l text; vis text; dl timestamptz; aud jsonb; inc boolean;
  pid bigint; n int; req uuid[]; total int; others int;
begin
  perform public.oncoodle_guard();
  if p_poll is null or jsonb_typeof(p_poll) <> 'object' then raise exception 'Sondage invalide.'; end if;
  k := p_poll->>'kind';
  if k not in ('slots', 'rsvp') then raise exception 'Type de sondage inconnu.'; end if;
  t := btrim(coalesce(p_poll->>'title', ''));
  d := nullif(btrim(coalesce(p_poll->>'description', '')), '');
  l := nullif(btrim(coalesce(p_poll->>'location', '')), '');
  if char_length(t) < 3 or char_length(t) > 150 then raise exception 'Le titre doit compter de 3 à 150 caractères.'; end if;
  if t ~ '[\r\n]' or coalesce(l, '') ~ '[\r\n]' then raise exception 'Le titre et le lieu tiennent sur une seule ligne.'; end if;
  if char_length(coalesce(d, '')) > 1000 then raise exception 'La description est limitée à 1000 caractères.'; end if;
  if char_length(coalesce(l, '')) > 200 then raise exception 'Le lieu est limité à 200 caractères.'; end if;
  vis := coalesce(nullif(p_poll->>'visibility', ''), 'all');
  if vis not in ('all', 'creator') then raise exception 'Visibilité inconnue.'; end if;
  if nullif(p_poll->>'deadline', '') is not null then
    begin dl := (p_poll->>'deadline')::timestamptz;
    exception when others then raise exception 'Échéance invalide.'; end;
    if dl < now() + interval '5 minutes' then raise exception 'L''échéance doit être dans le futur.'; end if;
    if dl > now() + interval '400 days' then raise exception 'L''échéance est trop lointaine.'; end if;
  end if;
  select count(*) into n from public.oncoodle_polls where created_by = uid and created_at > now() - interval '24 hours';
  if n >= 10 then raise exception 'Limite atteinte : 10 sondages par 24 heures.'; end if;
  select count(*) into n from public.oncoodle_polls where created_by = uid and status = 'open';
  if n >= 40 then raise exception 'Limite atteinte : 40 sondages ouverts. Clôturez ou supprimez-en.'; end if;

  aud := public.oncoodle_check_audience(p_poll->'audience');
  inc := coalesce(p_poll->>'include_me', 'true') <> 'false';

  insert into public.oncoodle_polls (created_by, kind, title, description, location, deadline, visibility, audience)
    values (uid, k, t, d, l, dl, vis, aud || jsonb_build_object('include_me', inc)) returning id into pid;

  insert into public.oncoodle_options (poll_id, day, start_time, end_time)
    select pid, o.day, o.start_time, o.end_time from public.oncoodle_parse_options(p_poll->'options') o on conflict do nothing;
  select count(*) into n from public.oncoodle_options where poll_id = pid;
  if k = 'rsvp' and n <> 1 then raise exception 'Un sondage de participation compte exactement une date.'; end if;
  if k = 'slots' and n < 2 then raise exception 'Proposez au moins deux créneaux (sinon utilisez un sondage de participation).'; end if;

  insert into public.oncoodle_invitees (poll_id, user_id, via)
    select pid, r.user_id, r.via from public.oncoodle_resolve(aud) r where r.user_id <> uid;
  if inc then
    insert into public.oncoodle_invitees (poll_id, user_id, via) values (pid, uid, 'Organisateur') on conflict do nothing;
  end if;
  select count(*) into total from public.oncoodle_invitees where poll_id = pid;
  select count(*) into others from public.oncoodle_invitees where poll_id = pid and user_id <> uid;
  if others = 0 then raise exception 'Aucun destinataire : ajoutez au moins une personne autre que vous.'; end if;
  if total > 300 then raise exception 'Trop de destinataires (300 au maximum).'; end if;

  req := public.oncoodle_uuid_array(p_poll->'required');
  update public.oncoodle_invitees set required = true where poll_id = pid and user_id = any (req);

  insert into public.oncoodle_outbox (kind, poll_id, recipient)
    select 'invite', pid, i.user_id from public.oncoodle_invitees i where i.poll_id = pid and i.user_id <> uid on conflict do nothing;
  perform public.oncoodle_check_quota(uid);
  return pid;
end;
$$;

create or replace function public.oncoodle_update(p_poll bigint, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); p public.oncoodle_polls; c jsonb := coalesce(p_changes, '{}'); n int; opts_changed boolean := false;
  dl timestamptz; aud jsonb; added int := 0; ids bigint[]; rm uuid[]; rq jsonb; x jsonb; prior uuid[];
begin
  perform public.oncoodle_guard();
  if jsonb_typeof(c) <> 'object' then raise exception 'Modification invalide.'; end if;
  select * into p from public.oncoodle_polls where id = p_poll for update;
  if p.id is null or p.created_by <> uid then raise exception 'Sondage introuvable.'; end if;
  if p.status <> 'open' then raise exception 'Un sondage clos ou annulé ne peut plus être modifié.'; end if;
  -- Ceux qui ont déjà répondu sont prévenus d'un changement de créneaux (les autres verront les nouveautés à leur première réponse)
  prior := array(select user_id from public.oncoodle_invitees where poll_id = p_poll and responded_at is not null and user_id <> uid);

  if c ? 'title' then
    if char_length(btrim(coalesce(c->>'title', ''))) not between 3 and 150 then raise exception 'Le titre doit compter de 3 à 150 caractères.'; end if;
    if c->>'title' ~ '[\r\n]' then raise exception 'Le titre et le lieu tiennent sur une seule ligne.'; end if;
    update public.oncoodle_polls set title = btrim(c->>'title') where id = p_poll;
  end if;
  if c ? 'description' then
    if char_length(coalesce(c->>'description', '')) > 1000 then raise exception 'La description est limitée à 1000 caractères.'; end if;
    update public.oncoodle_polls set description = nullif(btrim(coalesce(c->>'description', '')), '') where id = p_poll;
  end if;
  if c ? 'location' then
    if char_length(coalesce(c->>'location', '')) > 200 then raise exception 'Le lieu est limité à 200 caractères.'; end if;
    if coalesce(c->>'location', '') ~ '[\r\n]' then raise exception 'Le titre et le lieu tiennent sur une seule ligne.'; end if;
    update public.oncoodle_polls set location = nullif(btrim(coalesce(c->>'location', '')), '') where id = p_poll;
  end if;
  if c ? 'visibility' then
    if c->>'visibility' not in ('all', 'creator') then raise exception 'Visibilité inconnue.'; end if;
    update public.oncoodle_polls set visibility = c->>'visibility' where id = p_poll;
  end if;
  if c ? 'deadline' then
    if nullif(c->>'deadline', '') is null then dl := null;
    else
      begin dl := (c->>'deadline')::timestamptz; exception when others then raise exception 'Échéance invalide.'; end;
      if dl < now() + interval '5 minutes' then raise exception 'L''échéance doit être dans le futur.'; end if;
      if dl > now() + interval '400 days' then raise exception 'L''échéance est trop lointaine.'; end if;
    end if;
    update public.oncoodle_polls set deadline = dl, deadline_notified_at = null, auto_reminded_at = null where id = p_poll;
  end if;

  -- Créneaux : retraits (les réponses sur ces créneaux disparaissent) puis ajouts
  if c ? 'remove_options' then
    ids := coalesce(array(select (x2)::bigint from jsonb_array_elements_text(c->'remove_options') x2), '{}');
    delete from public.oncoodle_options where poll_id = p_poll and id = any (ids);
    get diagnostics n = row_count;
    if n > 0 then opts_changed := true; end if;
  end if;
  if c ? 'add_options' then
    insert into public.oncoodle_options (poll_id, day, start_time, end_time)
      select p_poll, o.day, o.start_time, o.end_time from public.oncoodle_parse_options(c->'add_options') o on conflict do nothing;
    get diagnostics n = row_count;
    if n > 0 then opts_changed := true; end if;
  end if;
  select count(*) into n from public.oncoodle_options where poll_id = p_poll;
  if n > 40 then raise exception 'Trop de créneaux (40 au maximum).'; end if;
  if p.kind = 'rsvp' and n <> 1 then raise exception 'Un sondage de participation compte exactement une date.'; end if;
  if p.kind = 'slots' and n < 2 then raise exception 'Un sondage de dates compte au moins deux créneaux.'; end if;
  if opts_changed then
    -- Réponses incomplètes après retrait : ceux qui n'ont plus aucune réponse redeviennent « à répondre »
    update public.oncoodle_invitees i set responded_at = null
      where i.poll_id = p_poll and i.responded_at is not null and not exists (select 1 from public.oncoodle_votes v where v.poll_id = p_poll and v.user_id = i.user_id);
  end if;

  -- Destinataires : ajouts (jamais de retrait silencieux) puis retraits explicites
  if c ? 'add_audience' then
    aud := public.oncoodle_check_audience(c->'add_audience');
    with ins as (
      insert into public.oncoodle_invitees (poll_id, user_id, via)
        select p_poll, r.user_id, r.via from public.oncoodle_resolve(aud) r on conflict do nothing returning user_id
    ), q as (
      insert into public.oncoodle_outbox (kind, poll_id, recipient) select 'invite', p_poll, user_id from ins where user_id <> uid on conflict do nothing returning 1
    )
    select count(*) into added from ins;
    select count(*) into n from public.oncoodle_invitees where poll_id = p_poll;
    if n > 300 then raise exception 'Trop de destinataires (300 au maximum).'; end if;
    perform public.oncoodle_check_quota(uid);
  end if;
  if c ? 'remove_users' then
    rm := public.oncoodle_uuid_array(c->'remove_users');
    delete from public.oncoodle_invitees where poll_id = p_poll and user_id = any (rm) and user_id <> uid;
    delete from public.oncoodle_outbox where poll_id = p_poll and recipient = any (rm) and sent_at is null and skipped_at is null;
  end if;
  if c ? 'set_required' then
    rq := c->'set_required';
    if jsonb_typeof(rq) <> 'array' then raise exception 'Modification invalide.'; end if;
    for x in select value from jsonb_array_elements(rq) loop
      update public.oncoodle_invitees set required = coalesce(x->>'required', 'false') = 'true'
        where poll_id = p_poll and user_id = (public.oncoodle_uuid_array(jsonb_build_array(x->>'user_id')))[1];
    end loop;
  end if;

  -- Les invités qui avaient déjà répondu sont prévenus d'un changement de créneaux
  if opts_changed then
    insert into public.oncoodle_outbox (kind, poll_id, recipient)
      select 'updated', p_poll, i.user_id from public.oncoodle_invitees i where i.poll_id = p_poll and i.user_id = any (prior);
  end if;
  update public.oncoodle_polls set updated_at = now() where id = p_poll;
  return jsonb_build_object('added_invitees', added, 'options_changed', opts_changed);
end;
$$;

-- ===== 6. Réponses =====
create or replace function public.oncoodle_vote(p_poll bigint, p_votes jsonb, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); p public.oncoodle_polls; v jsonb; oid bigint; a text; n int; cm text := nullif(btrim(coalesce(p_comment, '')), '');
  creator_notify boolean;
begin
  perform public.oncoodle_guard();
  select * into p from public.oncoodle_polls where id = p_poll;
  if p.id is null or not exists (select 1 from public.oncoodle_invitees where poll_id = p_poll and user_id = uid) then
    raise exception 'Sondage introuvable.';
  end if;
  if p.status <> 'open' then raise exception 'Ce sondage n''accepte plus de réponses.'; end if;
  if p.deadline is not null and p.deadline <= now() then raise exception 'L''échéance est passée : les réponses sont closes.'; end if;
  if char_length(coalesce(cm, '')) > 300 then raise exception 'Le commentaire est limité à 300 caractères.'; end if;
  if p_votes is null or jsonb_typeof(p_votes) <> 'array' then raise exception 'Réponses invalides.'; end if;
  if jsonb_array_length(p_votes) > 40 then raise exception 'Réponses invalides.'; end if;
  for v in select value from jsonb_array_elements(p_votes) loop
    if jsonb_typeof(v) <> 'object' or coalesce(v->>'option_id', '') !~ '^\d{1,18}$' then raise exception 'Réponses invalides.'; end if;
    oid := (v->>'option_id')::bigint;
    if not exists (select 1 from public.oncoodle_options where id = oid and poll_id = p_poll) then raise exception 'Créneau inconnu.'; end if;
    a := nullif(v->>'answer', '');
    if a is null then
      delete from public.oncoodle_votes where option_id = oid and user_id = uid;
    elsif a in ('yes', 'maybe', 'no') then
      insert into public.oncoodle_votes (option_id, poll_id, user_id, answer) values (oid, p_poll, uid, a)
        on conflict (option_id, user_id) do update set answer = excluded.answer, updated_at = now();
    else
      raise exception 'Réponse invalide.';
    end if;
  end loop;
  select count(*) into n from public.oncoodle_votes where poll_id = p_poll and user_id = uid;
  update public.oncoodle_invitees set comment = cm, responded_at = case when n > 0 then coalesce(responded_at, now()) else null end
    where poll_id = p_poll and user_id = uid;

  -- Tout le monde a répondu : le créateur est prévenu une seule fois
  if p.created_by <> uid and not exists (select 1 from public.oncoodle_invitees where poll_id = p_poll and responded_at is null) then
    insert into public.oncoodle_outbox (kind, poll_id, recipient) values ('all_responded', p_poll, p.created_by) on conflict do nothing;
  end if;
end;
$$;

-- ===== 7. Lecture =====
create or replace function public.oncoodle_list() returns table(
  id bigint, kind text, title text, status text, deadline timestamptz, creator_id uuid, creator text, is_creator boolean,
  invited boolean, answered boolean, needs_answer boolean, n_invited int, n_responded int,
  first_day date, last_day date, final_day date, final_start text, final_end text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.oncoodle_guard();
  return query
    select p.id, p.kind, p.title, p.status, p.deadline, p.created_by, public.member_name(p.created_by), p.created_by = auth.uid(),
      me.user_id is not null, me.responded_at is not null,
      me.user_id is not null and me.responded_at is null and p.status = 'open' and (p.deadline is null or p.deadline > now()),
      (select count(*)::int from public.oncoodle_invitees i where i.poll_id = p.id),
      (select count(*)::int from public.oncoodle_invitees i where i.poll_id = p.id and i.responded_at is not null),
      (select min(o.day) from public.oncoodle_options o where o.poll_id = p.id),
      (select max(o.day) from public.oncoodle_options o where o.poll_id = p.id),
      f.day, to_char(f.start_time, 'HH24:MI'), to_char(f.end_time, 'HH24:MI'), p.created_at
    from public.oncoodle_polls p
    left join public.oncoodle_invitees me on me.poll_id = p.id and me.user_id = auth.uid()
    left join public.oncoodle_options f on f.id = p.final_option_id
    where p.created_by = auth.uid() or me.user_id is not null
    order by (p.status = 'open') desc, p.created_at desc
    limit 300;
end;
$$;

create or replace function public.oncoodle_pending_count() returns int
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.tool_allowed(auth.uid(), 'oncoodle') then return 0; end if;
  return (select count(*)::int from public.oncoodle_invitees i join public.oncoodle_polls p on p.id = i.poll_id
          where i.user_id = auth.uid() and i.responded_at is null and p.status = 'open' and (p.deadline is null or p.deadline > now()));
end;
$$;

create or replace function public.oncoodle_get(p_poll bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); p public.oncoodle_polls; me public.oncoodle_invitees; is_cr boolean; can_abs boolean;
  opts jsonb; invs jsonb := '[]'; mine jsonb := null; n_inv int; n_resp int;
begin
  perform public.oncoodle_guard();
  select * into p from public.oncoodle_polls where id = p_poll;
  select * into me from public.oncoodle_invitees where poll_id = p_poll and user_id = uid;
  is_cr := p.created_by = uid;
  if p.id is null or (not is_cr and me.user_id is null) then raise exception 'Sondage introuvable.'; end if;
  can_abs := public.tool_allowed(uid, 'absences');

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'day', o.day, 'start', to_char(o.start_time, 'HH24:MI'), 'end', to_char(o.end_time, 'HH24:MI'),
      'yes', t.yes, 'maybe', t.maybe, 'no', t.no, 'req_yes', t.req_yes, 'req_maybe', t.req_maybe, 'req_no', t.req_no,
      'absent', case when can_abs then ab.n else null end, 'absent_req', case when can_abs then ab.nreq else null end,
      'mine_absent', (select a.status from public.absences a where a.user_id = uid and a.status in ('requested', 'approved')
                       and o.day between a.start_date and a.end_date order by (a.status = 'approved') desc limit 1),
      'cal', (select coalesce(jsonb_agg(c.label order by c.kind desc, c.label), '[]') from public.absence_calendar c
              where o.day between c.start_date and c.end_date and (can_abs or c.kind = 'vacances_scolaires'))
    ) order by o.day, o.start_time nulls first, o.id), '[]')
  into opts
  from public.oncoodle_options o
  cross join lateral (
    select count(*) filter (where v.answer = 'yes')::int as yes, count(*) filter (where v.answer = 'maybe')::int as maybe,
           count(*) filter (where v.answer = 'no')::int as no,
           count(*) filter (where v.answer = 'yes' and i.required)::int as req_yes, count(*) filter (where v.answer = 'maybe' and i.required)::int as req_maybe,
           count(*) filter (where v.answer = 'no' and i.required)::int as req_no
    from public.oncoodle_votes v join public.oncoodle_invitees i on i.poll_id = v.poll_id and i.user_id = v.user_id
    where v.option_id = o.id) t
  cross join lateral (
    select count(distinct i.user_id)::int as n, (count(distinct i.user_id) filter (where i.required))::int as nreq
    from public.oncoodle_invitees i join public.absences a on a.user_id = i.user_id
    where i.poll_id = o.poll_id and a.status = 'approved' and o.day between a.start_date and a.end_date
      and can_abs and public.absence_can_see(a.user_id, o.day, o.day)) ab
  where o.poll_id = p_poll;

  select count(*)::int, (count(*) filter (where responded_at is not null))::int into n_inv, n_resp from public.oncoodle_invitees where poll_id = p_poll;

  if is_cr or p.visibility = 'all' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', i.user_id, 'name', public.member_name(i.user_id), 'role', pr.role, 'required', i.required, 'responded', i.responded_at is not null,
        'comment', i.comment,
        'votes', coalesce((select jsonb_object_agg(v.option_id::text, v.answer) from public.oncoodle_votes v where v.poll_id = i.poll_id and v.user_id = i.user_id), '{}'::jsonb)
      ) order by lower(public.member_name(i.user_id))), '[]')
    into invs from public.oncoodle_invitees i join public.profiles pr on pr.id = i.user_id where i.poll_id = p_poll;
  end if;
  if me.user_id is not null then
    mine := jsonb_build_object('required', me.required, 'responded', me.responded_at is not null, 'comment', me.comment,
      'votes', coalesce((select jsonb_object_agg(v.option_id::text, v.answer) from public.oncoodle_votes v where v.poll_id = p_poll and v.user_id = uid), '{}'::jsonb));
  end if;

  return jsonb_build_object(
    'poll', jsonb_build_object('id', p.id, 'kind', p.kind, 'title', p.title, 'description', p.description, 'location', p.location, 'status', p.status,
      'deadline', p.deadline, 'visibility', p.visibility, 'creator_id', p.created_by, 'creator', public.member_name(p.created_by), 'is_creator', is_cr,
      'final_option_id', p.final_option_id, 'final_message', p.final_message, 'closed_at', p.closed_at, 'created_at', p.created_at,
      'locked', p.status <> 'open' or (p.deadline is not null and p.deadline <= now()),
      'reminded_at', case when is_cr then p.reminded_at end, 'audience', case when is_cr then p.audience end,
      'calendar_request', case when is_cr then (select r.status from public.oncoodle_calendar_requests r where r.poll_id = p.id) end),
    'options', opts, 'invitees', invs, 'me', mine, 'counts', jsonb_build_object('invited', n_inv, 'responded', n_resp));
end;
$$;

-- ===== 8. Clôture, relances, annulation =====
create or replace function public.oncoodle_close(p_poll bigint, p_option bigint default null, p_message text default null, p_calendar boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); p public.oncoodle_polls; o public.oncoodle_options; m text := nullif(btrim(coalesce(p_message, '')), ''); lbl text;
begin
  perform public.oncoodle_guard();
  select * into p from public.oncoodle_polls where id = p_poll for update;
  if p.id is null or p.created_by <> uid then raise exception 'Sondage introuvable.'; end if;
  if p.status <> 'open' then raise exception 'Ce sondage est déjà clos ou annulé.'; end if;
  if char_length(coalesce(m, '')) > 500 then raise exception 'Le message est limité à 500 caractères.'; end if;
  if p.kind = 'rsvp' then
    select * into o from public.oncoodle_options where poll_id = p_poll limit 1;
  else
    select * into o from public.oncoodle_options where id = p_option and poll_id = p_poll;
    if o.id is null then raise exception 'Choisissez le créneau retenu.'; end if;
  end if;
  update public.oncoodle_polls set status = 'closed', final_option_id = o.id, final_message = m, closed_at = now(), updated_at = now() where id = p_poll;
  insert into public.oncoodle_outbox (kind, poll_id, recipient, payload)
    select 'closed', p_poll, i.user_id, jsonb_build_object('option_id', o.id) from public.oncoodle_invitees i where i.poll_id = p_poll and i.user_id <> uid;
  if coalesce(p_calendar, false) then
    -- Jamais d'ajout direct : demande à approuver par un·e autre admin ou membre de la direction (une seule par sondage ; modifiable tant qu'elle est en attente)
    lbl := left(p.title, 120);
    insert into public.oncoodle_calendar_requests (poll_id, requested_by, label, day, start_time, end_time)
      values (p_poll, uid, lbl, o.day, o.start_time, o.end_time)
      on conflict (poll_id) do update set label = excluded.label, day = excluded.day, start_time = excluded.start_time, end_time = excluded.end_time
        where public.oncoodle_calendar_requests.status = 'pending';
    insert into public.oncoodle_outbox (kind, poll_id, recipient, payload)
      values ('calendar_proposal', p_poll, null, jsonb_build_object('option_id', o.id, 'by', public.member_name(uid)));
  end if;
end;
$$;

create or replace function public.oncoodle_reopen(p_poll bigint) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); p public.oncoodle_polls;
begin
  perform public.oncoodle_guard();
  select * into p from public.oncoodle_polls where id = p_poll for update;
  if p.id is null or p.created_by <> uid then raise exception 'Sondage introuvable.'; end if;
  if p.status <> 'closed' then raise exception 'Seul un sondage clos peut être rouvert.'; end if;
  update public.oncoodle_polls set status = 'open', final_option_id = null, final_message = null, closed_at = null,
    deadline = case when deadline <= now() then null else deadline end, updated_at = now() where id = p_poll;
  insert into public.oncoodle_outbox (kind, poll_id, recipient, payload)
    select 'updated', p_poll, i.user_id, jsonb_build_object('reopened', true) from public.oncoodle_invitees i where i.poll_id = p_poll and i.user_id <> uid;
end;
$$;

create or replace function public.oncoodle_remind(p_poll bigint) returns int
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); p public.oncoodle_polls; n int;
begin
  perform public.oncoodle_guard();
  select * into p from public.oncoodle_polls where id = p_poll for update;
  if p.id is null or p.created_by <> uid then raise exception 'Sondage introuvable.'; end if;
  if p.status <> 'open' then raise exception 'Ce sondage n''est plus ouvert.'; end if;
  if p.deadline is not null and p.deadline <= now() then raise exception 'L''échéance est passée.'; end if;
  if p.reminded_at is not null and p.reminded_at > now() - interval '12 hours' then
    raise exception 'Une relance a déjà été envoyée il y a moins de 12 heures.';
  end if;
  insert into public.oncoodle_outbox (kind, poll_id, recipient, payload, next_attempt_at)
    select 'reminder', p_poll, i.user_id, jsonb_build_object('manual', true), public.oncoodle_next_send()
    from public.oncoodle_invitees i where i.poll_id = p_poll and i.responded_at is null and i.user_id <> uid;
  get diagnostics n = row_count;
  update public.oncoodle_polls set reminded_at = now() where id = p_poll;
  return n;
end;
$$;

create or replace function public.oncoodle_cancel(p_poll bigint, p_message text default null) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); p public.oncoodle_polls; m text := nullif(btrim(coalesce(p_message, '')), '');
begin
  perform public.oncoodle_guard();
  select * into p from public.oncoodle_polls where id = p_poll for update;
  if p.id is null or p.created_by <> uid then raise exception 'Sondage introuvable.'; end if;
  if p.status = 'cancelled' then raise exception 'Ce sondage est déjà annulé.'; end if;
  if char_length(coalesce(m, '')) > 500 then raise exception 'Le message est limité à 500 caractères.'; end if;
  update public.oncoodle_polls set status = 'cancelled', final_message = m, closed_at = now(), updated_at = now() where id = p_poll;
  -- Les envois en attente n'ont plus de sens (invitation, relance) : remplacés par l'annulation
  update public.oncoodle_outbox set skipped_at = now() where poll_id = p_poll and sent_at is null and skipped_at is null;
  insert into public.oncoodle_outbox (kind, poll_id, recipient)
    select 'cancelled', p_poll, i.user_id from public.oncoodle_invitees i where i.poll_id = p_poll and i.user_id <> uid;
end;
$$;

create or replace function public.oncoodle_delete(p_poll bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.oncoodle_guard();
  delete from public.oncoodle_polls where id = p_poll and created_by = auth.uid();
  if not found then raise exception 'Sondage introuvable.'; end if;
end;
$$;

create or replace function public.oncoodle_calendar_requests() returns table(
  id bigint, poll_id bigint, label text, day date, start_time text, end_time text, requester text, requester_id uuid, own boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.oncoodle_guard();
  if not public.is_direction_admin() then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  return query
    select r.id, r.poll_id, r.label, r.day, to_char(r.start_time, 'HH24:MI'), to_char(r.end_time, 'HH24:MI'),
      public.member_name(r.requested_by), r.requested_by, r.requested_by = auth.uid(), r.created_at
    from public.oncoodle_calendar_requests r where r.status = 'pending' order by r.day, r.id limit 100;
end;
$$;

create or replace function public.oncoodle_calendar_decide(p_id bigint, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r public.oncoodle_calendar_requests;
begin
  perform public.oncoodle_guard();
  if not public.is_direction_admin() then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  select * into r from public.oncoodle_calendar_requests where id = p_id for update;
  if r.id is null then raise exception 'Demande introuvable.'; end if;
  if r.status <> 'pending' then raise exception 'Cette demande est déjà traitée.'; end if;
  if r.requested_by = auth.uid() then raise exception 'Un·e autre admin ou membre de la direction doit approuver votre propre demande.'; end if;
  if coalesce(p_approve, false) then
    if not exists (select 1 from public.absence_calendar c where c.kind = 'evenement' and c.label = r.label and c.start_date = r.day and c.end_date = r.day) then
      insert into public.absence_calendar (kind, label, start_date, end_date) values ('evenement', r.label, r.day, r.day);
    end if;
  end if;
  update public.oncoodle_calendar_requests set status = case when coalesce(p_approve, false) then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now() where id = p_id;
end;
$$;

create or replace function public.oncoodle_prefs() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.oncoodle_guard();
  return jsonb_build_object('email', (select oncoodle_email from public.profiles where id = auth.uid()));
end;
$$;

create or replace function public.oncoodle_set_prefs(p_email boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.oncoodle_guard();
  update public.profiles set oncoodle_email = coalesce(p_email, true) where id = auth.uid();
  return public.oncoodle_prefs();
end;
$$;

-- ===== 9. Traitement périodique (service) =====
-- Relances automatiques : 48 h avant l'échéance, ou 3 jours après la création s'il n'y a pas d'échéance. Une seule fois par sondage.
-- Échéance dépassée : le créateur est prévenu une fois. Purge : voir l'en-tête.
create or replace function public.oncoodle_tick() returns jsonb
language plpgsql security definer set search_path = public as $$
declare rem int := 0; dead int := 0; purged int := 0; r record; n int;
begin
  for r in
    select p.id, p.created_by from public.oncoodle_polls p
    where p.status = 'open' and p.auto_reminded_at is null
      and coalesce(public.oncoodle_last_day(p.id), public.ch_today()) >= public.ch_today()
      and ((p.deadline is not null and p.deadline > now() and p.deadline <= now() + interval '48 hours')
        or (p.deadline is null and p.created_at <= now() - interval '3 days'))
    for update skip locked
  loop
    insert into public.oncoodle_outbox (kind, poll_id, recipient, payload, next_attempt_at)
      select 'reminder', r.id, i.user_id, jsonb_build_object('manual', false), public.oncoodle_next_send()
      from public.oncoodle_invitees i where i.poll_id = r.id and i.responded_at is null and i.user_id <> r.created_by;
    get diagnostics n = row_count;
    rem := rem + n;
    update public.oncoodle_polls set auto_reminded_at = now() where id = r.id;
  end loop;

  for r in
    select p.id, p.created_by from public.oncoodle_polls p
    where p.status = 'open' and p.deadline is not null and p.deadline <= now() and p.deadline_notified_at is null
    for update skip locked
  loop
    insert into public.oncoodle_outbox (kind, poll_id, recipient, next_attempt_at)
      values ('deadline', r.id, r.created_by, public.oncoodle_next_send()) on conflict do nothing;
    update public.oncoodle_polls set deadline_notified_at = now() where id = r.id;
    dead := dead + 1;
  end loop;

  delete from public.oncoodle_polls p
    where (p.status in ('closed', 'cancelled') and coalesce(p.closed_at, p.updated_at) < now() - interval '180 days')
       or (coalesce(public.oncoodle_last_day(p.id), p.created_at::date) < public.ch_today() - 180);
  get diagnostics purged = row_count;
  delete from public.oncoodle_outbox where coalesce(sent_at, skipped_at, created_at) < now() - interval '90 days' and (sent_at is not null or skipped_at is not null or attempts >= 5);
  return jsonb_build_object('reminders', rem, 'deadline_notices', dead, 'purged', purged);
end;
$$;

create or replace function public.oncoodle_outbox_claim(p_limit int default 30) returns setof public.oncoodle_outbox
language sql security definer set search_path = public as $$
  update public.oncoodle_outbox o set claimed_at = now(), attempts = o.attempts + 1
  where id in (select id from public.oncoodle_outbox where sent_at is null and skipped_at is null and attempts < 5 and next_attempt_at <= now()
               and (claimed_at is null or claimed_at < now() - interval '10 minutes') order by id limit greatest(1, least(p_limit, 100)) for update skip locked)
  returning o.*;
$$;
create or replace function public.oncoodle_outbox_done(p_id bigint, p_error text default null) returns void
language sql security definer set search_path = public as $$
  update public.oncoodle_outbox set sent_at = case when p_error is null then now() else null end, last_error = left(p_error, 300), claimed_at = null,
    next_attempt_at = now() + make_interval(secs => least(3600, 60 * power(2, attempts)::int)) where id = p_id;
$$;
create or replace function public.oncoodle_outbox_skip(p_id bigint) returns void
language sql security definer set search_path = public as $$
  update public.oncoodle_outbox set skipped_at = now(), claimed_at = null, last_error = null where id = p_id;
$$;

-- Un membre a-t-il le droit d'utiliser l'outil ? (contrôle de la fonction Edge pour les appels avec session)
create or replace function public.oncoodle_user_allowed(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$ select public.tool_allowed(p_user, 'oncoodle'); $$;

-- Données d'un message (lues en base par la fonction Edge, jamais dans la requête)
create or replace function public.oncoodle_mail_data(p_poll bigint, p_recipient uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p public.oncoodle_polls; inv public.oncoodle_invitees; prof record; ans text;
begin
  select * into p from public.oncoodle_polls where id = p_poll;
  if p.id is null then return null; end if;
  if p_recipient is not null then
    select * into inv from public.oncoodle_invitees where poll_id = p_poll and user_id = p_recipient;
    select lang, notify_events, oncoodle_email into prof from public.profiles where id = p_recipient;
    if p.final_option_id is not null then
      select v.answer into ans from public.oncoodle_votes v where v.option_id = p.final_option_id and v.user_id = p_recipient;
    end if;
  end if;
  return jsonb_build_object(
    'poll', jsonb_build_object('id', p.id, 'kind', p.kind, 'title', p.title, 'description', p.description, 'location', p.location, 'status', p.status,
      'deadline', p.deadline, 'creator', public.member_name(p.created_by), 'creator_id', p.created_by, 'final_option_id', p.final_option_id,
      'final_message', p.final_message),
    'options', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'day', o.day, 'start', to_char(o.start_time, 'HH24:MI'), 'end', to_char(o.end_time, 'HH24:MI'))
                                          order by o.day, o.start_time nulls first, o.id) from public.oncoodle_options o where o.poll_id = p_poll), '[]'),
    'invitee', case when inv.user_id is null then null else jsonb_build_object('required', inv.required, 'responded', inv.responded_at is not null, 'answer_on_final', ans) end,
    'recipient', case when p_recipient is null then null else jsonb_build_object('lang', coalesce(prof.lang, 'fr'), 'push', coalesce(prof.notify_events, false), 'email', coalesce(prof.oncoodle_email, true)) end,
    'counts', jsonb_build_object('invited', (select count(*) from public.oncoodle_invitees where poll_id = p_poll),
                                  'responded', (select count(*) from public.oncoodle_invitees where poll_id = p_poll and responded_at is not null)));
end;
$$;

-- Appel autonome de la fonction Edge (mêmes secrets Vault que notify-absence ; l'adresse de la fonction est oncoodle_worker_url)
create or replace function public.oncoodle_dispatch() returns boolean
language plpgsql security definer set search_path = public as $$
declare token text; url text;
begin
  if not exists (select 1 from public.oncoodle_outbox where sent_at is null and skipped_at is null and attempts < 5 and next_attempt_at <= now()) then return false; end if;
  select decrypted_secret into token from vault.decrypted_secrets where name = 'absence_worker_token' limit 1;
  select decrypted_secret into url from vault.decrypted_secrets where name = 'oncoodle_worker_url' limit 1;
  if token is null or url is null then return false; end if;
  perform net.http_post(url := url, headers := jsonb_build_object('Content-Type', 'application/json', 'x-absence-worker', token), body := '{}'::jsonb, timeout_milliseconds := 55000);
  return true;
end;
$$;

create or replace function public.oncoodle_worker_health() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare scheduled boolean := false; configured boolean := false;
begin
  if not public.is_direction_admin() then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  if to_regclass('cron.job') is not null then
    execute 'select count(*) = 2 from cron.job where jobname in (''oncoodle-outbox'', ''oncoodle-tick'') and active' into scheduled;
  end if;
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'select count(distinct name) = 2 from vault.decrypted_secrets where name in (''absence_worker_token'', ''oncoodle_worker_url'')' into configured;
  end if;
  return jsonb_build_object('scheduled', scheduled, 'configured', configured,
    'pending', (select count(*) from public.oncoodle_outbox where sent_at is null and skipped_at is null and attempts < 5),
    'failed', (select count(*) from public.oncoodle_outbox where sent_at is null and skipped_at is null and attempts >= 5));
end;
$$;

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.schedule('oncoodle-outbox', '*/5 * * * *', 'select public.oncoodle_dispatch()');
    perform cron.schedule('oncoodle-tick', '*/30 * * * *', 'select public.oncoodle_tick()');
  end if;
end $$;

-- ===== 10. Droits d'exécution =====
do $$
declare f text;
begin
  -- Internes : ni anon ni membres connectés
  foreach f in array array[
    'oncoodle_guard()', 'oncoodle_role_label(text)', 'oncoodle_parse_date(text)', 'oncoodle_parse_time(text)', 'oncoodle_text_array(jsonb)',
    'oncoodle_uuid_array(jsonb)', 'oncoodle_check_audience(jsonb)', 'oncoodle_resolve(jsonb)', 'oncoodle_next_send(timestamptz)',
    'oncoodle_last_day(bigint)', 'oncoodle_parse_options(jsonb)', 'oncoodle_tick()', 'oncoodle_outbox_claim(int)', 'oncoodle_outbox_done(bigint,text)',
    'oncoodle_outbox_skip(bigint)', 'oncoodle_mail_data(bigint,uuid)', 'oncoodle_dispatch()', 'oncoodle_daily_quota()', 'oncoodle_check_quota(uuid)',
    'oncoodle_user_allowed(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  -- Appelables par les membres connectés (chaque fonction contrôle l'appelant)
  foreach f in array array[
    'oncoodle_people()', 'oncoodle_audience_preview(jsonb)', 'oncoodle_create(jsonb)', 'oncoodle_update(bigint,jsonb)', 'oncoodle_vote(bigint,jsonb,text)',
    'oncoodle_list()', 'oncoodle_pending_count()', 'oncoodle_get(bigint)', 'oncoodle_close(bigint,bigint,text,boolean)', 'oncoodle_reopen(bigint)',
    'oncoodle_remind(bigint)', 'oncoodle_cancel(bigint,text)', 'oncoodle_delete(bigint)', 'oncoodle_calendar_requests()', 'oncoodle_calendar_decide(bigint,boolean)', 'oncoodle_prefs()', 'oncoodle_set_prefs(boolean)',
    'oncoodle_worker_health()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['oncoodle_user_allowed(uuid)', 'oncoodle_tick()', 'oncoodle_outbox_claim(int)', 'oncoodle_outbox_done(bigint,text)', 'oncoodle_outbox_skip(bigint)', 'oncoodle_mail_data(bigint,uuid)'] loop
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

insert into public.onconic_migrations (version) values ('202611130002') on conflict do nothing;
commit;
