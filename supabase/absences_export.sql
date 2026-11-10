-- Absences : exports Excel de secours et de support (toutes les absences annotées, synthèse des décisions par personne).
-- À exécuter après admin_direction.sql. Sans danger si relancé.
--
-- Qui exporte quoi
--  * Administrateurs et direction : tous les membres. Validateurs (médecins cadres ou direction cochés « validateur des absences »
--    et désignés pour une clinique) : les membres de leurs cliniques pendant les dates de chaque absence (can_validate_absence).
--  * Une demande refusée disparaît de la table absences 14 jours après le refus. Le journal absence_decision_log garde chaque décision
--    (acceptée, refusée, changement accepté ou refusé) pour que la synthèse reste juste ; il est rempli par un déclencheur et,
--    à la mise en service, à partir des absences déjà décidées. Les refus purgés avant la mise en service ne sont pas récupérables.

-- ===== 1. Journal des décisions =====
create table if not exists public.absence_decision_log (
  id bigint generated always as identity primary key,
  absence_id bigint,
  user_id uuid not null references auth.users (id) on delete cascade,
  decision text not null check (decision in ('approved', 'rejected', 'change_approved', 'change_rejected')),
  kind text,
  start_date date,
  end_date date,
  note text,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz not null default now(),
  comment text
);
create index if not exists absence_decision_log_user on public.absence_decision_log (user_id, start_date);
alter table public.absence_decision_log enable row level security;
revoke all on public.absence_decision_log from anon, authenticated;

create or replace function public.absence_log_decision() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.decision is null or new.decided_at is null or new.status = 'draft' then return new; end if;
  if tg_op = 'UPDATE' and new.decided_at is not distinct from old.decided_at then return new; end if;
  insert into public.absence_decision_log (absence_id, user_id, decision, kind, start_date, end_date, note, decided_by, decided_at, comment)
    values (new.id, new.user_id, new.decision, new.kind, new.start_date, new.end_date, new.note, new.decided_by, new.decided_at, new.decision_comment);
  return new;
end;
$$;
revoke execute on function public.absence_log_decision() from public, anon, authenticated;

drop trigger if exists absences_log_decision on public.absences;
create trigger absences_log_decision after insert or update on public.absences
  for each row execute function public.absence_log_decision();

-- Reprise : une ligne par absence déjà décidée
insert into public.absence_decision_log (absence_id, user_id, decision, kind, start_date, end_date, note, decided_by, decided_at, comment)
  select a.id, a.user_id, a.decision, a.kind, a.start_date, a.end_date, a.note, a.decided_by, a.decided_at, a.decision_comment
  from public.absences a
  where a.decision is not null and a.decided_at is not null and a.status <> 'draft'
    and not exists (select 1 from public.absence_decision_log l where l.absence_id = a.id and l.decided_at = a.decided_at);

-- ===== 2. Portée de l'export =====
create or replace function public.absence_export_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_direction_admin()
      or exists (select 1 from public.absence_validators av
                 join public.profiles v on v.id = av.user_id and v.role in ('cadre', 'direction') and v.absence_validator
                 where av.user_id = auth.uid());
$$;
revoke execute on function public.absence_export_allowed() from public, anon;
grant execute on function public.absence_export_allowed() to authenticated;

-- ===== 3. Absences annotées sur une fenêtre =====
create or replace function public.absence_export(p_from date, p_to date)
returns table (id bigint, user_id uuid, name text, role text, clinics text[], kind text, note text, start_date date, end_date date, status text, stage int,
  change_type text, change_kind text, change_note text, change_start date, change_end date, submitted_at timestamptz, decided_at timestamptz,
  decided_by_name text, decision_comment text, approvers text, direction_name text, direction_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if not public.absence_export_allowed() then raise exception 'Réservé aux administrateurs et aux validateurs des absences.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 800 then raise exception 'Fenêtre trop longue (800 jours au plus).'; end if;
  return query
    select a.id, a.user_id, public.member_name(a.user_id), (select p.role from public.profiles p where p.id = a.user_id),
           public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, a.note, a.start_date, a.end_date, a.status, a.stage::int,
           a.change_type, a.change_kind, a.change_note, a.change_start, a.change_end, a.submitted_at, a.decided_at,
           case when a.decided_by is null then null else public.member_name(a.decided_by) end, a.decision_comment,
           (select string_agg(public.member_name(x.validator_id) || ' (' || to_char(x.decided_at at time zone 'Europe/Zurich', 'DD.MM.YYYY HH24:MI') || ')', ', ' order by x.decided_at)
              from public.absence_approvals x where x.absence_id = a.id and x.decision = 'approved' and x.decided_at is not null),
           case when a.direction_by is null then null else public.member_name(a.direction_by) end, a.direction_at
    from public.absences a
    where a.status <> 'draft' and a.start_date <= p_to and a.end_date >= p_from
      and (public.is_direction_admin() or public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a)))
    order by public.member_name(a.user_id), a.start_date, a.id;
end;
$$;

-- ===== 4. Décisions (acceptées, refusées, changements) sur une fenêtre =====
create or replace function public.absence_decisions(p_from date, p_to date)
returns table (user_id uuid, name text, role text, clinics text[], decision text, kind text, note text, start_date date, end_date date,
  decided_at timestamptz, decided_by_name text, comment text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.absence_guard();
  if not public.absence_export_allowed() then raise exception 'Réservé aux administrateurs et aux validateurs des absences.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 800 then raise exception 'Fenêtre trop longue (800 jours au plus).'; end if;
  return query
    select l.user_id, public.member_name(l.user_id), (select p.role from public.profiles p where p.id = l.user_id),
           public.member_clinics(l.user_id, l.start_date, l.end_date), l.decision, l.kind, l.note, l.start_date, l.end_date, l.decided_at,
           case when l.decided_by is null then null else public.member_name(l.decided_by) end, l.comment
    from public.absence_decision_log l
    where l.start_date <= p_to and l.end_date >= p_from
      and (public.is_direction_admin() or public.can_validate_absence(auth.uid(), l.user_id, l.start_date, l.end_date))
    order by public.member_name(l.user_id), l.decided_at;
end;
$$;

revoke execute on function public.absence_export(date, date), public.absence_decisions(date, date) from public, anon;
grant execute on function public.absence_export(date, date), public.absence_decisions(date, date) to authenticated;
