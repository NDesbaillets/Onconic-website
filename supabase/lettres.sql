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
  using (public.is_app_admin()
     or (public.current_role_name() = 'clinician' and public.current_institution() = 'CHUV'));

drop policy if exists "letters_meta: CHUV clinicians read" on public.letters_meta;
create policy "letters_meta: CHUV clinicians read" on public.letters_meta for select to authenticated
  using (public.is_app_admin()
     or (public.current_role_name() = 'clinician' and public.current_institution() = 'CHUV'));

revoke all on public.letters, public.letters_meta from anon;
revoke insert, update, delete, truncate on public.letters, public.letters_meta from authenticated;
grant select on public.letters, public.letters_meta to authenticated;

-- Remplacement atomique de toutes les lettres, réservé aux admins et aux pharmaciens
create or replace function public.letters_replace(p_rows jsonb, p_source text)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_app_admin() then
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

-- Ajout ou mise à jour d'une seule lettre (glisser-déposer), réservé aux admins.
-- p_row.id présent : mise à jour de cette lettre ; sinon, la lettre de même nom de fichier est remplacée, ou ajoutée en fin de liste.
-- docx absent : le fichier Word existant est conservé (modification des seules métadonnées).
create or replace function public.letters_upsert(p_row jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not public.is_app_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  v_id := coalesce((p_row ->> 'id')::bigint, (select id from public.letters where file = p_row ->> 'file' limit 1));
  if v_id is null then
    insert into public.letters (position, file, title, clinic, diagnosis, markers, lines, trial, keywords, note, drugs, html, docx)
    values ((select coalesce(max(position), 0) + 1 from public.letters),
      p_row ->> 'file', p_row ->> 'title', p_row ->> 'clinic', p_row ->> 'diagnosis', p_row ->> 'markers',
      coalesce(array(select jsonb_array_elements_text(p_row -> 'lines')), '{}'), p_row ->> 'trial', p_row ->> 'keywords',
      p_row ->> 'note', coalesce(p_row -> 'drugs', '[]'), p_row ->> 'html', p_row ->> 'docx')
    returning id into v_id;
  else
    update public.letters set
      file = coalesce(p_row ->> 'file', file), title = p_row ->> 'title', clinic = p_row ->> 'clinic',
      diagnosis = p_row ->> 'diagnosis', markers = p_row ->> 'markers',
      lines = coalesce(array(select jsonb_array_elements_text(p_row -> 'lines')), '{}'),
      trial = p_row ->> 'trial', keywords = p_row ->> 'keywords', note = p_row ->> 'note',
      drugs = coalesce(p_row -> 'drugs', drugs), html = coalesce(p_row ->> 'html', html), docx = coalesce(p_row ->> 'docx', docx)
    where id = v_id;
    if not found then raise exception 'lettre introuvable'; end if;
  end if;
  update public.letters_meta set imported_at = now(), row_count = (select count(*) from public.letters) where id = 1;
  if not found then
    insert into public.letters_meta (id, source_file, imported_at, row_count)
    values (1, 'ajouts manuels', now(), (select count(*) from public.letters));
  end if;
  return v_id;
end;
$$;
revoke execute on function public.letters_upsert(jsonb) from public, anon;
grant execute on function public.letters_upsert(jsonb) to authenticated;

create or replace function public.letters_delete(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  delete from public.letters where id = p_id;
  update public.letters_meta set imported_at = now(), row_count = (select count(*) from public.letters) where id = 1;
end;
$$;
revoke execute on function public.letters_delete(bigint) from public, anon;
grant execute on function public.letters_delete(bigint) to authenticated;
