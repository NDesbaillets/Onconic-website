-- Onconic : agenda commun du planning des absences.
-- 1. Import automatique des vacances scolaires vaudoises (OpenHolidays), via la fonction Edge holidays-sync,
--    appelée chaque mois par pg_cron. Les périodes importées restent « à confirmer » jusqu'à validation par l'admin.
-- 2. Congrès signalés par l'admin dans l'app Congrès (« Afficher dans l'agenda des absences »).
-- Les jours fériés vaudois restent calculés par la page (identiques à ceux d'OpenHolidays).
-- Script relançable sans risque.

-- ===== 1. Vacances scolaires importées =====
alter table public.absence_calendar add column if not exists source text not null default 'manuel';
alter table public.absence_calendar add column if not exists ext_id text;
alter table public.absence_calendar add column if not exists to_confirm boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'absence_calendar_source_check') then
    alter table public.absence_calendar add constraint absence_calendar_source_check check (source in ('manuel', 'openholidays'));
  end if;
end $$;
create unique index if not exists absence_calendar_ext on public.absence_calendar (ext_id) where ext_id is not null;

-- Dernier import (une seule ligne) : date et résumé, affichés dans l'administration
create table if not exists public.calendar_sync (
  id int primary key default 1 check (id = 1),
  last_run timestamptz,
  last_result jsonb
);
alter table public.calendar_sync enable row level security;
revoke all on public.calendar_sync from anon, authenticated;

-- Import d'une liste de périodes [{ext_id, label, start_date, end_date}], réservé au service (fonction Edge).
-- Règles : une période déjà importée et non confirmée est mise à jour ; une période confirmée ou saisie à la main
-- n'est jamais modifiée (un écart de dates est seulement signalé) ; une nouvelle période est ajoutée « à confirmer ».
create or replace function public.calendar_import_school_holidays(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; x public.absence_calendar; added int := 0; updated int := 0; same int := 0; gaps jsonb := '[]';
begin
  for r in select * from jsonb_to_recordset(coalesce(p_rows, '[]')) as t(ext_id text, label text, start_date date, end_date date) loop
    if r.ext_id is null or r.start_date is null or r.end_date is null or r.end_date < r.start_date then continue; end if;
    select * into x from public.absence_calendar c
      where c.kind = 'vacances_scolaires' and (c.ext_id = r.ext_id or (c.start_date <= r.end_date and c.end_date >= r.start_date))
      order by (c.ext_id = r.ext_id) desc nulls last, c.start_date limit 1;
    if not found then
      insert into public.absence_calendar (kind, label, start_date, end_date, source, ext_id, to_confirm)
        values ('vacances_scolaires', left(r.label, 120), r.start_date, r.end_date, 'openholidays', r.ext_id, true);
      added := added + 1;
    elsif x.source = 'openholidays' and x.to_confirm then
      if x.start_date <> r.start_date or x.end_date <> r.end_date or x.label <> left(r.label, 120) or x.ext_id is distinct from r.ext_id then
        update public.absence_calendar set label = left(r.label, 120), start_date = r.start_date, end_date = r.end_date, ext_id = r.ext_id where id = x.id;
        updated := updated + 1;
      else same := same + 1; end if;
    elsif x.start_date = r.start_date and x.end_date = r.end_date then
      same := same + 1;
    else
      gaps := gaps || jsonb_build_object('label', x.label, 'saisi', jsonb_build_array(x.start_date, x.end_date), 'source', jsonb_build_array(r.start_date, r.end_date));
    end if;
  end loop;
  insert into public.calendar_sync (id, last_run, last_result)
    values (1, now(), jsonb_build_object('ajoutees', added, 'mises_a_jour', updated, 'identiques', same, 'ecarts', gaps, 'recues', jsonb_array_length(coalesce(p_rows, '[]'))))
    on conflict (id) do update set last_run = excluded.last_run, last_result = excluded.last_result;
  return (select last_result from public.calendar_sync where id = 1);
end;
$$;
revoke execute on function public.calendar_import_school_holidays(jsonb) from public, anon, authenticated;
grant execute on function public.calendar_import_school_holidays(jsonb) to service_role;

-- Garde-fou contre les appels répétés de la fonction Edge (publique) : un import toutes les 10 minutes au plus
create or replace function public.calendar_sync_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select last_run < now() - interval '10 minutes' from public.calendar_sync where id = 1), true);
$$;
revoke execute on function public.calendar_sync_allowed() from public, anon, authenticated;
grant execute on function public.calendar_sync_allowed() to service_role;

-- Liste complète pour l'administration (avec source et statut), et état du dernier import
create or replace function public.admin_calendar_list()
returns table (id bigint, kind text, label text, start_date date, end_date date, source text, to_confirm boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  return query select c.id, c.kind, c.label, c.start_date, c.end_date, c.source, c.to_confirm from public.absence_calendar c order by c.start_date, c.label;
end;
$$;
create or replace function public.admin_calendar_sync_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  return (select jsonb_build_object('last_run', last_run, 'result', last_result) from public.calendar_sync where id = 1);
end;
$$;
create or replace function public.admin_calendar_confirm(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  update public.absence_calendar set to_confirm = false where id = p_id;
end;
$$;

-- Modifier une entrée vaut confirmation (elle n'est plus touchée par l'import)
create or replace function public.admin_calendar_save(p_id bigint, p_kind text, p_label text, p_start date, p_end date) returns bigint
language plpgsql security definer set search_path = public as $$
declare new_id bigint; l text := trim(coalesce(p_label, ''));
begin
  if public.current_role_name() is distinct from 'admin' then raise exception 'admin only' using errcode = '42501'; end if;
  if p_kind not in ('vacances_scolaires', 'evenement') then raise exception 'Type inconnu.'; end if;
  if char_length(l) < 2 or char_length(l) > 120 then raise exception 'Intitulé de 2 à 120 caractères.'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'Vérifiez les dates.'; end if;
  if p_end - p_start > 120 then raise exception 'Période trop longue (120 jours au plus).'; end if;
  if p_id is null then
    insert into public.absence_calendar (kind, label, start_date, end_date) values (p_kind, l, p_start, p_end) returning id into new_id;
  else
    update public.absence_calendar set kind = p_kind, label = l, start_date = p_start, end_date = p_end, to_confirm = false where id = p_id returning id into new_id;
    if new_id is null then raise exception 'Entrée introuvable.'; end if;
  end if;
  return new_id;
end;
$$;

-- ===== 2. Congrès affichés dans l'agenda commun =====
alter table public.events add column if not exists in_absence_calendar boolean not null default false;

-- Seul l'admin peut changer ce drapeau ; pour les autres (et les tâches automatiques), il garde sa valeur
create or replace function public.events_absence_flag_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    new.in_absence_calendar := case when tg_op = 'INSERT' then false else old.in_absence_calendar end;
  end if;
  return new;
end;
$$;
drop trigger if exists events_absence_flag_guard on public.events;
create trigger events_absence_flag_guard before insert or update on public.events
  for each row execute function public.events_absence_flag_guard();

-- Agenda commun lu par le planning : entrées saisies ou importées, plus les congrès signalés (id négatif = événement)
create or replace function public.absence_calendar(p_from date, p_to date)
returns table (id bigint, kind text, label text, start_date date, end_date date)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  return query
    select c.id, c.kind, c.label || case when c.to_confirm then ' (à confirmer)' else '' end, c.start_date, c.end_date
      from public.absence_calendar c where c.start_date <= p_to and c.end_date >= p_from
    union all
    select -e.id, 'congres'::text, e.title || case when e.to_confirm then ' (dates à confirmer)' else '' end, e.start_date, e.end_date
      from public.events e where e.in_absence_calendar and e.start_date <= p_to and e.end_date >= p_from
    order by 4, 3;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['absence_calendar(date, date)', 'admin_calendar_save(bigint, text, text, date, date)',
    'admin_calendar_list()', 'admin_calendar_sync_status()', 'admin_calendar_confirm(bigint)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ===== 3. Import mensuel (le 3 de chaque mois, 6h17 UTC) =====
-- Ignoré là où pg_cron / pg_net n'existent pas (tests locaux).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net') then
    create extension if not exists pg_cron;
    perform cron.schedule('agenda-commun-vacances', '17 6 3 * *',
      $job$ select net.http_get('https://icqrobnqvidusajburcu.supabase.co/functions/v1/holidays-sync') $job$);
  end if;
end $$;
