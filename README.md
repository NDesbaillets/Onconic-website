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

*Authentication* > *Users* > *Invite user*. Puis *Table Editor* > `profiles` : passer `role` de `member` à `clinician`, `assistant` ou `admin`. Ton propre compte doit être `admin`.

## Charte graphique

Reprise du « Onconic Brand Design » (claude.ai) : navy #001B4D, accent ambre #F0B12B (bouton principal, filets, focus, jamais en grand aplat), Helvetica Neue, angles droits, pas d'ombre. Tous les tokens sont dans le bloc `:root` de `assets/css/onconic.css`.

- Logos : `assets/img/` (`logo-full-*`, `mark-on-*`, `wordmark-on-*`). La marque abeille n'est jamais suivie de ONCONIC tapé au clavier : toujours le fichier wordmark.
- Portrait : `assets/img/portrait.jpg` (900×1200, 3:4).
- Police : les fichiers Helvetica Neue ne sont pas publiés (licence desktop, pas web). Mac/iPhone/iPad l'affichent nativement, Windows/Android retombent sur Helvetica/Arial. Pour un rendu identique partout : licence web (Linotype/Monotype) ou police libre proche.
