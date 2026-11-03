-- Congrès : détail de la présentation, retours de congrès, abonnement à l'agenda personnel.
-- À exécuter après congres.sql et trials.sql, avant de déployer le site qui l'utilise. Sans danger si relancé.

-- ===== 1. Détail de la présentation (statut « Je présente ») =====
alter table public.event_participants add column if not exists talk_title text check (talk_title is null or char_length(talk_title) between 3 and 200);
alter table public.event_participants add column if not exists talk_type text check (talk_type is null or talk_type in ('oral', 'poster', 'invité', 'table ronde'));
alter table public.event_participants add column if not exists talk_date date;
alter table public.event_participants add column if not exists talk_time time;

-- Présentations visibles : celles de la personne, ou celles des membres qui acceptent d'afficher leur nom (même règle que event_attendees)
create or replace function public.event_talks(p_event_ids bigint[])
returns table (event_id bigint, is_me boolean, name text, talk_title text, talk_type text, talk_date date, talk_time time)
language sql stable security definer set search_path = public as $$
  select p.event_id, p.user_id = auth.uid(),
    coalesce(nullif(trim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.last_name, '')), ''), pr.full_name, pr.username),
    p.talk_title, p.talk_type, p.talk_date, p.talk_time
  from public.event_participants p
  join public.profiles pr on pr.id = p.user_id
  where public.has_tool('congres') and p.event_id = any (p_event_ids)
    and p.status = 'presenting' and p.talk_title is not null
    and (pr.show_in_events or p.user_id = auth.uid())
  order by p.event_id, p.talk_date nulls last, p.talk_time nulls last;
$$;
revoke execute on function public.event_talks(bigint[]) from public, anon;
grant execute on function public.event_talks(bigint[]) to authenticated;

-- ===== 2. Retours de congrès : « ce que j'en retiens » (un par membre et par événement) =====
create table if not exists public.event_takeaways (
  id bigint generated always as identity primary key,
  event_id bigint not null references public.events (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body text not null check (char_length(body) between 10 and 1200),
  trial_slug text references public.key_trials (slug) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, user_id)
);
create index if not exists event_takeaways_event on public.event_takeaways (event_id);
alter table public.event_takeaways enable row level security;

create or replace function public.event_takeaways_stamp()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists event_takeaways_stamp on public.event_takeaways;
create trigger event_takeaways_stamp before update on public.event_takeaways
  for each row execute function public.event_takeaways_stamp();

-- Écriture : seulement pour soi, pour un événement commencé auquel on participe. Lecture directe : ses propres lignes
-- (les autres passent par event_takeaways_list, qui applique la règle du nom). Un admin peut supprimer (modération).
drop policy if exists "event_takeaways: own read" on public.event_takeaways;
create policy "event_takeaways: own read" on public.event_takeaways for select to authenticated using (user_id = auth.uid());
drop policy if exists "event_takeaways: own insert" on public.event_takeaways;
create policy "event_takeaways: own insert" on public.event_takeaways for insert to authenticated
  with check (
    user_id = auth.uid() and (select public.has_tool('congres'))
    and exists (select 1 from public.events e where e.id = event_takeaways.event_id and e.start_date <= current_date)
    and exists (select 1 from public.event_participants p where p.event_id = event_takeaways.event_id and p.user_id = auth.uid())
  );
drop policy if exists "event_takeaways: own update" on public.event_takeaways;
create policy "event_takeaways: own update" on public.event_takeaways for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and (select public.has_tool('congres')));
drop policy if exists "event_takeaways: own or admin delete" on public.event_takeaways;
create policy "event_takeaways: own or admin delete" on public.event_takeaways for delete to authenticated
  using (user_id = auth.uid() or public.current_role_name() = 'admin');
revoke all on public.event_takeaways from anon;
grant select, insert, update, delete on public.event_takeaways to authenticated;

create or replace function public.event_takeaways_list(p_event_ids bigint[])
returns table (id bigint, event_id bigint, is_me boolean, author text, body text, trial_slug text, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select t.id, t.event_id, t.user_id = auth.uid(),
    case when pr.show_in_events or t.user_id = auth.uid()
      then coalesce(nullif(trim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.last_name, '')), ''), pr.full_name, pr.username) end,
    t.body, t.trial_slug, t.updated_at
  from public.event_takeaways t
  join public.profiles pr on pr.id = t.user_id
  where public.has_tool('congres') and t.event_id = any (p_event_ids)
  order by t.event_id, t.updated_at desc;
$$;
revoke execute on function public.event_takeaways_list(bigint[]) from public, anon;
grant execute on function public.event_takeaways_list(bigint[]) to authenticated;

-- ===== 3. Abonnement à l'agenda personnel (flux iCal) =====
-- Le lien contient un jeton secret propre au membre ; le flux est servi par la fonction « calendar-feed ».
create table if not exists public.calendar_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);
alter table public.calendar_tokens enable row level security;
revoke all on public.calendar_tokens from anon, authenticated;

-- Renvoie le jeton du membre (le crée au besoin) ; p_reset = true en génère un nouveau, l'ancien lien cesse de fonctionner
create or replace function public.calendar_token(p_reset boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if auth.uid() is null or not public.has_tool('congres') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_reset then delete from public.calendar_tokens where user_id = auth.uid(); end if;
  insert into public.calendar_tokens (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  select token into t from public.calendar_tokens where user_id = auth.uid();
  return t;
end;
$$;
revoke execute on function public.calendar_token(boolean) from public, anon;
grant execute on function public.calendar_token(boolean) to authenticated;

-- Données du flux : participations du membre du jeton (réservé à la fonction serveur)
create or replace function public.calendar_feed(p_token text)
returns table (event_id bigint, status text, title text, description text, start_date date, end_date date, city text, country text,
               venue text, url text, clinics text[], to_confirm boolean, abstract_deadline date, early_deadline date,
               talk_title text, talk_type text, talk_date date, talk_time time, updated_at timestamptz, user_key text)
language sql stable security definer set search_path = public as $$
  select e.id, p.status, e.title, e.description, e.start_date, e.end_date, e.city, e.country, e.venue, e.url, e.clinics,
    e.to_confirm, e.abstract_deadline, e.early_deadline, p.talk_title, p.talk_type, p.talk_date, p.talk_time,
    greatest(e.updated_at, p.created_at), left(t.token, 8)
  from public.calendar_tokens t
  join public.event_participants p on p.user_id = t.user_id
  join public.events e on e.id = p.event_id
  where t.token = p_token and public.tool_allowed(t.user_id, 'congres')
  order by e.start_date, e.id;
$$;
revoke execute on function public.calendar_feed(text) from public, anon, authenticated;
grant execute on function public.calendar_feed(text) to service_role;
