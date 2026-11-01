-- Onconic : congrès et formations (« Qui d'autre butine au congrès ? »), pour tous les membres validés.
-- À exécuter une fois dans Supabase > SQL Editor > Run (peut être relancé sans risque).

-- ----- Profil : consentements (désactivés par défaut, modifiables à tout moment) -----
alter table public.profiles add column if not exists show_in_events boolean not null default false;
alter table public.profiles add column if not exists contactable boolean not null default false;
grant update (show_in_events, contactable) on public.profiles to authenticated;

-- Membre validé : tout rôle sauf « member » (accès en attente)
create or replace function public.is_hive_member()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role_name() in ('admin', 'clinician', 'assistant', 'pharmacist'), false);
$$;
revoke execute on function public.is_hive_member() from public, anon;
grant execute on function public.is_hive_member() to authenticated;

-- ----- Événements -----
create table if not exists public.events (
  id bigint generated always as identity primary key,
  title text not null check (char_length(title) between 3 and 200),
  kind text not null default 'congrès' check (kind in ('congrès', 'formation', 'symposium', 'webinaire')),
  description text check (char_length(description) <= 2000),
  start_date date not null,
  end_date date not null,
  city text check (char_length(city) <= 100),
  country text check (char_length(country) <= 100),
  venue text check (char_length(venue) <= 200),
  format text not null default 'présentiel' check (format in ('présentiel', 'hybride', 'en ligne')),
  url text check (url ~ '^https?://' and char_length(url) <= 500),
  clinics text[] not null default '{}',
  abstract_deadline date,
  early_deadline date,
  whatsapp_url text check (whatsapp_url ~ '^https://chat\.whatsapp\.com/' and char_length(whatsapp_url) <= 200),
  to_confirm boolean not null default false,
  source text,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint events_dates check (end_date >= start_date)
);
create unique index if not exists events_title_start on public.events (lower(title), start_date);
create index if not exists events_start on public.events (start_date);

alter table public.events enable row level security;
drop policy if exists "events: members read" on public.events;
create policy "events: members read" on public.events for select to authenticated using ((select public.has_tool('congres')));
drop policy if exists "events: members insert" on public.events;
create policy "events: members insert" on public.events for insert to authenticated
  with check ((select public.has_tool('congres')) and created_by = auth.uid());
drop policy if exists "events: members update" on public.events;
create policy "events: members update" on public.events for update to authenticated
  using ((select public.has_tool('congres'))) with check ((select public.has_tool('congres')));
drop policy if exists "events: creator or admin delete" on public.events;
create policy "events: creator or admin delete" on public.events for delete to authenticated
  using (public.current_role_name() = 'admin' or ((select public.has_tool('congres')) and created_by = auth.uid()));
revoke all on public.events from anon;
grant select, insert, update, delete on public.events to authenticated;

-- Auteur et date de chaque modification, posés par la base (non falsifiables)
create or replace function public.events_stamp()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;
drop trigger if exists events_stamp on public.events;
create trigger events_stamp before insert or update on public.events
  for each row execute function public.events_stamp();

-- Historique : chaque version précédente est conservée (restauration par l'admin)
create table if not exists public.event_history (
  id bigint generated always as identity primary key,
  event_id bigint not null,
  action text not null,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  snapshot jsonb not null
);
alter table public.event_history enable row level security;
drop policy if exists "event_history: admin read" on public.event_history;
create policy "event_history: admin read" on public.event_history for select to authenticated
  using (public.current_role_name() = 'admin');
revoke all on public.event_history from anon, authenticated;
grant select on public.event_history to authenticated;

create or replace function public.events_log()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.event_history (event_id, action, changed_by, snapshot)
  values (old.id, lower(tg_op), auth.uid(), to_jsonb(old));
  return null;
end;
$$;
revoke execute on function public.events_log() from public, anon, authenticated;
drop trigger if exists events_log on public.events;
create trigger events_log after update or delete on public.events
  for each row execute function public.events_log();

-- ----- Participation -----
create table if not exists public.event_participants (
  event_id bigint not null references public.events (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  status text not null default 'going' check (status in ('going', 'maybe', 'presenting')),
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
alter table public.event_participants enable row level security;
-- Chacun ne lit et ne modifie directement que ses propres lignes ; les autres passent par event_attendees()
drop policy if exists "event_participants: own" on public.event_participants;
create policy "event_participants: own" on public.event_participants for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and (select public.has_tool('congres')));
revoke all on public.event_participants from anon;
grant select, insert, update, delete on public.event_participants to authenticated;

-- Participants visibles : le nom seulement si la personne l'accepte, ses coordonnées seulement si elle accepte
-- d'être contactée. Les autres participants ne sont comptés que globalement (name null).
create or replace function public.event_attendees(p_event_ids bigint[])
returns table (event_id bigint, status text, is_me boolean, name text, email text, phone text)
language sql stable security definer set search_path = public as $$
  select p.event_id, p.status, p.user_id = auth.uid(),
    case when pr.show_in_events or p.user_id = auth.uid()
      then coalesce(nullif(trim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.last_name, '')), ''), pr.full_name, pr.username) end,
    case when pr.show_in_events and pr.contactable and p.user_id <> auth.uid() then u.email end,
    case when pr.show_in_events and pr.contactable and p.user_id <> auth.uid() then pr.phone end
  from public.event_participants p
  join public.profiles pr on pr.id = p.user_id
  join auth.users u on u.id = p.user_id
  where public.has_tool('congres') and p.event_id = any (p_event_ids)
  order by p.event_id, (p.status = 'presenting') desc, pr.last_name nulls last;
$$;
revoke execute on function public.event_attendees(bigint[]) from public, anon;
grant execute on function public.event_attendees(bigint[]) to authenticated;

-- ----- Événements de départ (sources publiques, octobre 2026). « À confirmer » : date d'une seule source ou non officielle. -----
insert into public.events (title, kind, description, start_date, end_date, city, country, venue, format, url, clinics, to_confirm, source, created_by)
values
 ('International Lung Cancer Summit 2026', 'symposium', '8e édition, présidée par Solange Peters et Alfredo Addeo. Hybride, 5 crédits CME.', '2026-11-13', '2026-11-13', 'Lausanne', 'Suisse', 'CHUV, bâtiment AGORA', 'hybride', 'https://lungsummit.org/', '{Thoracique}', false, 'lungsummit.org', null),
 ('SNO Annual Meeting 2026', 'congrès', '31st Annual Meeting & Education Day of the Society for Neuro-Oncology.', '2026-11-12', '2026-11-15', 'Philadelphia', 'États-Unis', 'Pennsylvania Convention Center', 'présentiel', 'https://www.soc-neuro-onc.org/', '{Neuro-oncologie}', false, 'soc-neuro-onc.org', null),
 ('Swiss Oncology and Hematology Congress (SOHC) 2026', 'congrès', 'Congrès suisse d''oncologie et d''hématologie.', '2026-11-18', '2026-11-20', 'Bâle', 'Suisse', 'Congress Center Basel', 'présentiel', 'https://swiss-congress.ch/conferences/swiss-oncology-and-hematology-congress', '{Transversal}', true, 'swiss-congress.ch', null),
 ('3e Journée romande de dermato-oncologie (JRDO)', 'formation', 'Mélanome et autres tumeurs cutanées, panel pluridisciplinaire. Organisée par les services de dermatologie et d''oncologie des HUG et du CHUV.', '2026-11-26', '2026-11-26', 'Lausanne', 'Suisse', 'Hôtel Alpha-Palmiers', 'présentiel', 'https://www.hug.ch/evenement/3e-journee-romande-dermato-oncologie', '{Mélanome}', false, 'hug.ch', null),
 ('ETOP Annual Meeting 2026', 'congrès', 'Réunion annuelle de l''European Thoracic Oncology Platform.', '2026-11-27', '2026-11-28', 'Zurich', 'Suisse', null, 'présentiel', null, '{Thoracique}', true, 'myswitzerland.com', null),
 ('Swiss Neuro-Oncology Symposium (SwissNOS) 2026', 'symposium', 'Symposium suisse de neuro-oncologie organisé par l''Hôpital cantonal de Lucerne (LUKS).', '2026-12-03', '2026-12-04', 'Lucerne', 'Suisse', 'Luzerner Kantonsspital', 'présentiel', 'https://www.luks.ch/veranstaltungen/swiss-neuro-oncology-symposium', '{Neuro-oncologie}', false, 'luks.ch', null),
 ('San Antonio Breast Cancer Symposium (SABCS) 2026', 'congrès', null, '2026-12-08', '2026-12-11', 'San Antonio', 'États-Unis', 'Henry B. Gonzalez Convention Center', 'hybride', 'https://sabcs.org/', '{Sénologie}', false, 'aacr.org', null),
 ('ESMO Immuno-Oncology Congress 2026', 'congrès', null, '2026-12-14', '2026-12-16', 'Londres', 'Royaume-Uni', null, 'hybride', 'https://www.esmo.org/meeting-calendar', '{Transversal}', false, 'esmo.org', null),
 ('ASCO Gastrointestinal Cancers Symposium 2027', 'symposium', null, '2027-01-21', '2027-01-23', 'San Francisco', 'États-Unis', 'Moscone West', 'hybride', 'https://www.asco.org/', '{Lower GI,Upper GI}', false, 'moscone.com', null),
 ('ASCO Genitourinary Cancers Symposium 2027', 'symposium', null, '2027-02-11', '2027-02-13', 'San Francisco', 'États-Unis', 'Moscone West', 'hybride', 'https://www.asco.org/', '{Urologie}', false, 'healio.com', null),
 ('EANO-EORTC CNS Metastasis Meeting 2027', 'congrès', 'Nouvelle réunion internationale consacrée aux métastases du système nerveux central.', '2027-02-26', '2027-02-27', 'Bruxelles', 'Belgique', null, 'présentiel', 'https://www.eortc.org/event/eortc-eano-cns-metastasis-meeting-2027/', '{Neuro-oncologie,Thoracique,Sénologie,Mélanome}', false, 'eortc.org', null),
 ('SAMO Workshop Chest Tumors 2027', 'formation', 'Workshop interdisciplinaire SAMO sur les tumeurs thoraciques.', '2027-02-26', '2027-02-27', 'Thoune', 'Suisse', 'Hotel Aare Thun', 'présentiel', 'https://www.samo-workshop.ch/events-overview', '{Thoracique}', false, 'samo-workshop.ch', null),
 ('European Lung Cancer Congress (ELCC) 2027', 'congrès', 'Congrès européen du cancer du poumon (ESMO et IASLC).', '2027-03-17', '2027-03-20', 'Munich', 'Allemagne', null, 'hybride', 'https://www.esmo.org/meeting-calendar', '{Thoracique}', false, 'esmo.org', null),
 ('AACR Annual Meeting 2027', 'congrès', null, '2027-04-02', '2027-04-07', 'Orlando', 'États-Unis', 'Orange County Convention Center', 'présentiel', 'https://www.aacr.org/meeting/aacr-annual-meeting-2027/', '{Transversal}', false, 'aacr.org', null),
 ('EADO Congress 2027', 'congrès', '23e congrès de l''European Association of Dermato-Oncology.', '2027-04-15', '2027-04-17', 'Vienne', 'Autriche', 'Hofburg', 'présentiel', null, '{Mélanome}', false, 'oncodaily.com', null),
 ('SAMO Workshop Breast Tumors 2027', 'formation', 'Workshop interdisciplinaire SAMO sur les tumeurs du sein.', '2027-04-23', '2027-04-24', 'Thoune', 'Suisse', 'Hotel Aare Thun', 'présentiel', 'https://www.samo-workshop.ch/events-overview', '{Sénologie}', false, 'samo-workshop.ch', null),
 ('ESMO Breast Cancer Annual Congress 2027', 'congrès', 'Dates et lieu à vérifier (Milan selon une source, Allemagne selon d''autres).', '2027-05-12', '2027-05-14', 'Milan', 'Italie', null, 'hybride', 'https://www.esmo.org/meeting-calendar', '{Sénologie}', true, 'clocate.com', null),
 ('Swiss Cancer Institute (SAKK) Semi-Annual Meeting printemps 2027', 'congrès', null, '2027-05-13', '2027-05-14', 'Lucerne', 'Suisse', 'KKL Luzern', 'présentiel', null, '{Transversal}', false, 'swisscancerinstitute.ch', null),
 ('ASCO Annual Meeting 2027', 'congrès', null, '2027-06-04', '2027-06-08', 'Chicago', 'États-Unis', 'McCormick Place', 'hybride', 'https://conferences.asco.org/am', '{Transversal}', false, 'asco.org', null),
 ('EANO-SNO Joint Meeting on Pediatric Neuro-Oncology 2027', 'congrès', 'Première réunion commune EANO-SNO de neuro-oncologie pédiatrique.', '2027-06-24', '2027-06-26', 'Miami', 'États-Unis', 'JW Marriott Miami Turnberry Resort', 'présentiel', 'https://www.soc-neuro-onc.org/', '{Neuro-oncologie}', false, 'soc-neuro-onc.org', null),
 ('ESMO Gastrointestinal Cancers Congress 2027', 'congrès', null, '2027-06-30', '2027-07-03', 'Barcelone', 'Espagne', null, 'hybride', 'https://www.esmo.org/meeting-calendar', '{Lower GI,Upper GI}', true, 'showsbee.com', null),
 ('SAMO Workshop Upper GI Tumors 2027', 'formation', 'Workshop interdisciplinaire SAMO sur les tumeurs digestives hautes.', '2027-09-03', '2027-09-04', 'Thoune', 'Suisse', 'Hotel Aare Thun', 'présentiel', 'https://www.samo-workshop.ch/events-overview', '{Upper GI}', false, 'samo-workshop.ch', null),
 ('IASLC World Conference on Lung Cancer (WCLC) 2027', 'congrès', null, '2027-09-11', '2027-09-14', 'Denver', 'États-Unis', null, 'hybride', 'https://wclc.iaslc.org/', '{Thoracique}', false, 'iaslc.org', null),
 ('ESMO Congress 2027', 'congrès', null, '2027-09-17', '2027-09-21', 'Barcelone', 'Espagne', null, 'hybride', 'https://www.esmo.org/meeting-calendar', '{Transversal}', true, 'oncodaily.com', null),
 ('ESMO in the Alps 2027', 'symposium', null, '2027-09-30', '2027-09-30', 'Lucerne', 'Suisse', 'KKL Luzern', 'présentiel', null, '{Transversal}', false, 'swisscancerinstitute.ch', null),
 ('SAMO Workshop Urogenital Tumors 2027', 'formation', 'Workshop interdisciplinaire SAMO sur les tumeurs urogénitales.', '2027-10-29', '2027-10-30', 'Thoune', 'Suisse', 'Hotel Aare Thun', 'présentiel', 'https://www.samo-workshop.ch/events-overview', '{Urologie}', false, 'samo-workshop.ch', null),
 ('SAMO Highlights of the Year 2027', 'formation', 'Les faits marquants de l''année en oncologie.', '2027-11-12', '2027-11-12', 'Berne', 'Suisse', 'Best Western Hotel Bern', 'présentiel', 'https://www.samo-workshop.ch/events-overview', '{Transversal}', false, 'samo-workshop.ch', null),
 ('San Antonio Breast Cancer Symposium (SABCS) 2027', 'congrès', null, '2027-12-07', '2027-12-10', 'San Antonio', 'États-Unis', 'Henry B. Gonzalez Convention Center', 'hybride', 'https://sabcs.org/', '{Sénologie}', true, 'showsbee.com', null),
 ('AACR Annual Meeting 2028', 'congrès', null, '2028-04-21', '2028-04-26', 'La Nouvelle-Orléans', 'États-Unis', null, 'présentiel', 'https://www.aacr.org/', '{Transversal}', true, 'clocate.com', null)
on conflict (lower(title), start_date) do nothing;
