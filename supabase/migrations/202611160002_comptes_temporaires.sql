-- Comptes temporaires créés par les cadres administratifs (16.11.2026). Transactionnel et réexécutable.
--
-- 1. Fonction « cadre administratif » : profiles.admin_lead, posée par l'admin ou la direction sur une assistante (rôle assistant).
-- 2. Fin d'accès : profiles.access_until (dernier jour inclus, heure suisse). Au-delà, le compte n'a plus aucun droit :
--    current_role_name() rend 'member' et tool_allowed() refuse tout. Le compte est en plus bloqué à la connexion
--    (auth.users.banned_until) par temp_accounts_expire(), appelée à l'ouverture de la page et chaque nuit en production.
-- 3. Les cadres administratifs créent eux-mêmes un compte temporaire (Edge Function temp-account, rôle assistant uniquement,
--    validé d'office), prolongent ou terminent l'accès des comptes temporaires, rien d'autre. Chaque action est journalisée.
begin;

alter table public.profiles add column if not exists admin_lead boolean not null default false;
alter table public.profiles add column if not exists access_until date;
alter table public.profiles add column if not exists created_by uuid references auth.users (id) on delete set null;
comment on column public.profiles.admin_lead is 'Cadre administratif : crée et gère les comptes temporaires (rôle assistant seulement).';
comment on column public.profiles.access_until is 'Dernier jour d''accès (inclus, heure suisse) ; vide = sans limite.';
comment on column public.profiles.created_by is 'Auteur de la création d''un compte temporaire.';

-- Journal des comptes temporaires (création, prolongation, fin d'accès, blocage)
create table if not exists public.temp_account_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid references auth.users (id) on delete set null,
  target uuid references auth.users (id) on delete set null,
  action text not null check (action in ('create', 'extend', 'end', 'expire', 'set_until', 'lead_on', 'lead_off')),
  detail jsonb not null default '{}'::jsonb
);
create index if not exists temp_account_log_target on public.temp_account_log (target);
create index if not exists temp_account_log_actor on public.temp_account_log (actor);
alter table public.temp_account_log enable row level security;
revoke all on public.temp_account_log from anon, authenticated;

create or replace function public.ch_date() returns date
language sql stable set search_path = '' as $$ select (now() at time zone 'Europe/Zurich')::date $$;

-- Rôle courant : un compte dont l'accès a pris fin redevient « en attente » partout
create or replace function public.current_role_name() returns text
language sql stable security definer set search_path to 'public' as $$
  select case when p.access_until is not null and p.access_until < public.ch_date() then 'member' else p.role end
    from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.is_admin_lead() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select coalesce((select p.role = 'assistant' and p.admin_lead and (p.access_until is null or p.access_until >= public.ch_date())
    from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.can_manage_temps() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select public.is_admin_lead() or public.is_direction_admin();
$$;

-- Accès par outil : identique à la version précédente, plus la fin d'accès et l'outil « temporaires »
create or replace function public.tool_allowed(p_user uuid, p_tool text)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare r text; i text; m boolean; o boolean; u date; l boolean;
begin
  select role, institution, med_plus, access_until, admin_lead into r, i, m, u, l from public.profiles where id = p_user;
  if r is null or r = 'member' then return false; end if;
  if u is not null and u < public.ch_date() then return false; end if;
  if r = 'admin' then return true; end if;
  if p_tool = 'temporaires' then return r = 'direction' or (r = 'assistant' and coalesce(l, false)); end if;
  if p_tool = 'absences' and coalesce(i, '') <> 'CHUV' then return false; end if;
  if r = 'direction' then return p_tool in ('absences', 'congres', 'formation', 'annuaire', 'contacts', 'oncoodle'); end if;
  if p_tool = 'medletters' then return r in ('clinician', 'cdc', 'cadre', 'pharmacist') and coalesce(m, false); end if;
  select allowed into o from public.tool_access where user_id = p_user and tool = p_tool;
  if found then return o; end if;
  i := coalesce(i, '');
  return case p_tool
    when 'absences' then r in ('clinician', 'cdc', 'cadre', 'pharmacist')
    when 'congres' then r in ('clinician', 'cdc', 'cadre', 'pharmacist')
    when 'trials' then r in ('clinician', 'cdc', 'cadre', 'pharmacist', 'nurse')
    when 'formation' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse')
    when 'annuaire' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse') and i = 'CHUV'
    when 'contacts' then r in ('clinician', 'cdc', 'cadre', 'assistant', 'pharmacist', 'nurse') and i = 'CHUV'
    when 'lettres' then r = 'pharmacist' or (r in ('clinician', 'cdc', 'cadre', 'assistant') and i = 'CHUV')
    when 'limitations' then r in ('clinician', 'cdc', 'cadre', 'pharmacist')
    when 'duree' then r = 'pharmacist' or (r in ('assistant', 'clinician', 'cdc', 'cadre', 'nurse') and i = 'CHUV')
    when 'oncoodle' then true
    else false end;
end;
$function$;

create or replace function public.my_tools() returns text[]
language sql stable security definer set search_path to 'public' as $$
  select coalesce(array_agg(t), '{}') from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'medletters', 'annuaire', 'contacts', 'formation', 'absences', 'oncoodle', 'temporaires']) t
  where public.tool_allowed(auth.uid(), t);
$$;

-- Changement de rôle : la fonction cadre administratif ne survit pas à un rôle autre qu'assistant
create or replace function public.admin_set_role(p_user uuid, p_role text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
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
    admin_lead = case when p_role = 'assistant' then admin_lead else false end
    where id = p_user;
  if p_role not in ('cadre', 'direction') then delete from public.absence_validators where user_id = p_user; end if;
  delete from public.tool_access where user_id = p_user;
  perform public.absence_recheck();
end;
$function$;

-- Blocage de connexion d'un compte (date lointaine plutôt que « infinity », que le service Auth ne lit pas)
create or replace function public.temp_account_ban(p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  -- Le déblocage ne lève que le blocage posé ici (date repère), jamais un blocage d'une autre origine
  if p_on then
    update auth.users set banned_until = timestamptz '2999-12-31 00:00+00' where id = p_user;
  else
    update auth.users set banned_until = null where id = p_user and banned_until = timestamptz '2999-12-31 00:00+00';
  end if;
end;
$$;
revoke execute on function public.temp_account_ban(uuid, boolean) from public, anon, authenticated;

-- Fin d'accès atteinte : blocage de la connexion (appelée chaque nuit en production et à l'ouverture de la page)
create or replace function public.temp_accounts_expire() returns integer
language plpgsql security definer set search_path to 'public' as $$
declare v_n integer := 0; v_id uuid;
begin
  for v_id in
    select p.id from public.profiles p join auth.users u on u.id = p.id
     where p.access_until is not null and p.access_until < public.ch_date()
       and (u.banned_until is null or u.banned_until < now())
  loop
    perform public.temp_account_ban(v_id, true);
    insert into public.temp_account_log (actor, target, action) values (null, v_id, 'expire');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.temp_accounts_expire() from public, anon, authenticated;

-- Liste des comptes temporaires (comptes avec une fin d'accès), pour les cadres administratifs et la direction
create or replace function public.temp_accounts() returns table (
  id uuid, email text, first_name text, last_name text, access_until date, active boolean,
  created_at timestamptz, last_sign_in_at timestamptz, created_by_name text)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not public.can_manage_temps() then raise exception 'Réservé aux cadres administratifs.' using errcode = '42501'; end if;
  perform public.temp_accounts_expire();
  return query
    select p.id, u.email::text, p.first_name, p.last_name, p.access_until, p.access_until >= public.ch_date(),
           u.created_at, u.last_sign_in_at, public.member_name(p.created_by)
      from public.profiles p join auth.users u on u.id = p.id
     where p.access_until is not null and p.role = 'assistant' and p.created_by is not null
     order by (p.access_until >= public.ch_date()) desc, p.access_until desc, lower(coalesce(p.last_name, ''));
end;
$$;
revoke execute on function public.temp_accounts() from public, anon;
grant execute on function public.temp_accounts() to authenticated;

-- Prolonger, raccourcir ou terminer l'accès d'un compte temporaire (jamais d'un compte permanent)
create or replace function public.temp_account_set_until(p_user uuid, p_until date) returns date
language plpgsql security definer set search_path to 'public' as $$
declare v_role text; v_old date; v_lead boolean; v_by uuid; v_today date := public.ch_date();
begin
  if not public.can_manage_temps() then raise exception 'Réservé aux cadres administratifs.' using errcode = '42501'; end if;
  if p_until is null then raise exception 'Indiquez une date de fin d''accès.'; end if;
  if p_until > v_today + 366 then raise exception 'Fin d''accès trop lointaine (un an au plus).'; end if;
  if p_until < v_today - 1 then p_until := v_today - 1; end if;
  -- Compte temporaire = créé par un cadre administratif (created_by) ; une limite posée par l'admin sur un compte permanent n'en fait pas un
  select role, access_until, admin_lead, created_by into v_role, v_old, v_lead, v_by from public.profiles where id = p_user for update;
  if v_role is null or v_old is null or v_by is null or v_role <> 'assistant' or v_lead then
    raise exception 'Ce compte n''est pas un compte temporaire.' using errcode = '42501';
  end if;
  update public.profiles set access_until = p_until where id = p_user;
  perform public.temp_account_ban(p_user, p_until < v_today);
  insert into public.temp_account_log (actor, target, action, detail)
    values (auth.uid(), p_user, case when p_until < v_today then 'end' else 'extend' end, jsonb_build_object('from', v_old, 'to', p_until));
  return p_until;
end;
$$;
revoke execute on function public.temp_account_set_until(uuid, date) from public, anon;
grant execute on function public.temp_account_set_until(uuid, date) to authenticated;

-- Administration : fonction cadre administratif (assistante permanente seulement)
create or replace function public.admin_set_admin_lead(p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_role text; v_until date;
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  select role, access_until into v_role, v_until from public.profiles where id = p_user;
  if v_role is null then raise exception 'Membre introuvable.'; end if;
  if p_on and v_role <> 'assistant' then raise exception 'La fonction cadre administratif est réservée au rôle Assistante.'; end if;
  if p_on and v_until is not null then raise exception 'Un compte temporaire ne peut pas être cadre administratif.'; end if;
  update public.profiles set admin_lead = p_on where id = p_user;
  insert into public.temp_account_log (actor, target, action) values (auth.uid(), p_user, case when p_on then 'lead_on' else 'lead_off' end);
end;
$$;
revoke execute on function public.admin_set_admin_lead(uuid, boolean) from public, anon;
grant execute on function public.admin_set_admin_lead(uuid, boolean) to authenticated;

-- Administration : fin d'accès de n'importe quel compte non administrateur (vide = sans limite)
create or replace function public.admin_set_access_until(p_user uuid, p_until date) returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_role text; v_old date;
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'Vous ne pouvez pas limiter votre propre accès.'; end if;
  select role, access_until into v_role, v_old from public.profiles where id = p_user for update;
  if v_role is null then raise exception 'Membre introuvable.'; end if;
  if v_role in ('admin', 'direction') then raise exception 'Les comptes admin et direction ne sont pas limités dans le temps.'; end if;
  update public.profiles set access_until = p_until,
    admin_lead = case when p_until is null then admin_lead else false end where id = p_user;
  perform public.temp_account_ban(p_user, p_until is not null and p_until < public.ch_date());
  insert into public.temp_account_log (actor, target, action, detail) values (auth.uid(), p_user, 'set_until', jsonb_build_object('from', v_old, 'to', p_until));
end;
$$;
revoke execute on function public.admin_set_access_until(uuid, date) from public, anon;
grant execute on function public.admin_set_access_until(uuid, date) to authenticated;

-- Compléments de la liste des membres (sans changer la signature de admin_members)
create or replace function public.admin_members_extra() returns table (id uuid, admin_lead boolean, access_until date, created_by_name text)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.is_direction_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return query select p.id, p.admin_lead, p.access_until, public.member_name(p.created_by) from public.profiles p;
end;
$$;
revoke execute on function public.admin_members_extra() from public, anon;
grant execute on function public.admin_members_extra() to authenticated;

revoke execute on function public.is_admin_lead() from public, anon;
grant execute on function public.is_admin_lead() to authenticated;
revoke execute on function public.can_manage_temps() from public, anon;
grant execute on function public.can_manage_temps() to authenticated;

do $$
begin
  if to_regclass('public.onconic_migrations') is not null then
    insert into public.onconic_migrations(version) values ('202611160002') on conflict do nothing;
  end if;
end $$;

commit;
