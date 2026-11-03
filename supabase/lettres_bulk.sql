-- Lettres d'assurance : changement en bloc du nom commercial ou de la firme d'une substance (outil admin de /app/lettres.html).
-- À exécuter après lettres.sql. Sans danger si relancé.

-- Mise à jour du texte, des médicaments et (si fourni) du fichier Word d'une seule lettre ; les autres champs ne sont pas touchés
create or replace function public.letters_patch(p_id bigint, p_html text, p_drugs jsonb, p_docx text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_admin('lettres') then
    raise exception 'admin only' using errcode = '42501';
  end if;
  update public.letters set html = p_html, drugs = coalesce(p_drugs, drugs), docx = coalesce(p_docx, docx) where id = p_id;
  if not found then raise exception 'lettre introuvable'; end if;
  update public.letters_meta set imported_at = now() where id = 1;
end;
$$;
revoke execute on function public.letters_patch(bigint, text, jsonb, text) from public, anon;
grant execute on function public.letters_patch(bigint, text, jsonb, text) to authenticated;

-- Journal des changements en bloc (qui, quand, quoi), lisible par les admins
create table if not exists public.letters_changes (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),
  changed_by uuid default auth.uid() references auth.users (id) on delete set null,
  substance text not null,
  old_brand text, new_brand text, old_company text, new_company text,
  in_body boolean not null default false,
  letters int not null default 0,
  occurrences int not null default 0
);
alter table public.letters_changes enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'letters_changes' and policyname = 'letters_changes: admin read') then
    create policy "letters_changes: admin read" on public.letters_changes for select to authenticated
      using ((select public.is_app_admin('lettres')));
  end if;
end $$;
revoke all on public.letters_changes from anon, authenticated;
grant select on public.letters_changes to authenticated;

create or replace function public.letters_log_change(p_substance text, p_old_brand text, p_new_brand text, p_old_company text,
  p_new_company text, p_in_body boolean, p_letters int, p_occurrences int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_app_admin('lettres') then
    raise exception 'admin only' using errcode = '42501';
  end if;
  insert into public.letters_changes (substance, old_brand, new_brand, old_company, new_company, in_body, letters, occurrences)
  values (left(p_substance, 100), left(p_old_brand, 200), left(p_new_brand, 200), left(p_old_company, 200), left(p_new_company, 200),
    coalesce(p_in_body, false), coalesce(p_letters, 0), coalesce(p_occurrences, 0));
end;
$$;
revoke execute on function public.letters_log_change(text, text, text, text, text, boolean, int, int) from public, anon;
grant execute on function public.letters_log_change(text, text, text, text, text, boolean, int, int) to authenticated;
