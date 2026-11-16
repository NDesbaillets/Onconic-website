-- Production uniquement (jamais dans le projet de test) : blocage nocturne des comptes temporaires échus.
-- À exécuter une fois, après la migration 202611160002, sur feu vert. Réexécutable.
select cron.schedule('temp-accounts-expire', '17 1 * * *', $$select public.temp_accounts_expire()$$);
