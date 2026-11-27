-- Calendrier des fériés et événements géré par la direction (27.11.2026). Transactionnel et réexécutable.
--
-- 1. absence_calendar : nouveaux types « ferie » (jour férié ajouté à la main, déduit des jours ouvrables) et « presence_obligatoire »
--    (avertissement non bloquant) ; colonnes created_by, updated_by, updated_at ; index partiel sur les fériés manuels.
-- 2. vd_holiday_dates(année) devient STABLE (SECURITY DEFINER) : fériés vaudois calculés (vd_holiday_calc, IMMUTABLE) fusionnés aux jours
--    des entrées « ferie » de l'année. absence_workdays, absence_workday_list et le calcul en ligne de absence_circuit_mine l'appellent
--    déjà : tous en profitent. L'effet est RÉTROACTIF : un férié ajouté ou retiré change les jours ouvrables des absences existantes.
-- 3. absence_calendar_log : journal en ajout seul (RLS, aucun droit direct), écrit par les fonctions d'administration.
-- 4. admin_calendar_save (4 types, doublon exact refusé), admin_calendar_delete, admin_calendar_confirm (journalisées), admin_calendar_list
--    (auteurs et date de modification), admin_calendar_log_list, admin_calendar_impact (nombre d'absences touchées, sans nom).
-- absence_calendar(p_from, p_to), lue par le planning, ne change pas de signature et renvoie les nouveaux types.
begin;

-- ===== 1. Table =====
alter table public.absence_calendar add column if not exists created_by uuid references auth.users (id) on delete set null;
alter table public.absence_calendar add column if not exists updated_by uuid references auth.users (id) on delete set null;
alter table public.absence_calendar add column if not exists updated_at timestamptz;

-- Contrainte de type : retrouvée dans le catalogue, recréée si elle ne connaît pas encore les nouveaux types
do $$
declare r record; has_new boolean := false;
begin
  for r in select c.conname, pg_get_constraintdef(c.oid) as def from pg_constraint c
            where c.conrelid = 'public.absence_calendar'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%vacances_scolaires%'
  loop
    if position('presence_obligatoire' in r.def) > 0 then has_new := true;
    else execute format('alter table public.absence_calendar drop constraint %I', r.conname);
    end if;
  end loop;
  if not has_new then
    alter table public.absence_calendar add constraint absence_calendar_kind_check
      check (kind in ('vacances_scolaires', 'evenement', 'ferie', 'presence_obligatoire'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.absence_calendar'::regclass and conname = 'absence_calendar_ferie_len') then
    alter table public.absence_calendar add constraint absence_calendar_ferie_len check (kind <> 'ferie' or end_date - start_date <= 30);
  end if;
end $$;

create index if not exists absence_calendar_ferie on public.absence_calendar (start_date, end_date) where kind = 'ferie';

-- ===== 2. Journal en ajout seul =====
create table if not exists public.absence_calendar_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null check (action in ('create', 'update', 'delete', 'confirm')),
  kind text not null,
  label text not null,
  start_date date not null,
  end_date date not null
);
alter table public.absence_calendar_log enable row level security;
revoke all on public.absence_calendar_log from public, anon, authenticated;

create or replace function public.absence_calendar_log_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Le journal du calendrier est en ajout seul.';
end;
$$;
revoke execute on function public.absence_calendar_log_guard() from public, anon, authenticated;
do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.absence_calendar_log'::regclass and tgname = 'absence_calendar_log_append_only') then
    create trigger absence_calendar_log_append_only before update or delete on public.absence_calendar_log
      for each row execute function public.absence_calendar_log_guard();
  end if;
end $$;

-- ===== 3. Fériés vaudois : calcul (immuable) et fusion avec les fériés manuels (stable) =====
-- Garde-fou : passer vd_holiday_dates en STABLE est incompatible avec un index, une colonne générée ou une contrainte qui l'utiliserait.
do $$
declare f oid := to_regprocedure('public.vd_holiday_dates(integer)');
begin
  if f is not null and exists (
    select 1 from pg_depend d
     where d.refclassid = 'pg_proc'::regclass and d.refobjid = f
       and d.classid in ('pg_class'::regclass, 'pg_attrdef'::regclass, 'pg_constraint'::regclass)) then
    raise exception 'vd_holiday_dates est utilisée par un index, une colonne générée ou une contrainte : migration interrompue.';
  end if;
end $$;

create or replace function public.vd_holiday_calc(p_year int) returns date[]
language plpgsql immutable set search_path = public, pg_temp as $$
declare a int := p_year % 19; b int := p_year / 100; c int := p_year % 100; d int := b / 4; e int := b % 4; f int := (b + 8) / 25;
  g int := (b - f + 1) / 3; h int := (19 * a + b - d - g + 15) % 30; i int := c / 4; k int := c % 4; l int := (32 + 2 * e + 2 * i - h - k) % 7;
  m int := (a + 11 * h + 22 * l) / 451; easter date; sep1 int; first_sunday int;
begin
  easter := make_date(p_year, (h + l - 7 * m + 114) / 31, ((h + l - 7 * m + 114) % 31) + 1);
  sep1 := extract(dow from make_date(p_year, 9, 1))::int;
  first_sunday := 1 + ((7 - sep1) % 7);
  return array[make_date(p_year, 1, 1), make_date(p_year, 1, 2), easter - 2, easter + 1, easter + 39, easter + 50,
               make_date(p_year, 8, 1), make_date(p_year, 9, first_sunday + 15), make_date(p_year, 12, 25)];
end;
$$;
revoke execute on function public.vd_holiday_calc(int) from public, anon, authenticated;

-- Dates triées sans doublon : fériés calculés + jours des entrées « ferie » de l'année (plages dépliées, y compris à cheval sur deux années)
create or replace function public.vd_holiday_dates(p_year int) returns date[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(x.d order by x.d), '{}'::date[]) from (
    select unnest(public.vd_holiday_calc(p_year)) as d
    union
    select g.d::date
      from public.absence_calendar c
      cross join lateral generate_series(greatest(c.start_date, make_date(p_year, 1, 1)), least(c.end_date, make_date(p_year, 12, 31)), interval '1 day') g (d)
     where c.kind = 'ferie' and c.start_date <= make_date(p_year, 12, 31) and c.end_date >= make_date(p_year, 1, 1)
  ) x;
$$;
revoke execute on function public.vd_holiday_dates(int) from public, anon;
grant execute on function public.vd_holiday_dates(int) to authenticated, service_role;

-- Jours ouvrables : mêmes définitions qu'avant (appel de vd_holiday_dates), republiées pour que la dépendance soit explicite
create or replace function public.absence_workdays(p_from date, p_to date) returns int
language sql stable set search_path = public, pg_temp as $$
  select count(*)::int from generate_series(p_from, p_to, interval '1 day') g (d)
  where extract(isodow from g.d) < 6 and not (g.d::date = any (public.vd_holiday_dates(extract(year from g.d)::int)));
$$;

create or replace function public.absence_workday_list(p_from date, p_to date) returns date[]
language sql stable set search_path = public, pg_temp as $$
  select coalesce(array_agg(g.d::date order by g.d), '{}'::date[])
    from generate_series(p_from, least(p_to, p_from + 400), interval '1 day') g (d)
   where extract(isodow from g.d) < 6 and not (g.d::date = any (public.vd_holiday_dates(extract(year from g.d)::int)));
$$;

-- ===== 4. Fonctions d'administration (direction et admin) =====
create or replace function public.admin_calendar_save(p_id bigint, p_kind text, p_label text, p_start date, p_end date) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare new_id bigint; l text := trim(coalesce(p_label, ''));
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('vacances_scolaires', 'evenement', 'ferie', 'presence_obligatoire') then raise exception 'Type inconnu.'; end if;
  if char_length(l) < 2 or char_length(l) > 120 then raise exception 'Intitulé de 2 à 120 caractères.'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'Vérifiez les dates.'; end if;
  if p_kind = 'ferie' and p_end - p_start > 30 then raise exception 'Un férié couvre 31 jours au plus.'; end if;
  if p_end - p_start > 120 then raise exception 'Période trop longue (120 jours au plus).'; end if;
  if exists (select 1 from public.absence_calendar c
              where c.kind = p_kind and c.label = l and c.start_date = p_start and c.end_date = p_end and c.id is distinct from p_id) then
    raise exception 'Cette entrée existe déjà.';
  end if;
  if p_id is null then
    insert into public.absence_calendar (kind, label, start_date, end_date, created_by, updated_by, updated_at)
      values (p_kind, l, p_start, p_end, auth.uid(), auth.uid(), now()) returning id into new_id;
  else
    update public.absence_calendar set kind = p_kind, label = l, start_date = p_start, end_date = p_end, to_confirm = false,
           updated_by = auth.uid(), updated_at = now()
     where id = p_id returning id into new_id;
    if new_id is null then raise exception 'Entrée introuvable.'; end if;
  end if;
  insert into public.absence_calendar_log (actor, action, kind, label, start_date, end_date)
    values (auth.uid(), case when p_id is null then 'create' else 'update' end, p_kind, l, p_start, p_end);
  return new_id;
end;
$$;

create or replace function public.admin_calendar_delete(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare x public.absence_calendar;
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  delete from public.absence_calendar where id = p_id returning * into x;
  if x.id is not null then
    insert into public.absence_calendar_log (actor, action, kind, label, start_date, end_date)
      values (auth.uid(), 'delete', x.kind, x.label, x.start_date, x.end_date);
  end if;
end;
$$;

create or replace function public.admin_calendar_confirm(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare x public.absence_calendar;
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  update public.absence_calendar set to_confirm = false, updated_by = auth.uid(), updated_at = now()
   where id = p_id and to_confirm returning * into x;
  if x.id is not null then
    insert into public.absence_calendar_log (actor, action, kind, label, start_date, end_date)
      values (auth.uid(), 'confirm', x.kind, x.label, x.start_date, x.end_date);
  end if;
end;
$$;

-- Le type de retour change : on supprime puis on recrée (les droits sont redonnés plus bas)
drop function if exists public.admin_calendar_list();
create function public.admin_calendar_list()
returns table (id bigint, kind text, label text, start_date date, end_date date, source text, to_confirm boolean,
               created_by_name text, updated_by_name text, updated_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return query
    select c.id, c.kind, c.label, c.start_date, c.end_date, c.source, c.to_confirm,
           case when c.created_by is null then null else public.member_name(c.created_by) end,
           case when c.updated_by is null then null else public.member_name(c.updated_by) end,
           c.updated_at
      from public.absence_calendar c order by c.start_date, c.label;
end;
$$;

create or replace function public.admin_calendar_log_list(p_limit int default 30)
returns table (id bigint, at timestamptz, actor_name text, action text, kind text, label text, start_date date, end_date date)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return query
    select l.id, l.at, case when l.actor is null then null else public.member_name(l.actor) end, l.action, l.kind, l.label, l.start_date, l.end_date
      from public.absence_calendar_log l order by l.at desc, l.id desc limit greatest(1, least(coalesce(p_limit, 30), 200));
end;
$$;

-- Nombre d'absences (ni brouillon, ni refusée, ni annulée) dont la période, ou la période d'une demande de changement en cours, couvre au
-- moins un jour dont le statut « férié » change réellement : lundi à vendredi, ni férié vaudois calculé, ni couvert par un AUTRE férié manuel.
-- p_exclude_id ignore l'entrée visée (modification ou suppression d'un férié existant). Renvoie un entier seul, aucun nom.
drop function if exists public.admin_calendar_impact(date, date);
create or replace function public.admin_calendar_impact(p_start date, p_end date, p_exclude_id bigint default null) returns int
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'Vérifiez les dates.'; end if;
  select count(*)::int into n from public.absences a
   where a.status not in ('draft', 'rejected', 'cancelled')
     and exists (
       select 1 from (values (a.start_date, a.end_date), (a.change_start, a.change_end)) pp (s, e)
        cross join lateral generate_series(greatest(pp.s, p_start), least(pp.e, p_end, p_start + 400), interval '1 day') g (d)
        where pp.s is not null and pp.e is not null
          and extract(isodow from g.d) < 6
          and not (g.d::date = any (public.vd_holiday_calc(extract(year from g.d)::int)))
          and not exists (select 1 from public.absence_calendar c
                           where c.kind = 'ferie' and c.id is distinct from p_exclude_id and g.d::date between c.start_date and c.end_date));
  return n;
end;
$$;

-- Droits
do $$
declare f text;
begin
  foreach f in array array['absence_calendar(date, date)', 'admin_calendar_save(bigint, text, text, date, date)', 'admin_calendar_delete(bigint)',
    'admin_calendar_confirm(bigint)', 'admin_calendar_list()', 'admin_calendar_log_list(int)', 'admin_calendar_impact(date, date, bigint)',
    'admin_calendar_sync_status()']
  loop
    -- admin_calendar_sync_status() vient de agenda_commun.sql : ignorée là où elle n'existe pas
    continue when to_regprocedure('public.' || f) is null;
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

do $$
begin
  if to_regclass('public.onconic_migrations') is not null then
    insert into public.onconic_migrations(version) values ('202611270003') on conflict do nothing;
  end if;
end $$;

commit;
