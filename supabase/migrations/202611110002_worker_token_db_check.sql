-- Vérification du jeton du traitement autonome par la base (Vault), sans copie du secret dans les secrets Edge :
-- le secret est généré et stocké dans Vault (absence_worker_token) et n'est jamais affiché ni transmis hors de la base.
-- La fonction notify-absence interroge cette fonction (service_role) avec l'en-tête x-absence-worker reçu.
-- Le contrôle par ABSENCE_WORKER_TOKEN (secret Edge) reste accepté s'il est défini. Réexécutable.
begin;
create or replace function public.absence_worker_verify(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_token is not null and length(p_token) >= 32
    and exists (select 1 from vault.decrypted_secrets where name = 'absence_worker_token' and length(decrypted_secret) >= 32 and decrypted_secret = p_token);
$$;
revoke execute on function public.absence_worker_verify(text) from public, anon, authenticated;
grant execute on function public.absence_worker_verify(text) to service_role;
insert into public.onconic_migrations(version) values ('202611110002') on conflict do nothing;
commit;
