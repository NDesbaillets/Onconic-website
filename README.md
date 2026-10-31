# onconic.ch

Site vitrine bilingue (EN/FR) d'Onconic + espace membres « The Hive ».

## Architecture

| Couche | Outil | Où | Coût |
| --- | --- | --- | --- |
| Pages (HTML/CSS) | GitHub Pages | CDN mondial, SSL automatique | gratuit |
| Comptes, base de données, fichiers privés | Supabase | région UE (Zurich si proposée, sinon Frankfurt) | gratuit pour démarrer, 25 $/mois en production |
| Nom de domaine | registrar actuel | | déjà payé |

Règle d'or : **le dépôt GitHub est public**. Rien de confidentiel n'y va (documents internes, PDF de formation, clé `service_role`). Ce qui est privé vit dans Supabase, protégé par les règles de `supabase/schema.sql`.

## Arborescence

```
index.html, about.html, hive.html, contact.html, reset-password.html   pages EN
fr/  index.html, a-propos.html, the-hive.html (ruche.html redirige), contact.html, nouveau-mot-de-passe.html
app/, fr/app/          espace connecté (formation, médecins, assistantes)
assets/css/onconic.css styles + tokens du design system (en tête de fichier)
assets/js/config.js    URL et clé publique Supabase
assets/js/auth.js      connexion, mot de passe oublié, contact, accès par rôle
assets/img/            logo, portrait, motifs (provisoires)
supabase/schema.sql    tables, rôles, règles de sécurité
CNAME                  domaine onconic.ch
```

## Mise en ligne, étape par étape

1. **Supabase** : créer un compte sur supabase.com, *New project*, nom `onconic`, région UE, mot de passe fort (dans un gestionnaire de mots de passe).
2. *SQL Editor* > coller `supabase/schema.sql` > *Run*.
3. *Authentication* > *Sign In / Providers* > Email : désactiver *Allow new users to sign up* (accès sur invitation uniquement).
4. *Authentication* > *URL Configuration* : Site URL `https://onconic.ch`, Redirect URLs `https://onconic.ch/**`.
5. *Project Settings* > *API* : copier `Project URL` et la clé `anon public` dans `assets/js/config.js`.
6. **DNS** chez le registrar de onconic.ch :
   - 4 enregistrements `A` sur `@` : `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - 1 `CNAME` `www` → `ndesbaillets.github.io`
7. **GitHub** : fusionner la branche dans `main`, puis *Settings* > *Pages* : source `main`, domaine `onconic.ch`, cocher *Enforce HTTPS* (certificat émis en quelques minutes à 24 h).

## Première connexion (invitation)

- Le lien d'invitation ouvre `/fr/bienvenue.html` ou `/welcome.html` (redirection automatique dans `site.js`, quelle que soit la page d'arrivée). Le membre y choisit son mot de passe, renseigne nom, prénom et téléphone, et donne ou non ses consentements « The Hive au congrès ».
- Le lien « mot de passe oublié » continue d'ouvrir la page « nouveau mot de passe ».

## Ajouter un membre

1. Le visiteur envoie le formulaire de contact (« Join Onconic »). La fonction `contact-request` enregistre la demande dans `contact_requests` et envoie un e-mail à chaque admin.
2. L'e-mail contient trois liens : **Inviter comme médecin**, **Inviter comme assistante**, **Refuser**. Chaque lien ouvre `/admin/review.html`, qui affiche la demande et attend un clic sur **Confirmer** (les scanners de liens des messageries ne déclenchent donc rien).
3. À la confirmation, la fonction `review-request` envoie l'invitation Supabase, attribue le rôle et marque la demande `invited` ou `declined`. Liens signés, valables 7 jours, utilisables une fois.

Secrets des fonctions (*Edge Functions* > *Secrets*) : `SMTP_PASSWORD` (mot de passe de noreply@onconic.ch) et `REVIEW_SECRET` (chaîne aléatoire d'au moins 40 caractères ; la changer invalide les liens en cours).

Invitation manuelle toujours possible : *Authentication* > *Users* > *Invite user*, puis rôle dans *Table Editor* > `profiles`.

## Outil « Durée de traitement » (assistantes)

Page `/app/duree.html`, réservée aux membres rattachés au CHUV (adresse `@chuv.ch`, ou champ `institution` = `CHUV` dans `profiles`) et aux admins.

- Données : copie fidèle du fichier Excel Ultragenda dans la table `ug_slots` (Supabase, Zurich). **Le fichier n'est jamais commité** (`*.xlsx` est ignoré par Git).
- Installation : exécuter une fois `supabase/ug_durations.sql` dans le SQL Editor.
- Mise à jour : en tant qu'admin, ouvrir `/app/duree.html`, choisir le nouveau fichier Excel, puis « Remplacer les données ». Le fichier est lu dans le navigateur ; toutes les lignes sont remplacées en une seule opération.
- Aucune IA à l'usage : la recherche se fait dans le navigateur.

## Outil « Lettres d'assurance » (médecins)

- Page `/app/lettres.html` (français), réservée aux médecins du CHUV et aux admins.
- Installation : exécuter une fois `supabase/lettres.sql` dans le SQL Editor.
- Ajout courant (admin) : glisser une ou plusieurs lettres Word sur la page. Titre, médicaments, codes LS, voie, diagnostic, drivers, lignes et études sont détectés dans la lettre et proposés dans un formulaire à vérifier avant d'enregistrer. Un fichier de même nom remplace la lettre existante en gardant ses champs. Chaque lettre peut être modifiée ou supprimée depuis sa fiche.
- La base fait office d'index ; « Exporter l'index (.xlsx) » en donne une copie. L'import complet (toutes les lettres, avec ou sans tableur) reste disponible pour une reprise globale.
- Lignes : Néoadjuvant, Adjuvant, 1re ligne, 2e ligne, 3e ligne et plus.
- Ni les lettres ni l'index ne sont versionnés ici.

## Outil « Congrès & formations » (tous les membres)

- Page `/app/congres.html` (français) : liste par mois, calendrier mensuel, recherche, filtre par clinique (« Transversal » = toutes) et par type, « Mes événements », événements passés.
- Installation : exécuter une fois `supabase/congres.sql` dans le SQL Editor. Le script crée les tables, les droits, l'historique et une trentaine d'événements de départ (sources publiques, octobre 2026).
- Tout membre validé crée, modifie ou duplique un événement (nouvelle édition) ; la suppression est réservée au créateur et à l'admin. Chaque version précédente est gardée dans `event_history` (lecture admin).
- Participation : « J'y vais », « Peut-être », « Je présente ». Les noms ne s'affichent qu'avec le consentement « Afficher mon nom » (Mon compte), les coordonnées (e-mail, WhatsApp) qu'avec le consentement « Être contacté » ; la règle est appliquée côté base par `event_attendees()`.
- Export agenda (.ics) par événement.

## Outil « Key trials » (membres validés)

- Page `/app/trials.html` : une fiche par étude clé (design, résultats OS/PFS/DFS/ORR/DoR, tolérance, forces, limites, « practice changing ? », références PubMed/DOI). Recherche par mot-clé, clinique, diagnostic, drivers et ligne ; lien direct `?t=slug`.
- Graphiques générés à partir des chiffres de la fiche (schéma de l'étude, forest plot des HR, médianes, taux) : aucune image d'article n'est reproduite.
- Courbes de survie (champ `km`) : soit digitalisées à partir de la figure publiée la plus récente en libre accès (points tous les 0,5 mois, effectifs à risque, `digitized: true`), soit reconstruites à partir des médianes et taux publiés quand la figure n'est pas accessible. La source est citée sous chaque courbe.
- Installation et mises à jour : exécuter `supabase/trials.sql` (table `key_trials` + 14 fiches thoraciques en brouillon). Le script met à jour une fiche seulement si personne ne l'a modifiée depuis son dernier passage ni marquée comme relue.
- Les membres ne voient que les fiches publiées. L'admin voit les brouillons et peut modifier (JSON), publier, marquer comme relu, dupliquer, supprimer ou créer une fiche.

## Page « Mon compte »

`/fr/app/compte.html` et `/app/account.html` : prénom, nom, pseudo, téléphone, changement d'adresse e-mail (confirmé par lien), changement de mot de passe (mot de passe actuel requis), déconnexion de tous les appareils. Le rôle et l'institution restent en lecture seule.

Installation : exécuter une fois `supabase/user_profile.sql` dans le SQL Editor. Si l'adresse passe de `@chuv.ch` à une autre, l'accès CHUV est retiré automatiquement.

## Modèles d'e-mails (Supabase)

Bilingues FR puis EN, car Supabase n'a qu'un modèle par type. À coller dans *Authentication* > *Emails* > *Templates* :

| Modèle Supabase | Objet | Fichier |
| --- | --- | --- |
| Invite user | `Votre accès à Onconic · Your Onconic access` | `supabase/templates/invite.html` |
| Reset password | `Onconic · Nouveau mot de passe · New password` | `supabase/templates/recovery.html` |

Le logo de l'en-tête est `assets/img/email-header.png` (PNG, car Gmail n'affiche pas les SVG). Le nom du destinataire vient de `full_name`, renseigné lors d'une invitation depuis l'e-mail de demande.

## Cache des navigateurs

Les pages chargent `onconic.css` et les scripts avec un suffixe de version (`?v=20261028`). Après toute modification de ces fichiers, changer ce suffixe dans toutes les pages, sinon des visiteurs peuvent combiner une page récente avec un ancien script gardé en cache.

## Charte graphique

Reprise du « Onconic Brand Design » (claude.ai) : navy #001B4D, accent ambre #F0B12B (bouton principal, filets, focus, jamais en grand aplat), Helvetica Neue, angles droits, pas d'ombre. Tous les tokens sont dans le bloc `:root` de `assets/css/onconic.css`.

- Logos : `assets/img/` (`logo-full-*`, `mark-on-*`, `wordmark-on-*`). La marque abeille n'est jamais suivie de ONCONIC tapé au clavier : toujours le fichier wordmark.
- Portrait : `assets/img/portrait.jpg` (900×1200, 3:4).
- Police : les fichiers Helvetica Neue ne sont pas publiés (licence desktop, pas web). Mac/iPhone/iPad l'affichent nativement, Windows/Android retombent sur Helvetica/Arial. Pour un rendu identique partout : licence web (Linotype/Monotype) ou police libre proche.
