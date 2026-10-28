# onconic.ch

Site vitrine bilingue (EN/FR) d'Onconic + espace membres « La Ruche ».

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
fr/  index.html, a-propos.html, ruche.html, contact.html, nouveau-mot-de-passe.html
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

## Modèles d'e-mails (Supabase)

Bilingues FR puis EN, car Supabase n'a qu'un modèle par type. À coller dans *Authentication* > *Emails* > *Templates* :

| Modèle Supabase | Objet | Fichier |
| --- | --- | --- |
| Invite user | `Votre accès à Onconic · Your Onconic access` | `supabase/templates/invite.html` |
| Reset password | `Onconic · Nouveau mot de passe · New password` | `supabase/templates/recovery.html` |

Le logo de l'en-tête est `assets/img/email-header.png` (PNG, car Gmail n'affiche pas les SVG). Le nom du destinataire vient de `full_name`, renseigné lors d'une invitation depuis l'e-mail de demande.

## Charte graphique

Reprise du « Onconic Brand Design » (claude.ai) : navy #001B4D, accent ambre #F0B12B (bouton principal, filets, focus, jamais en grand aplat), Helvetica Neue, angles droits, pas d'ombre. Tous les tokens sont dans le bloc `:root` de `assets/css/onconic.css`.

- Logos : `assets/img/` (`logo-full-*`, `mark-on-*`, `wordmark-on-*`). La marque abeille n'est jamais suivie de ONCONIC tapé au clavier : toujours le fichier wordmark.
- Portrait : `assets/img/portrait.jpg` (900×1200, 3:4).
- Police : les fichiers Helvetica Neue ne sont pas publiés (licence desktop, pas web). Mac/iPhone/iPad l'affichent nativement, Windows/Android retombent sur Helvetica/Arial. Pour un rendu identique partout : licence web (Linotype/Monotype) ou police libre proche.
