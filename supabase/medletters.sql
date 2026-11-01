-- Onconic : lettres médicales d'attitude (accès « médecin plus », invisible des autres membres).
-- À exécuter une fois dans Supabase > SQL Editor > Run (peut être relancé sans risque).
-- Aucune donnée patient n'est stockée : seules les lettres types (modèles de traitement) sont en base.

-- 1. Accès « médecin plus » : drapeau caché sur le profil, attribué par un admin uniquement
alter table public.profiles add column if not exists med_plus boolean not null default false;
-- Les membres ne modifient que leurs champs personnels (cf. user_profile.sql) : med_plus n'en fait pas partie.

create or replace function public.is_med_plus()
returns boolean language sql stable security definer set search_path = public as $$
  select public.tool_allowed(auth.uid(), 'medletters');
$$;
revoke execute on function public.is_med_plus() from public, anon;
grant execute on function public.is_med_plus() to authenticated;

-- Liste des médecins et attribution de l'accès, réservées aux admins
create or replace function public.medletters_members()
returns table (id uuid, name text, institution text, med_plus boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select p.id, coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), p.full_name, '(sans nom)'),
           p.institution, p.med_plus
    from public.profiles p where p.role in ('clinician', 'pharmacist') order by 2;
end;
$$;
revoke execute on function public.medletters_members() from public, anon;
grant execute on function public.medletters_members() to authenticated;

create or replace function public.medletters_set_access(p_user uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  update public.profiles set med_plus = p_on where id = p_user and role in ('clinician', 'pharmacist');
end;
$$;
revoke execute on function public.medletters_set_access(uuid, boolean) from public, anon;
grant execute on function public.medletters_set_access(uuid, boolean) to authenticated;

-- 2. Lettres types (modèles) : importées depuis Word par un admin, ou proposées par un médecin plus (brouillon)
create table if not exists public.medletter_templates (
  id bigint generated always as identity primary key,
  title text not null check (char_length(title) between 2 and 200),
  clinic text,
  treatment text,                       -- schéma en clair, ex. « Pembrolizumab + pemetrexed-carboplatine »
  drugs text[] not null default '{}',   -- DCI en minuscules, pour la correspondance
  trial text,                           -- étude de référence
  body text not null check (char_length(body) between 20 and 30000),
  source_file text,
  origin text not null default 'import' check (origin in ('import', 'generated')),
  status text not null default 'draft' check (status in ('draft', 'validated')),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  validated_by uuid references auth.users (id) on delete set null,
  validated_at timestamptz
);
create index if not exists medletter_templates_drugs_idx on public.medletter_templates using gin (drugs);

alter table public.medletter_templates enable row level security;

drop policy if exists "medletter_templates: read" on public.medletter_templates;
create policy "medletter_templates: read" on public.medletter_templates for select to authenticated
  using (public.current_role_name() = 'admin'
     or (public.is_med_plus() and (status = 'validated' or created_by = auth.uid())));

-- Un médecin plus propose un modèle : toujours en brouillon, à son nom
drop policy if exists "medletter_templates: propose draft" on public.medletter_templates;
create policy "medletter_templates: propose draft" on public.medletter_templates for insert to authenticated
  with check (public.is_med_plus() and status = 'draft' and origin = 'generated' and created_by = auth.uid()
              and validated_by is null and validated_at is null);

-- L'admin importe, corrige, valide et supprime
drop policy if exists "medletter_templates: admin write" on public.medletter_templates;
create policy "medletter_templates: admin write" on public.medletter_templates for all to authenticated
  using (public.current_role_name() = 'admin') with check (public.current_role_name() = 'admin');

revoke all on public.medletter_templates from anon;
grant select, insert, update, delete on public.medletter_templates to authenticated;

-- 3. Compteur d'utilisation de l'API (garde-fou de coût), écrit uniquement par l'Edge Function
create table if not exists public.medletter_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default current_date,
  calls int not null default 0,
  input_tokens int not null default 0,
  cached_tokens int not null default 0,
  output_tokens int not null default 0,
  primary key (user_id, day)
);
alter table public.medletter_usage enable row level security;
drop policy if exists "medletter_usage: admin read" on public.medletter_usage;
create policy "medletter_usage: admin read" on public.medletter_usage for select to authenticated
  using (public.current_role_name() = 'admin');
revoke all on public.medletter_usage from anon;
revoke insert, update, delete on public.medletter_usage from authenticated;
grant select on public.medletter_usage to authenticated;

-- Réserve un appel (limite quotidienne) puis enregistre la consommation ; appelées par l'Edge Function (service_role)
create or replace function public.medletter_take(p_user uuid, p_limit int)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.medletter_usage (user_id, day, calls) values (p_user, current_date, 1)
  on conflict (user_id, day) do update set calls = medletter_usage.calls + 1
  returning calls into n;
  return n <= p_limit;
end;
$$;
create or replace function public.medletter_log(p_user uuid, p_in int, p_cached int, p_out int)
returns void language sql security definer set search_path = public as $$
  update public.medletter_usage set input_tokens = input_tokens + p_in, cached_tokens = cached_tokens + p_cached,
    output_tokens = output_tokens + p_out where user_id = p_user and day = current_date;
$$;
revoke execute on function public.medletter_take(uuid, int) from public, anon, authenticated;
revoke execute on function public.medletter_log(uuid, int, int, int) from public, anon, authenticated;
grant execute on function public.medletter_take(uuid, int) to service_role;
grant execute on function public.medletter_log(uuid, int, int, int) to service_role;
