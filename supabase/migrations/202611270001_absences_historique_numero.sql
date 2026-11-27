-- Absences : historique des demandes (plus de purge des refus), archivage, numéro unique de demande AAAA-NNNN, recherche par numéro (27.11.2026).
-- À appliquer après 202611230002. Transactionnel et réexécutable.
--
-- Points de coupure possibles pour une application par lots (le fichier dépasse 25 Ko ; commentaires retirés, coupure entre deux instructions hors $$) :
--   lot 1 = sections 1 à 3 (colonnes, compteur, déclencheur, reprise des données existantes) ;
--   lot 2 = sections 4 et 5 (droit de voir une demande, historique, recherche, fin de la purge, archivage, retraits) ;
--   lot 3 = sections 6 à 8 (listes et exports avec le numéro, documents figés, droits d'exécution, version).
-- Chaque lot peut être rejoué seul ; le lot 1 doit passer avant les autres.
--
-- Décisions : une demande est une ligne de `absences` ; un brouillon n'a pas de numéro ; le numéro est posé au premier passage hors brouillon
-- et ne change plus jamais. Plus aucune demande non brouillon n'est supprimée : un refus de plus de 14 jours quitte seulement les listes actives.

begin;

-- 1. Colonnes, compteur annuel, numéro -------------------------------------------------------------------------------------------

alter table public.absences add column if not exists request_no text;
alter table public.absences add column if not exists archived_at timestamptz;
alter table public.absences add column if not exists archived_by uuid references auth.users (id) on delete set null;

create table if not exists public.absence_request_counters (
  year int primary key,
  last int not null check (last >= 0)
);
alter table public.absence_request_counters enable row level security;
revoke all on public.absence_request_counters from anon, authenticated;

-- 2. Déclencheur : numéro posé au premier passage hors brouillon, jamais modifié ni effacé ---------------------------------------

create or replace function public.absence_request_no_set() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare y int; n int;
begin
  if tg_op = 'UPDATE' and old.request_no is not null and new.request_no is distinct from old.request_no then
    raise exception 'Le numéro de demande ne peut être ni modifié ni effacé.' using errcode = '42501';
  end if;
  -- une demande refusée archivée qui quitte l'état « refusée » (modifiée puis renvoyée) n'est plus archivée
  if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status <> 'rejected' and new.archived_at is not null then
    new.archived_at := null; new.archived_by := null;
  end if;
  if new.status <> 'draft' and new.request_no is null then
    -- année civile de Zurich de la soumission ; compteur par année, incrémenté de façon atomique
    y := extract(year from (coalesce(new.submitted_at, now()) at time zone 'Europe/Zurich'))::int;
    insert into public.absence_request_counters as c (year, last) values (y, 1)
      on conflict (year) do update set last = c.last + 1
      returning c.last into n;
    -- lpad tronque au-delà de 4 caractères : au-delà de 9999, le nombre s'écrit en entier
    new.request_no := y::text || '-' || case when n < 10000 then lpad(n::text, 4, '0') else n::text end;
  end if;
  return new;
end;
$$;
revoke execute on function public.absence_request_no_set() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.absences'::regclass and tgname = 'absence_request_no' and not tgisinternal) then
    create trigger absence_request_no before insert or update on public.absences
      for each row execute function public.absence_request_no_set();
  end if;
end $$;

-- 3. Reprise : numérote les demandes non brouillon déjà présentes (année de dépôt à Zurich, puis ordre chronologique, puis id) -----
-- Ne touche que les lignes sans numéro ; repart du compteur existant s'il y en a un.

with todo as (
  select a.id, extract(year from (coalesce(a.submitted_at, a.created_at) at time zone 'Europe/Zurich'))::int as y,
         row_number() over (partition by extract(year from (coalesce(a.submitted_at, a.created_at) at time zone 'Europe/Zurich'))
                            order by coalesce(a.submitted_at, a.created_at), a.id) as rn
    from public.absences a
   where a.status <> 'draft' and a.request_no is null
), num as (
  select t.id, t.y, t.rn + coalesce(c.last, 0) as n
    from todo t left join public.absence_request_counters c on c.year = t.y
), upd as (
  update public.absences a
     set request_no = n.y::text || '-' || case when n.n < 10000 then lpad(n.n::text, 4, '0') else n.n::text end
    from num n where a.id = n.id
  returning n.y, n.n
)
insert into public.absence_request_counters as c (year, last)
  select u.y, max(u.n) from upd u group by u.y
  on conflict (year) do update set last = greatest(c.last, excluded.last);

create unique index if not exists absences_request_no_key on public.absences (request_no) where request_no is not null;

-- 4. Droit de voir une demande, historique, recherche ------------------------------------------------------------------------------

-- Une demande (hors brouillon) est visible par la personne, ses validateurs, la direction et l'administration, la secrétaire de ce médecin cadre
-- et les personnes d'une étape « personnes » de la demande (comme absence_list, absence_rejected_to_manage et absence_delete_rejected).
-- Validateurs : variante de can_validate_absence SANS dates (toutes les cliniques connues du membre, actuelles et programmées), comme absence_list :
-- un cadre qui voit la personne dans ses listes retrouve aussi ses anciennes demandes, même si la clinique de la personne a changé depuis.
-- Fonction interne : l'appelant est toujours auth.uid().
create or replace function public.absence_can_view_request(p_uid uuid, a public.absences) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    p_uid is not null and a.status <> 'draft' and (
      a.user_id = p_uid
      or coalesce((select (case when p.access_until is not null and p.access_until < public.ch_date() then 'member' else p.role end) in ('admin', 'direction')
                     from public.profiles p where p.id = p_uid), false)
      or public.can_validate_absence(p_uid, a.user_id)
      or public.is_secretary_of(p_uid, a.user_id)
      or public.absence_in_personnes_step(p_uid, a)), false);
$$;
revoke execute on function public.absence_can_view_request(uuid, public.absences) from public, anon, authenticated;

-- Noyau commun de l'historique et de la recherche (fonction interne) ; p_no_n / p_no_year : numéro cherché (sans année : toutes les années)
drop function if exists public.absence_requests_core(uuid, uuid, int, text[], text, int, int, int, int);
create function public.absence_requests_core(p_uid uuid, p_user uuid, p_year int, p_status text[], p_q text, p_no_year int, p_no_n int, p_limit int, p_offset int)
returns table(id bigint, request_no text, user_id uuid, name text, kind text, note text, start_date date, end_date date, status text, change_type text, change_kind text,
  change_start date, change_end date, submitted_at timestamptz, decided_at timestamptz, decided_by_name text, decision text, decision_comment text, archived_at timestamptz, circuit_name text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare q text := nullif(lower(trim(coalesce(p_q, ''))), ''); adm boolean;
begin
  adm := coalesce((select (case when p.access_until is not null and p.access_until < public.ch_date() then 'member' else p.role end) in ('admin', 'direction')
                     from public.profiles p where p.id = p_uid), false);
  return query
    select a.id, a.request_no, a.user_id, public.member_name(a.user_id), a.kind,
           case when not a.confidential or a.user_id = p_uid or adm then a.note end,
           a.start_date, a.end_date, a.status, a.change_type, a.change_kind, a.change_start, a.change_end,
           coalesce(a.submitted_at, a.created_at), a.decided_at,
           case when a.decided_by is null then null else public.member_name(a.decided_by) end, a.decision,
           case when not a.confidential or a.user_id = p_uid or adm then a.decision_comment end,
           a.archived_at, a.circuit_name
      from public.absences a
     where a.status <> 'draft'
       and public.absence_can_view_request(p_uid, a)
       and (p_user is null or a.user_id = p_user)
       and (p_year is null or extract(year from (coalesce(a.submitted_at, a.created_at) at time zone 'Europe/Zurich'))::int = p_year)
       and (p_status is null or a.status = any (p_status))
       and (p_no_n is null or (a.request_no is not null and split_part(a.request_no, '-', 2)::int = p_no_n
                               and (p_no_year is null or split_part(a.request_no, '-', 1)::int = p_no_year)))
       and (q is null or strpos(lower(public.member_name(a.user_id)), q) > 0
            or strpos(case a.kind when 'vacances' then 'vacances' when 'congres' then 'congrès congres' else 'autre' end, q) > 0
            or (a.request_no is not null and strpos(a.request_no, q) > 0))
     order by coalesce(a.submitted_at, a.created_at) desc, a.id desc
     limit greatest(1, least(coalesce(p_limit, 200), 500)) offset greatest(0, coalesce(p_offset, 0));
end;
$$;
revoke execute on function public.absence_requests_core(uuid, uuid, int, text[], text, int, int, int, int) from public, anon, authenticated;

-- Historique : toutes les demandes hors brouillon que l'appelant a le droit de voir (aucune erreur sur une personne hors périmètre : liste vide)
drop function if exists public.absence_requests_history(uuid, int, text[], text, int, int);
create function public.absence_requests_history(p_user uuid default null, p_year int default null, p_status text[] default null, p_q text default null, p_limit int default 200, p_offset int default 0)
returns table(id bigint, request_no text, user_id uuid, name text, kind text, note text, start_date date, end_date date, status text, change_type text, change_kind text,
  change_start date, change_end date, submitted_at timestamptz, decided_at timestamptz, decided_by_name text, decision text, decision_comment text, archived_at timestamptz, circuit_name text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare st text[];
begin
  perform public.absence_guard();
  if p_status is not null then
    st := array(select s from unnest(p_status) s where s in ('requested', 'approved', 'rejected', 'cancelled'));
    if cardinality(st) = 0 then return; end if;
  end if;
  return query select * from public.absence_requests_core(auth.uid(), p_user, p_year, st, p_q, null, null, p_limit, p_offset);
end;
$$;

-- Recherche par numéro : complet (2026-0012), partiel (0012, 12) ou avec année (2026-12) ; espaces et casse ignorés ; 50 résultats au plus ;
-- mêmes droits que l'historique, un numéro hors périmètre ne donne rien (comme un numéro qui n'existe pas)
drop function if exists public.absence_find(text);
create function public.absence_find(p_q text)
returns table(id bigint, request_no text, user_id uuid, name text, kind text, note text, start_date date, end_date date, status text, change_type text, change_kind text,
  change_start date, change_end date, submitted_at timestamptz, decided_at timestamptz, decided_by_name text, decision text, decision_comment text, archived_at timestamptz, circuit_name text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s text; y int; n int;
begin
  perform public.absence_guard();
  s := regexp_replace(lower(coalesce(p_q, '')), '\s+', '', 'g');
  s := regexp_replace(s, '^(n°|no\.?|n\.?)', '');
  if length(s) > 20 then return; end if;
  if s ~ '^[0-9]{4}[-/.][0-9]{1,6}$' then
    y := substr(s, 1, 4)::int; n := substr(s, 6)::int;
  elsif s ~ '^[0-9]{1,6}$' then
    -- « 2026 » (quatre chiffres commençant par 20) est une année : recherche texte et filtre d'année, pas un numéro
    if s ~ '^20[0-9]{2}$' then return; end if;
    n := s::int;
  else
    return;
  end if;
  return query select * from public.absence_requests_core(auth.uid(), null, null, null, null, y, n, 50, 0);
end;
$$;

-- 5. Fin de la purge, archivage, retraits -----------------------------------------------------------------------------------------

-- Conservée pour ne casser aucun appel (fonctions SQL, fonction Edge) : ne supprime plus rien
create or replace function public.absence_purge() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return;
end;
$$;

-- Archiver une demande refusée : l'usager, ses validateurs ou une personne de l'étape. La demande quitte les listes actives, jamais l'historique.
create or replace function public.absence_delete_rejected(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); a public.absences;
begin
  perform public.absence_guard();
  select * into a from public.absences where id = p_id for update;
  if not found or a.status <> 'rejected' then raise exception 'Demande refusée introuvable.'; end if;
  if a.user_id <> uid and not public.can_validate_absence(uid, a.user_id, public.absence_lo(a), public.absence_hi(a)) and not public.absence_in_personnes_step(uid, a) then
    raise exception 'Accès refusé.' using errcode = '42501';
  end if;
  if a.archived_at is null then
    update public.absences set archived_at = now(), archived_by = uid where id = p_id;
  end if;
end;
$$;

-- Retirer : un brouillon jamais envoyé est supprimé ; un brouillon qui a déjà un numéro (demande remise en brouillon) devient « annulé » ;
-- une demande refusée est archivée ; une demande en cours est annulée
create or replace function public.absence_withdraw(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); s text; rn text;
begin
  perform public.absence_guard();
  select status, request_no into s, rn from public.absences where id = p_id and user_id = uid for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if s = 'approved' then raise exception 'Une absence validée se supprime par une demande de suppression.'; end if;
  if s = 'draft' and rn is null then
    delete from public.absences where id = p_id;
  elsif s = 'rejected' then
    update public.absences set archived_at = coalesce(archived_at, now()), archived_by = coalesce(archived_by, uid) where id = p_id;
  else
    update public.absences set status = 'cancelled', change_type = null, change_kind = null, change_note = null, change_start = null,
      change_end = null, change_requested_at = null where id = p_id and status in ('requested', 'draft');
    delete from public.absence_approvals where absence_id = p_id;
  end if;
end;
$$;

create or replace function public.absence_withdraw_for(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); s text; o uuid; rb uuid; rn text;
begin
  perform public.absence_guard();
  select user_id, status, requested_by, request_no into o, s, rb, rn from public.absences where id = p_id for update;
  if not found then raise exception 'Absence introuvable.'; end if;
  if not public.is_secretary_of(uid, o) then raise exception 'Accès refusé.' using errcode = '42501'; end if;
  if rb is distinct from uid then raise exception 'Vous ne retirez que les demandes que vous avez saisies.' using errcode = '42501'; end if;
  if s = 'approved' then raise exception 'Une absence validée se supprime par une demande de suppression.'; end if;
  if s = 'draft' and rn is null then
    delete from public.absences where id = p_id;
  elsif s = 'rejected' then
    update public.absences set archived_at = coalesce(archived_at, now()), archived_by = coalesce(archived_by, uid) where id = p_id;
  else
    update public.absences set status = 'cancelled', change_type = null, change_kind = null, change_note = null, change_start = null,
      change_end = null, change_requested_at = null where id = p_id and status in ('requested', 'draft');
    delete from public.absence_approvals where absence_id = p_id;
  end if;
end;
$$;

-- 6. Listes actives et exports : numéro de demande, demandes archivées masquées ----------------------------------------------------

-- Mes absences (le numéro vient de la colonne request_no, qui fait partie du type de retour) ; refus de plus de 14 jours et demandes archivées masqués
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
      || case when not public.is_direction_admin() then jsonb_build_object('escalation_note', null) else '{}'::jsonb end
      || jsonb_build_object('stage', public.absence_stage_compat(a), 'circuit', public.absence_circuit_public(a)))).*
    from public.absences a where a.user_id = coalesce(p_user, uid) and (perm or public.absence_in_personnes_step(uid, a))
    and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
    and a.archived_at is null
    -- les brouillons restent à l'intéressé ; une secrétaire voit ceux qu'elle a saisis pour son cadre
    and (a.status <> 'draft' or a.user_id = uid or (a.requested_by = uid and public.is_secretary_of(uid, a.user_id)))
    order by a.start_date desc;
end;
$$;

-- Avancement des validations (Mes absences) : mêmes filtres que absence_list (refus de plus de 14 jours et demandes archivées masqués)
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
      and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
      and a.archived_at is null
    order by a.id, r.step, r.name;
end;
$$;

-- À valider : colonne request_no en plus (le type de retour change)
do $$
begin
  if to_regprocedure('public.absence_to_validate()') is not null
     and not exists (select 1 from pg_proc where oid = to_regprocedure('public.absence_to_validate()') and 'request_no' = any (proargnames)) then
    drop function public.absence_to_validate();
  end if;
end $$;

create or replace function public.absence_to_validate()
returns table(id bigint, user_id uuid, name text, clinics text[], kind text, note text, start_date date, end_date date, status text, change_type text, change_kind text,
  change_note text, change_start date, change_end date, created_at timestamptz, change_requested_at timestamptz, conflicts jsonb, my_decision text, progress jsonb, stage integer,
  opinions jsonb, step_kind text, step_label text, steps jsonb, escalation jsonb, escalated jsonb, request_no text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.note end, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then a.change_note end, a.change_start, a.change_end, coalesce(a.submitted_at, a.created_at), a.change_requested_at,
           case when a.change_type = 'delete' then '[]'::jsonb
                when a.change_type = 'modify' then public.absence_conflicts_json(a.user_id, a.change_start, a.change_end)
                else public.absence_conflicts_json(a.user_id, a.start_date, a.end_date) end,
           coalesce((select p.decision from public.absence_approvals p where p.absence_id = a.id and p.validator_id = auth.uid()
                      order by (p.step in (select (e ->> 'pos')::int from jsonb_array_elements(public.absence_steps_of(a)) e)) desc limit 1), 'pending'),
           coalesce((select jsonb_agg(jsonb_build_object('name', r.name, 'decision', r.decision, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then r.comment end, 'at', r.at, 'step', r.step, 'step_label', r.step_label)
                     order by r.step, r.name) from public.absence_decision_rows(a) r), '[]'::jsonb),
           public.absence_stage_compat(a),
           coalesce((select jsonb_agg(jsonb_build_object('name', public.member_name(o.user_id), 'opinion', o.opinion, 'comment', case when not a.confidential or a.user_id=auth.uid() or public.is_direction_admin() then o.comment end, 'at', o.updated_at)
                     order by o.updated_at) from public.absence_opinions o where o.absence_id = a.id), '[]'::jsonb),
           public.absence_col_kind(a), public.absence_col_label(a),
           -- étapes qui retiennent la colonne en cours ; mine : celles qui attendent l'appelant
           coalesce((select jsonb_agg(jsonb_build_object('pos', (e ->> 'pos')::int, 'kind', e ->> 'kind', 'label', e ->> 'label', 'rule', e ->> 'rule',
                       'mine', (public.current_role_name() = 'admin' or public.absence_step_member(auth.uid(), a, e)) and (public.current_role_name() = 'admin' or not public.absence_step_done(auth.uid(), a, e)))
                     order by (e ->> 'pos')::int) from jsonb_array_elements(public.absence_active_steps(a)) e), '[]'::jsonb),
           public.absence_escalation_state(auth.uid(), a),
           case when a.escalated_at is not null then jsonb_build_object('by', public.member_name(a.escalated_by), 'at', a.escalated_at, 'note', a.escalation_note) end,
           a.request_no
    from public.absences a
    where a.status in ('requested', 'approved') and (a.status = 'requested' or a.change_type is not null)
      and public.absence_actionable(auth.uid(), a)
    order by coalesce(a.change_requested_at, a.submitted_at, a.created_at);
end;
$$;

-- Demandes refusées à gérer : refus de moins de 14 jours, hors archives ; colonne request_no en plus
drop function if exists public.absence_rejected_to_manage();
create function public.absence_rejected_to_manage()
returns table(id bigint, user_id uuid, name text, kind text, start_date date, end_date date, decision_comment text, decided_at timestamptz, decided_by_name text, approvals jsonb, request_no text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  return query
    select a.id, a.user_id, public.member_name(a.user_id), a.kind, a.start_date, a.end_date, case when not a.confidential or a.user_id = auth.uid() or public.is_direction_admin() then a.decision_comment end, a.decided_at,
           case when a.decided_by is null then null else public.member_name(a.decided_by) end,
           coalesce((select jsonb_agg(jsonb_build_object('name', r.name, 'decision', r.decision, 'comment', case when not a.confidential or a.user_id = auth.uid() or public.is_direction_admin() then r.comment end, 'at', r.at, 'step', r.step, 'step_label', r.step_label)
                     order by r.step, r.name) from public.absence_decision_rows(a) r where r.decision in ('approved', 'rejected')), '[]'::jsonb),
           a.request_no
    from public.absences a
    where a.status = 'rejected' and a.decided_at >= now() - interval '14 days' and a.archived_at is null
      and (public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a)) or public.absence_in_personnes_step(auth.uid(), a))
    order by a.decided_at desc;
end;
$$;

-- Export : colonne request_no (« N° » dans l'Excel) ; toutes les demandes non brouillon de la fenêtre, archivées comprises
drop function if exists public.absence_export(date, date);
create function public.absence_export(p_from date, p_to date)
returns table(id bigint, request_no text, user_id uuid, name text, role text, clinics text[], kind text, note text, start_date date, end_date date, status text, stage integer, change_type text,
  change_kind text, change_note text, change_start date, change_end date, submitted_at timestamptz, decided_at timestamptz, decided_by_name text, decision_comment text,
  approvers text, direction_name text, direction_at timestamptz, step_kind text, step_label text, state_label text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  if not public.absence_export_allowed() then raise exception 'Réservé aux administrateurs et aux validateurs des absences.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 800 then raise exception 'Fenêtre trop longue (800 jours au plus).'; end if;
  return query
    select a.id, a.request_no, a.user_id, public.member_name(a.user_id), (select p.role from public.profiles p where p.id = a.user_id),
           public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, case when not a.confidential or public.is_direction_admin() then a.note end, a.start_date, a.end_date, a.status, public.absence_stage_compat(a),
           a.change_type, a.change_kind, case when not a.confidential or public.is_direction_admin() then a.change_note end, a.change_start, a.change_end, a.submitted_at, a.decided_at,
           case when a.decided_by is null then null else public.member_name(a.decided_by) end, case when not a.confidential or public.is_direction_admin() then a.decision_comment end,
           (select string_agg(public.member_name(x.validator_id) || ' (' || to_char(x.decided_at at time zone 'Europe/Zurich', 'DD.MM.YYYY HH24:MI') || ')', ', ' order by x.decided_at)
              from public.absence_approvals x where x.absence_id = a.id and x.decision = 'approved' and x.decided_at is not null),
           case when a.direction_by is null then null else public.member_name(a.direction_by) end, a.direction_at,
           case when public.absence_is_open(a) then public.absence_col_kind(a) end,
           case when public.absence_is_open(a) then public.absence_col_label(a) end,
           case when a.status = 'requested' then 'En cours : ' || case coalesce(public.absence_col_kind(a), 'clinique')
                  when 'visa' then 'visa de la direction' when 'clinique' then 'chez les validateurs'
                  else coalesce(public.absence_col_label(a), 'étape suivante') end end
    from public.absences a
    where a.status <> 'draft' and a.start_date <= p_to and a.end_date >= p_from
      and (public.is_direction_admin() or public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a)))
    order by public.member_name(a.user_id), a.start_date, a.id;
end;
$$;

-- Suivi de la direction : colonne request_no, et le numéro figure aussi dans le parcours (trail) ; refus de plus de 14 jours et archives masqués
drop function if exists public.absence_track(date, date);
create function public.absence_track(p_from date, p_to date)
returns table(id bigint, user_id uuid, name text, role text, clinics text[], kind text, note text, start_date date, end_date date, status text, change_type text, change_kind text,
  change_note text, change_start date, change_end date, submitted_at timestamptz, step_label text, escalated boolean, trail jsonb, request_no text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  if not public.is_direction_admin() then raise exception 'Réservé à la direction.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Fenêtre invalide.'; end if;
  if p_to - p_from > 800 then raise exception 'Fenêtre trop longue (800 jours au plus).'; end if;
  return query
    select a.id, a.user_id, public.member_name(a.user_id), (select p.role from public.profiles p where p.id = a.user_id),
           public.member_clinics(a.user_id, public.absence_lo(a), public.absence_hi(a)), a.kind, a.note, a.start_date, a.end_date, a.status,
           a.change_type, a.change_kind, a.change_note, a.change_start, a.change_end, a.submitted_at,
           case when public.absence_is_open(a) then public.absence_col_label(a) end, a.escalated_at is not null,
           public.absence_track_trail(a) || jsonb_build_object('request_no', a.request_no), a.request_no
    from public.absences a
    where a.status <> 'draft'
      and ((a.start_date <= p_to and a.end_date >= p_from) or (a.change_start is not null and a.change_start <= p_to and a.change_end >= p_from))
      and not (a.status = 'rejected' and a.decided_at < now() - interval '14 days')
      and a.archived_at is null
    order by a.start_date, public.member_name(a.user_id), a.id;
end;
$$;

-- Planning (grille) : le numéro n'est donné qu'à qui a le droit de voir la demande ; aucune demande refusée n'y figure (statuts « demandée » et « validée » seulement)
do $$
begin
  if to_regprocedure('public.absence_grid(date, date)') is not null
     and not exists (select 1 from pg_proc where oid = to_regprocedure('public.absence_grid(date, date)') and 'request_no' = any (proargnames)) then
    drop function public.absence_grid(date, date);
  end if;
end $$;

create or replace function public.absence_grid(p_from date, p_to date)
returns table(id bigint, user_id uuid, kind text, status text, start_date date, end_date date, note text, change_type text, change_start date, change_end date, request_no text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.absence_guard();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Période invalide.'; end if;
  return query
    select a.id, a.user_id, a.kind, a.status, a.start_date, a.end_date,
           case when a.user_id = auth.uid() or public.is_direction_admin() or (not a.confidential and public.can_validate_absence(auth.uid(), a.user_id, public.absence_lo(a), public.absence_hi(a))) then a.note end,
           a.change_type, a.change_start, a.change_end,
           case when public.absence_can_view_request(auth.uid(), a) then a.request_no end
    from public.absences a
    where a.status in ('requested', 'approved') and a.start_date <= p_to and a.end_date >= p_from
      and public.absence_can_see(a.user_id, public.absence_lo(a), public.absence_hi(a))
    order by a.start_date;
end;
$$;

-- 7. Documents figés : numéro de demande dans chaque absence -------------------------------------------------------------------------

-- Ajoute request_no (lu en base, immuable) aux absences d'un document déjà figé avant cette migration
create or replace function public.absence_doc_numbers(d jsonb) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when d is null or jsonb_typeof(d -> 'absences') is distinct from 'array' then d
    else jsonb_set(d, '{absences}', coalesce((
      select jsonb_agg(case when x ->> 'request_no' is not null then x
                            else x || jsonb_build_object('request_no', (select a.request_no from public.absences a where a.id = (x ->> 'id')::bigint)) end order by o)
        from jsonb_array_elements(d -> 'absences') with ordinality t(x, o)), '[]'::jsonb)) end;
$$;
revoke execute on function public.absence_doc_numbers(jsonb) from public, anon, authenticated;

create or replace function public.absence_form_data(p_ids bigint[]) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d public.absence_documents;
begin
 select * into d from public.absence_documents where absence_ids @> p_ids order by id desc limit 1;
 if not found then return null; end if;
 return public.absence_doc_numbers(d.data || jsonb_build_object('document_id', d.id, 'generated_at', d.created_at));
end $$;

create or replace function public.absence_document_data(p_document bigint) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
 select public.absence_doc_numbers(data || jsonb_build_object('document_id', id, 'generated_at', created_at)) from public.absence_documents where id = p_document;
$$;

-- Données du document : identiques à 202611230002, plus request_no dans chaque absence
create or replace function public.absence_document_build(p_ids bigint[], p_action text, p_live boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare owner uuid; r text; d jsonb;
begin
 select user_id into owner from public.absences where id=any(p_ids) limit 1;
 if owner is null or exists(select 1 from public.absences where id=any(p_ids) and user_id<>owner) then return null; end if;
 select role into r from public.profiles where id=owner;
 if r not in ('clinician','cdc','cadre') then return null; end if;
 d:=jsonb_build_object('owner_id',owner,'owner',public.member_name(owner),'role',r,'action',p_action,
 'clinics',public.member_clinics(owner),'requested_at',(select min(coalesce(submitted_at,created_at)) from public.absences where id=any(p_ids)),
 'absences',(select jsonb_agg(jsonb_build_object('id',id,'request_no',request_no,'kind',kind,'start_date',start_date,'end_date',end_date,'note',null,'status',status) order by start_date,id) from public.absences where id=any(p_ids)),
 'direction',(select jsonb_build_object('name',public.member_name(direction_by),'at',direction_at) from public.absences where id=any(p_ids) and direction_by is not null order by direction_at desc limit 1),
 'signers',coalesce((select jsonb_agg(jsonb_build_object('name',public.member_name(p.validator_id),'at',p.decided_at,'comment',null) order by p.decided_at)
                     from public.absence_approvals p join public.absences a on a.id=p.absence_id
                     where p.absence_id=any(p_ids) and p.decision='approved' and public.absence_step_kind(a,p.step)='clinique'),'[]'),
 'extra',coalesce((select jsonb_agg(jsonb_build_object('label',st.e->>'label','name',public.member_name(p.validator_id),'at',p.decided_at,'slot',st.e->>'pdf_slot') order by p.decided_at)
                   from public.absence_approvals p join public.absences a on a.id=p.absence_id
                   cross join lateral (select e from jsonb_array_elements(coalesce(a.circuit,'[]'::jsonb)) e where (e->>'pos')::int=p.step and e->>'kind' in ('personnes','direction') and (e->>'blocking')::boolean limit 1) st(e)
                   where p.absence_id=any(p_ids) and p.decision='approved'),'[]'));
 if p_live then
  d:=d||jsonb_build_object(
   'direction',(select jsonb_build_object('name',public.member_name(direction_by),'at',direction_at) from public.absences
                 where id=any(p_ids) and direction_by is not null and direction_at >= coalesce(change_requested_at, submitted_at, created_at) order by direction_at desc limit 1),
   'refusal',(select jsonb_build_object('name',public.member_name(a.decided_by),'at',a.decided_at,
                'comment',case when exists(select 1 from public.absences c where c.id=any(p_ids) and c.confidential) then null else a.decision_comment end,
                'kind',coalesce(rs.e->>'kind','visa'),'label',coalesce(rs.e->>'label','Visa de la direction'),'slot',rs.e->>'pdf_slot')
            from public.absences a
            left join lateral (select e from public.absence_approvals p, jsonb_array_elements(coalesce(a.circuit,'[]'::jsonb)) e
                                where p.absence_id=a.id and p.validator_id=a.decided_by and p.decision='rejected' and (e->>'pos')::int=p.step
                                order by p.decided_at desc limit 1) rs(e) on true
            where a.id=any(p_ids) and a.status='rejected' and a.decision='rejected' and a.decided_by is not null order by a.decided_at desc limit 1));
 end if;
 return d;
end $$;

-- 8. Droits d'exécution et version ------------------------------------------------------------------------------------------------

-- Fonctions internes : fermées à tous les rôles de l'API
revoke execute on function
  public.absence_can_view_request(uuid, public.absences), public.absence_requests_core(uuid, uuid, int, text[], text, int, int, int, int),
  public.absence_doc_numbers(jsonb), public.absence_document_build(bigint[], text, boolean), public.absence_request_no_set()
  from public, anon, authenticated;

-- Fonction Edge (rôle service) : la liste d'accès existante est conservée
revoke execute on function public.absence_form_data(bigint[]), public.absence_document_data(bigint) from public, anon, authenticated;
grant execute on function public.absence_form_data(bigint[]), public.absence_document_data(bigint) to service_role;

-- Appelées par les pages (utilisateurs connectés ; les contrôles de droits sont dans chaque fonction)
revoke execute on function
  public.absence_requests_history(uuid, int, text[], text, int, int), public.absence_find(text), public.absence_delete_rejected(bigint),
  public.absence_withdraw(bigint), public.absence_withdraw_for(bigint), public.absence_list(uuid), public.absence_to_validate(),
  public.absence_rejected_to_manage(), public.absence_export(date, date), public.absence_track(date, date), public.absence_grid(date, date), public.absence_approvals_all(uuid)
  from public, anon;
grant execute on function
  public.absence_requests_history(uuid, int, text[], text, int, int), public.absence_find(text), public.absence_delete_rejected(bigint),
  public.absence_withdraw(bigint), public.absence_withdraw_for(bigint), public.absence_list(uuid), public.absence_to_validate(),
  public.absence_rejected_to_manage(), public.absence_export(date, date), public.absence_track(date, date), public.absence_grid(date, date), public.absence_approvals_all(uuid)
  to authenticated;

-- absence_purge reste appelable par le rôle service seulement, comme avant
revoke execute on function public.absence_purge() from public, anon, authenticated;
grant execute on function public.absence_purge() to service_role;

insert into public.onconic_migrations(version) values ('202611270001') on conflict do nothing;

commit;
