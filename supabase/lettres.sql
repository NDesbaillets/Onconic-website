-- Onconic : lettres types de demande de garantie de prise en charge (outil des médecins).
-- À exécuter une fois dans Supabase > SQL Editor > Run (peut être relancé sans risque).
-- Les lettres ne sont jamais dans ce dépôt : elles s'importent depuis /app/lettres.html (admin).

create table if not exists public.letters (
  id bigint generated always as identity primary key,
  position int not null,
  file text not null,
  title text not null,
  clinic text,
  diagnosis text,
  markers text,
  lines text[] not null default '{}',
  trial text,
  keywords text,
  note text,
  drugs jsonb not null default '[]',
  html text not null,
  docx text -- fichier Word d'origine (base64), chargé seulement au téléchargement
);
create table if not exists public.letters_meta (
  id int primary key default 1 check (id = 1),
  source_file text,
  imported_at timestamptz,
  row_count int
);

alter table public.letters enable row level security;
alter table public.letters_meta enable row level security;

drop policy if exists "letters: CHUV clinicians read" on public.letters;
create policy "letters: CHUV clinicians read" on public.letters for select to authenticated
  using (public.current_role_name() = 'admin'
     or (public.current_role_name() = 'clinician' and public.current_institution() = 'CHUV'));

drop policy if exists "letters_meta: CHUV clinicians read" on public.letters_meta;
create policy "letters_meta: CHUV clinicians read" on public.letters_meta for select to authenticated
  using (public.current_role_name() = 'admin'
     or (public.current_role_name() = 'clinician' and public.current_institution() = 'CHUV'));

revoke all on public.letters, public.letters_meta from anon;
revoke insert, update, delete, truncate on public.letters, public.letters_meta from authenticated;
grant select on public.letters, public.letters_meta to authenticated;

-- Remplacement atomique de toutes les lettres, réservé aux admins
create or replace function public.letters_replace(p_rows jsonb, p_source text)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  delete from public.letters where true;
  insert into public.letters (position, file, title, clinic, diagnosis, markers, lines, trial, keywords, note, drugs, html, docx)
  select r.position, r.file, r.title, r.clinic, r.diagnosis, r.markers, coalesce(r.lines, '{}'), r.trial, r.keywords,
         r.note, coalesce(r.drugs, '[]'), r.html, r.docx
  from jsonb_to_recordset(p_rows) as r(position int, file text, title text, clinic text, diagnosis text, markers text,
       lines text[], trial text, keywords text, note text, drugs jsonb, html text, docx text);
  get diagnostics n = row_count;
  insert into public.letters_meta (id, source_file, imported_at, row_count) values (1, p_source, now(), n)
  on conflict (id) do update set source_file = excluded.source_file, imported_at = excluded.imported_at,
    row_count = excluded.row_count;
  return n;
end;
$$;
revoke execute on function public.letters_replace(jsonb, text) from public, anon;
grant execute on function public.letters_replace(jsonb, text) to authenticated;
