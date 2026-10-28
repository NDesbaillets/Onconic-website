-- Onconic : durées de traitement Ultragenda (outil des assistantes).
-- À exécuter une fois dans Supabase > SQL Editor > Run (peut être relancé sans risque).
-- Les données elles-mêmes ne sont jamais dans ce dépôt : elles s'importent depuis /app/duree.html (admin).

-- Institution des membres : CHUV déduit de l'adresse e-mail vérifiée
alter table public.profiles add column if not exists institution text;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, institution)
  values (new.id, new.raw_user_meta_data ->> 'full_name',
          case when lower(new.email) like '%@chuv.ch' then 'CHUV' end);
  return new;
end;
$$;

update public.profiles p set institution = 'CHUV'
from auth.users u
where u.id = p.id and p.institution is null and lower(u.email) like '%@chuv.ch';

create or replace function public.current_institution()
returns text language sql stable security definer set search_path = public as $$
  select institution from public.profiles where id = auth.uid();
$$;
revoke execute on function public.current_institution() from public, anon;
grant execute on function public.current_institution() to authenticated;

-- Copie fidèle du fichier Excel, lisible uniquement par les membres CHUV (et les admins)
create table if not exists public.ug_slots (
  id bigint generated always as identity primary key,
  position int not null,
  clinic_sheet text not null,
  clinic_letter text,
  clinic_name text,
  name text not null,
  codes text,
  synonyms text,
  note text,
  ug_label text,
  minutes int not null
);
create table if not exists public.ug_meta (
  id int primary key default 1 check (id = 1),
  source_file text,
  imported_at timestamptz,
  row_count int
);

alter table public.ug_slots enable row level security;
alter table public.ug_meta enable row level security;

drop policy if exists "ug_slots: CHUV members read" on public.ug_slots;
create policy "ug_slots: CHUV members read" on public.ug_slots for select to authenticated
  using (public.current_role_name() = 'admin'
     or (public.current_role_name() in ('assistant', 'clinician') and public.current_institution() = 'CHUV'));

drop policy if exists "ug_meta: CHUV members read" on public.ug_meta;
create policy "ug_meta: CHUV members read" on public.ug_meta for select to authenticated
  using (public.current_role_name() = 'admin'
     or (public.current_role_name() in ('assistant', 'clinician') and public.current_institution() = 'CHUV'));

revoke all on public.ug_slots, public.ug_meta from anon;
revoke insert, update, delete, truncate on public.ug_slots, public.ug_meta from authenticated;
grant select on public.ug_slots, public.ug_meta to authenticated;

-- Remplacement atomique de toutes les lignes, réservé aux admins
create or replace function public.ug_replace(p_rows jsonb, p_source text)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  delete from public.ug_slots where true;
  insert into public.ug_slots (position, clinic_sheet, clinic_letter, clinic_name, name, codes, synonyms, note, ug_label, minutes)
  select r.position, r.clinic_sheet, r.clinic_letter, r.clinic_name, r.name, r.codes, r.synonyms, r.note, r.ug_label, r.minutes
  from jsonb_to_recordset(p_rows) as r(position int, clinic_sheet text, clinic_letter text, clinic_name text,
       name text, codes text, synonyms text, note text, ug_label text, minutes int);
  get diagnostics n = row_count;
  insert into public.ug_meta (id, source_file, imported_at, row_count) values (1, p_source, now(), n)
  on conflict (id) do update set source_file = excluded.source_file, imported_at = excluded.imported_at,
    row_count = excluded.row_count;
  return n;
end;
$$;
revoke execute on function public.ug_replace(jsonb, text) from public, anon;
grant execute on function public.ug_replace(jsonb, text) to authenticated;
