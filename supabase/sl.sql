-- Onconic : Limitations LS (Liste des spécialités de l'OFSP) et textes d'ordonnance per os.
-- À exécuter une fois dans Supabase > SQL Editor > Run (peut être relancé sans risque).
-- La LS est importée depuis /app/limitations.html (admin) ; les textes d'ordonnance sont validés par un admin avant publication.

-- 1. Produits et limitations (oncologie et traitements associés), reprise des tables de l'ancien outil d'initiation
create table if not exists public.sl_products (
  id bigint generated always as identity primary key,
  specialty text not null,
  galenic text,
  substance text not null,
  atc text,
  limited boolean not null default false
);
alter table public.sl_products add column if not exists peros boolean not null default false;

create table if not exists public.sl_limitations (
  id bigint generated always as identity primary key,
  specialty text not null,
  substance text not null,
  atc text,
  galenics text,
  lim_code text not null,
  ind_code text,
  valid_from text,
  valid_to text,
  body text
);
create index if not exists sl_products_substance on public.sl_products (substance);
create index if not exists sl_limitations_substance on public.sl_limitations (substance);

create table if not exists public.sl_meta (
  id int primary key default 1 check (id = 1),
  source_file text,
  imported_at timestamptz,
  product_count int,
  limitation_count int
);

-- Changements de la dernière mise à jour (nouvelles, modifiées, supprimées)
create table if not exists public.sl_changes (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('new', 'changed', 'removed')),
  specialty text not null,
  substance text,
  lim_code text,
  ind_code text
);

-- 2. Textes d'ordonnance per os et paliers de dose : brouillon jusqu'à validation par un admin
create table if not exists public.sl_rx (
  id bigint generated always as identity primary key,
  substance text not null,                 -- clé de correspondance (DCI en minuscules, ex. « osimertinib »)
  product_line text not null,              -- ex. « osimertinib, comprimé 80 mg »
  sig text not null,                       -- ex. « S. 80 mg = 1 cp à prendre une fois par jour »
  dose_levels jsonb not null default '[]', -- [[palier, dose], …]
  dose_note text,
  source text,
  status text not null default 'draft' check (status in ('draft', 'validated')),
  position int not null default 0,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  validated_by uuid references auth.users (id) on delete set null,
  validated_at timestamptz,
  unique (substance, product_line)
);

-- 3. Droits : lecture pour les médecins et pharmaciens ; écriture réservée aux admins et aux pharmaciens
alter table public.sl_products enable row level security;
alter table public.sl_limitations enable row level security;
alter table public.sl_meta enable row level security;
alter table public.sl_changes enable row level security;
alter table public.sl_rx enable row level security;

drop policy if exists "sl_products: clinicians read" on public.sl_products;
create policy "sl_products: clinicians read" on public.sl_products for select to authenticated
  using (public.current_role_name() in ('admin', 'clinician', 'pharmacist'));
drop policy if exists "sl_limitations: clinicians read" on public.sl_limitations;
create policy "sl_limitations: clinicians read" on public.sl_limitations for select to authenticated
  using (public.current_role_name() in ('admin', 'clinician', 'pharmacist'));
drop policy if exists "sl_meta: clinicians read" on public.sl_meta;
create policy "sl_meta: clinicians read" on public.sl_meta for select to authenticated
  using (public.current_role_name() in ('admin', 'clinician', 'pharmacist'));
drop policy if exists "sl_changes: clinicians read" on public.sl_changes;
create policy "sl_changes: clinicians read" on public.sl_changes for select to authenticated
  using (public.current_role_name() in ('admin', 'clinician', 'pharmacist'));

drop policy if exists "sl_rx: read" on public.sl_rx;
create policy "sl_rx: read" on public.sl_rx for select to authenticated
  using (public.is_app_admin() or (public.current_role_name() = 'clinician' and status = 'validated'));
drop policy if exists "sl_rx: admin write" on public.sl_rx;
create policy "sl_rx: admin write" on public.sl_rx for all to authenticated
  using (public.is_app_admin()) with check (public.is_app_admin());

revoke all on public.sl_products, public.sl_limitations, public.sl_meta, public.sl_changes, public.sl_rx from anon;
revoke insert, update, delete, truncate on public.sl_products, public.sl_limitations, public.sl_meta, public.sl_changes from authenticated;
grant select on public.sl_products, public.sl_limitations, public.sl_meta, public.sl_changes to authenticated;
grant select, insert, update, delete on public.sl_rx to authenticated;

-- 4. Import : remplacement atomique de la LS, avec calcul des changements par rapport à l'import précédent
-- (la version de l'ancien outil renvoyait un entier : on la remplace)
drop function if exists public.sl_replace(jsonb, jsonb, text);
create or replace function public.sl_replace(p_products jsonb, p_limits jsonb, p_source text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare np int; nl int; first_import boolean;
begin
  if not public.is_app_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  first_import := not exists (select 1 from public.sl_limitations);
  create temp table sl_old on commit drop as
    select specialty, substance, lim_code, ind_code, md5(coalesce(ind_code, '') || '|' || coalesce(body, '') || '|' || coalesce(valid_to, '')) h
    from public.sl_limitations;

  delete from public.sl_products where true;
  delete from public.sl_limitations where true;
  insert into public.sl_products (specialty, galenic, substance, atc, limited, peros)
  select r.specialty, r.galenic, r.substance, r.atc, coalesce(r.limited, false), coalesce(r.peros, false)
  from jsonb_to_recordset(p_products) as r(specialty text, galenic text, substance text, atc text, limited boolean, peros boolean);
  get diagnostics np = row_count;
  insert into public.sl_limitations (specialty, substance, atc, galenics, lim_code, ind_code, valid_from, valid_to, body)
  select r.specialty, r.substance, r.atc, r.galenics, r.lim_code, r.ind_code, r.valid_from, r.valid_to, r.body
  from jsonb_to_recordset(p_limits) as r(specialty text, substance text, atc text, galenics text, lim_code text,
       ind_code text, valid_from text, valid_to text, body text);
  get diagnostics nl = row_count;

  if not first_import then
    delete from public.sl_changes where true;
    insert into public.sl_changes (kind, specialty, substance, lim_code, ind_code)
    select 'new', n.specialty, n.substance, n.lim_code, n.ind_code from public.sl_limitations n
    where not exists (select 1 from sl_old o where o.specialty = n.specialty and o.lim_code = n.lim_code)
    union all
    select 'changed', n.specialty, n.substance, n.lim_code, n.ind_code from public.sl_limitations n
    join sl_old o on o.specialty = n.specialty and o.lim_code = n.lim_code
    where o.h <> md5(coalesce(n.ind_code, '') || '|' || coalesce(n.body, '') || '|' || coalesce(n.valid_to, ''))
    union all
    select 'removed', o.specialty, o.substance, o.lim_code, o.ind_code from sl_old o
    where not exists (select 1 from public.sl_limitations n where n.specialty = o.specialty and n.lim_code = o.lim_code);
  end if;

  insert into public.sl_meta (id, source_file, imported_at, product_count, limitation_count)
  values (1, p_source, now(), np, nl)
  on conflict (id) do update set source_file = excluded.source_file, imported_at = excluded.imported_at,
    product_count = excluded.product_count, limitation_count = excluded.limitation_count;
  return jsonb_build_object('products', np, 'limitations', nl,
    'changes', (select count(*) from public.sl_changes), 'first_import', first_import);
end;
$$;
revoke execute on function public.sl_replace(jsonb, jsonb, text) from public, anon;
grant execute on function public.sl_replace(jsonb, jsonb, text) to authenticated;
