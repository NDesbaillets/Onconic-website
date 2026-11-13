# Environnement de test

| | Production | Test |
|---|---|---|
| Site | https://onconic.ch (GitHub Pages) | https://onconic.pages.dev et `*.onconic.pages.dev` (Cloudflare Pages, un aperçu par branche) |
| Supabase | `icqrobnqvidusajburcu` | `uubowlcyekbgmizrlyxb` (même organisation, Zurich) |
| Données | réelles | fictives uniquement |
| Envois d'e-mails | oui | non : tâches cron désactivées, Edge Functions d'envoi non déployées |

`assets/js/config.js` choisit le projet selon l'adresse : seules `onconic.ch` et `www.onconic.ch` utilisent la production. Toute autre adresse utilise le test et affiche un bandeau orange.

L'accès aux aperçus Cloudflare doit être restreint par Cloudflare Access (code à usage unique envoyé par e-mail), sur `onconic.pages.dev` et `*.onconic.pages.dev`. Au 13.11.2026 : pas encore en place.

## Données du projet de test (13.11.2026)

Le 13.11.2026, la base a servi au test de restauration de la sauvegarde, puis toutes les données personnelles ont été effacées : comptes, profils, absences et leur historique, annuaire, favoris, demandes d'accès, participations aux congrès, abonnements push, clé VAPID, références Storage.

Conservé (contenu de référence, non personnel) : fiches Key trials, lettres d'assurance, limitations LS, durées Ultragenda, congrès (auteur effacé), prestataires (personne de contact effacée), calendrier commun, réglages des cliniques, présentations Formation (auteur générique).

Ajouté : 16 comptes fictifs, 9 demandes d'absence dans tous les états, 18 contacts fictifs. Adresses en `@example.com` (domaine réservé, aucun e-mail ne peut y arriver), téléphones en `021 555 …`. Le mot de passe commun est dans le gestionnaire de mots de passe de Nicolas, jamais dans le dépôt.

| Compte | Rôle | Clinique |
|---|---|---|
| `admin.test@example.com` (Alix Admin) | admin | |
| `direction.test@example.com` (Dora Direction) | direction | |
| `claire.cadre@example.com` | cadre, validatrice | Thoracique ; valide aussi Mélanome |
| `marc.morel@example.com` | cadre, validateur | Neuro-oncologie |
| `sophie.rochat@example.com` | cadre, validatrice | Sénologie |
| `julien.favre@example.com` | CDC | Thoracique |
| `lea.monnier@example.com` | CDC | Neuro-oncologie |
| `thomas.berset@example.com` | médecin assistant | Thoracique |
| `emma.girard@example.com` | médecin assistant | Neuro-oncologie |
| `lucas.dupuis@example.com` | médecin assistant | Sénologie |
| `chloe.perret@example.com` | médecin assistant | Mélanome |
| `nadia.blanc@example.com`, `sarah.jaquet@example.com` | assistante médicale | |
| `ines.rossier@example.com` | infirmière | |
| `paul.vuilleumier@example.com` | pharmacien | |
| `hugo.martin@example.com` | en attente de validation | |

Absences : demandes en attente du cadre (1re ligne) et de la direction (2e ligne), deux acceptées, une refusée avec commentaire, un chevauchement en Thoracique (21-24.12.2026).

## Règles

- Jamais de données réelles dans le projet de test. Pour un nouveau test de restauration, effacer les données personnelles juste après la vérification.
- Ne jamais recréer les tâches cron ni déposer de secrets d'envoi (SMTP, `ABSENCE_FORMS_TO`) dans le projet de test.
- Vider ou recharger le projet de test seulement avec l'accord de Nicolas.
