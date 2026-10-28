-- Onconic : initiation de traitement (outil des médecins).
-- À exécuter une fois dans Supabase > SQL Editor > Run (peut être relancé sans risque).
-- Les protocoles CHUV ne sont jamais dans ce dépôt : ils s'importent depuis /app/initiation.html (admin).
-- La Liste des spécialités (OFSP) est publique ; elle s'importe au même endroit.

-- Protocoles : transcription fidèle des PDF, lisible uniquement par les médecins du CHUV (et les admins)
create table if not exists public.protocols (
  code text primary key,
  clinic text not null,
  title text not null,
  data jsonb not null,
  imported_at timestamptz not null default now()
);
alter table public.protocols enable row level security;
drop policy if exists "protocols: CHUV clinicians read" on public.protocols;
create policy "protocols: CHUV clinicians read" on public.protocols for select to authenticated
  using (public.current_role_name() = 'admin'
     or (public.current_role_name() = 'clinician' and public.current_institution() = 'CHUV'));

-- Liste des spécialités : produits et limitations (oncologie et G-CSF uniquement)
create table if not exists public.sl_products (
  id bigint generated always as identity primary key,
  specialty text not null,
  galenic text,
  substance text not null,
  atc text,
  limited boolean not null default false
);
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

alter table public.sl_products enable row level security;
alter table public.sl_limitations enable row level security;
alter table public.sl_meta enable row level security;
drop policy if exists "sl_products: clinicians read" on public.sl_products;
create policy "sl_products: clinicians read" on public.sl_products for select to authenticated
  using (public.current_role_name() in ('admin', 'clinician'));
drop policy if exists "sl_limitations: clinicians read" on public.sl_limitations;
create policy "sl_limitations: clinicians read" on public.sl_limitations for select to authenticated
  using (public.current_role_name() in ('admin', 'clinician'));
drop policy if exists "sl_meta: clinicians read" on public.sl_meta;
create policy "sl_meta: clinicians read" on public.sl_meta for select to authenticated
  using (public.current_role_name() in ('admin', 'clinician'));

revoke all on public.protocols, public.sl_products, public.sl_limitations, public.sl_meta from anon;
revoke insert, update, delete, truncate on public.protocols, public.sl_products, public.sl_limitations, public.sl_meta from authenticated;
grant select on public.protocols, public.sl_products, public.sl_limitations, public.sl_meta to authenticated;

-- Import des protocoles (ajout ou remplacement par code), réservé aux admins
create or replace function public.protocols_upsert(p_items jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  insert into public.protocols (code, clinic, title, data, imported_at)
  select x ->> 'code', x ->> 'clinic', x ->> 'title', x, now()
  from jsonb_array_elements(p_items) as x
  on conflict (code) do update set clinic = excluded.clinic, title = excluded.title,
    data = excluded.data, imported_at = excluded.imported_at;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.protocols_upsert(jsonb) from public, anon;
grant execute on function public.protocols_upsert(jsonb) to authenticated;

-- Remplacement atomique de la Liste des spécialités, réservé aux admins
create or replace function public.sl_replace(p_products jsonb, p_limits jsonb, p_source text)
returns int language plpgsql security definer set search_path = public as $$
declare np int; nl int;
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  delete from public.sl_products where true;
  delete from public.sl_limitations where true;
  insert into public.sl_products (specialty, galenic, substance, atc, limited)
  select r.specialty, r.galenic, r.substance, r.atc, coalesce(r.limited, false)
  from jsonb_to_recordset(p_products) as r(specialty text, galenic text, substance text, atc text, limited boolean);
  get diagnostics np = row_count;
  insert into public.sl_limitations (specialty, substance, atc, galenics, lim_code, ind_code, valid_from, valid_to, body)
  select r.specialty, r.substance, r.atc, r.galenics, r.lim_code, r.ind_code, r.valid_from, r.valid_to, r.body
  from jsonb_to_recordset(p_limits) as r(specialty text, substance text, atc text, galenics text, lim_code text,
       ind_code text, valid_from text, valid_to text, body text);
  get diagnostics nl = row_count;
  insert into public.sl_meta (id, source_file, imported_at, product_count, limitation_count)
  values (1, p_source, now(), np, nl)
  on conflict (id) do update set source_file = excluded.source_file, imported_at = excluded.imported_at,
    product_count = excluded.product_count, limitation_count = excluded.limitation_count;
  return np + nl;
end;
$$;
revoke execute on function public.sl_replace(jsonb, jsonb, text) from public, anon;
grant execute on function public.sl_replace(jsonb, jsonb, text) to authenticated;
