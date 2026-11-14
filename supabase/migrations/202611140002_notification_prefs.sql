-- Réglages de notifications par type et par canal (14.11.2026).
-- Chaque membre choisit, dans Mon compte, les notifications qu'il reçoit par e-mail et par notification sur l'appareil.
-- Tout est activé par défaut : sans réglage enregistré, rien ne change. Les types proposés dépendent du rôle et des outils du membre.
--
-- Types : to_validate (nouvelle demande d'absence), to_validate_change (modification ou suppression d'une absence validée),
-- reminder (rappels de demandes en attente), to_direction (visa de la direction), to_opinion (pré-avis de la direction),
-- approved, rejected, change_approved, change_rejected, direction_change (décisions sur ses propres absences),
-- event_join (un autre membre participe au même congrès : notification seulement, pas d'e-mail).
-- Un rappel n'est envoyé que si son type de base et « reminder » sont tous deux activés.
-- Les messages de la direction partent vers la boîte commune : un seul e-mail par message, tant qu'au moins un destinataire le souhaite.
--
-- La colonne n'est pas modifiable directement (aucun grant de colonne) : tout passe par my_set_notification_pref.
-- Les fonctions Edge notify-absence et notify-event-join lisent profiles.notif_prefs avec la clé de service.
-- Transactionnel et réexécutable.
begin;

alter table public.profiles add column if not exists notif_prefs jsonb not null default '{}'::jsonb;

-- Types proposés à un membre selon son rôle et ses outils (aucune écriture)
create or replace function public.notification_kinds_for(p_user uuid) returns text[]
language plpgsql stable security definer set search_path = public as $$
declare r text; v boolean; k text[] := '{}'; validator boolean; direction boolean;
begin
  select role, coalesce(absence_validator, false) into r, v from public.profiles where id = p_user;
  if r is null or r = 'member' then return '{}'; end if;
  validator := r = 'admin' or v;
  direction := r in ('direction', 'admin');
  if validator then k := k || array['to_validate', 'to_validate_change']; end if;
  if direction then k := k || array['to_direction', 'to_opinion']; end if;
  if validator or direction then k := k || array['reminder']; end if;
  if public.tool_allowed(p_user, 'absences') then
    k := k || array['approved', 'rejected', 'change_approved', 'change_rejected', 'direction_change'];
  end if;
  if public.tool_allowed(p_user, 'congres') then k := k || array['event_join']; end if;
  return k;
end;
$$;
revoke execute on function public.notification_kinds_for(uuid) from public, anon, authenticated;

create or replace function public.my_notification_prefs() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare uid uuid := auth.uid(); p jsonb; k text; out jsonb := '[]';
begin
  if uid is null then raise exception 'Connexion requise.' using errcode = '42501'; end if;
  select coalesce(notif_prefs, '{}') into p from public.profiles where id = uid;
  foreach k in array public.notification_kinds_for(uid) loop
    out := out || jsonb_build_array(jsonb_build_object(
      'kind', k,
      'email', case when k = 'event_join' then null else coalesce((p->k->>'email')::boolean, true) end,
      'push', coalesce((p->k->>'push')::boolean, true)));
  end loop;
  return jsonb_build_object('kinds', out);
end;
$$;

create or replace function public.my_set_notification_pref(p_kind text, p_channel text, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); cur jsonb;
begin
  if uid is null then raise exception 'Connexion requise.' using errcode = '42501'; end if;
  if p_channel not in ('email', 'push') then raise exception 'Canal inconnu.'; end if;
  if p_on is null then raise exception 'Valeur manquante.'; end if;
  if not (p_kind = any (public.notification_kinds_for(uid))) then raise exception 'Notification non disponible pour votre profil.'; end if;
  if p_kind = 'event_join' and p_channel = 'email' then raise exception 'Cette notification n''existe pas par e-mail.'; end if;
  select coalesce(notif_prefs, '{}') into cur from public.profiles where id = uid;
  cur := jsonb_set(cur, array[p_kind], coalesce(cur->p_kind, '{}') || jsonb_build_object(p_channel, p_on), true);
  update public.profiles set notif_prefs = cur where id = uid;
  return public.my_notification_prefs();
end;
$$;

-- Tout réactiver (retour au comportement par défaut)
create or replace function public.my_reset_notification_prefs() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Connexion requise.' using errcode = '42501'; end if;
  update public.profiles set notif_prefs = '{}' where id = auth.uid();
  return public.my_notification_prefs();
end;
$$;

revoke execute on function public.my_notification_prefs() from public, anon;
revoke execute on function public.my_set_notification_pref(text, text, boolean) from public, anon;
revoke execute on function public.my_reset_notification_prefs() from public, anon;
grant execute on function public.my_notification_prefs() to authenticated;
grant execute on function public.my_set_notification_pref(text, text, boolean) to authenticated;
grant execute on function public.my_reset_notification_prefs() to authenticated;

insert into public.onconic_migrations (version) values ('202611140002') on conflict do nothing;
commit;
