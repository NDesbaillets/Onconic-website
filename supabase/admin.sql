-- Onconic : page d'administration des membres (/admin/membres.html), réservée aux admins.
-- À exécuter après schema.sql (fonctions tool_allowed, tool_access). Peut être relancé sans risque.

-- Liste des membres avec e-mail, rôle et accès effectifs par outil
create or replace function public.admin_members()
returns table (id uuid, email text, first_name text, last_name text, full_name text, role text, institution text,
               created_at timestamptz, last_sign_in_at timestamptz, tools jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
    select p.id, u.email::text, p.first_name, p.last_name, p.full_name, p.role, p.institution, u.created_at, u.last_sign_in_at,
      (select jsonb_object_agg(t, jsonb_build_object(
          'allowed', public.tool_allowed(p.id, t),
          'custom', exists (select 1 from public.tool_access a where a.user_id = p.id and a.tool = t)))
       from unnest(array['congres', 'trials', 'lettres', 'limitations', 'duree', 'medletters']) t)
    from public.profiles p join auth.users u on u.id = p.id
    order by (p.role = 'member') desc, lower(coalesce(p.last_name, p.full_name, u.email));
end;
$$;
revoke execute on function public.admin_members() from public, anon;
grant execute on function public.admin_members() to authenticated;

-- Changement de rôle (jamais le sien, pour ne pas perdre l'accès admin) ; les exceptions d'accès repartent à zéro
create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    raise exception 'Vous ne pouvez pas modifier votre propre rôle.';
  end if;
  if p_role not in ('member', 'clinician', 'assistant', 'pharmacist', 'admin') then
    raise exception 'Rôle inconnu : %', p_role;
  end if;
  update public.profiles set role = p_role where id = p_user;
  if not found then raise exception 'Membre introuvable.'; end if;
  delete from public.tool_access where user_id = p_user;
end;
$$;
revoke execute on function public.admin_set_role(uuid, text) from public, anon;
grant execute on function public.admin_set_role(uuid, text) to authenticated;

-- Accès à un outil : une exception n'est gardée que si elle diffère du droit par défaut du rôle.
-- Lettres médicales : passe par le drapeau med_plus (accès « médecin plus »).
create or replace function public.admin_set_tool(p_user uuid, p_tool text, p_allowed boolean)
returns boolean language plpgsql security definer set search_path = public as $$
declare r text;
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  select role into r from public.profiles where id = p_user;
  if r is null then raise exception 'Membre introuvable.'; end if;
  if r in ('admin', 'member') then raise exception 'Accès fixé par le rôle (%)', r; end if;
  if p_tool = 'medletters' then
    if p_allowed and r not in ('clinician', 'pharmacist') then
      raise exception 'Lettres médicales : réservé aux médecins et pharmaciens.';
    end if;
    update public.profiles set med_plus = p_allowed where id = p_user;
  elsif p_tool in ('congres', 'trials', 'lettres', 'limitations', 'duree') then
    delete from public.tool_access where user_id = p_user and tool = p_tool;
    if public.tool_allowed(p_user, p_tool) is distinct from p_allowed then
      insert into public.tool_access (user_id, tool, allowed) values (p_user, p_tool, p_allowed);
    end if;
  else
    raise exception 'Outil inconnu : %', p_tool;
  end if;
  return public.tool_allowed(p_user, p_tool);
end;
$$;
revoke execute on function public.admin_set_tool(uuid, text, boolean) from public, anon;
grant execute on function public.admin_set_tool(uuid, text, boolean) to authenticated;

-- Retour aux accès par défaut du rôle
create or replace function public.admin_reset_tools(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() is distinct from 'admin' then
    raise exception 'admin only' using errcode = '42501';
  end if;
  delete from public.tool_access where user_id = p_user;
end;
$$;
revoke execute on function public.admin_reset_tools(uuid) from public, anon;
grant execute on function public.admin_reset_tools(uuid) to authenticated;
