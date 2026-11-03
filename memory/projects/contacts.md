# Annuaire des médecins

**Page :** `/app/contacts.html` · **JS :** `assets/js/contacts.js` · **SQL :** `supabase/contacts.sql`

Outil « contacts » (`has_tool('contacts')`) : médecins, assistantes et pharmaciens **à adresse CHUV** (`profiles.institution = 'CHUV'`), et admins (toujours, même sans adresse CHUV). Tuile dans l'espace médecins de The Hive. Pas d'exception par membre (la contrainte `tool_access.tool` ne contient pas « contacts »).

## Fiche (table `contacts`)
Prénom, nom (facultatifs : une ligne de service n'a pas de personne), service, fonction ou précision (garde nuit/WE, cadre, plage horaire), origine (interne CHUV ou externe), téléphone complet, e-mail, remarques (jamais de données de patient). Un numéro par fiche ; un service avec plusieurs numéros a plusieurs lignes.

## Numéros
Stockage en entier : raccourci CHUV à 5 chiffres commençant par 4 → `+412131` + 5 chiffres ; commençant par 6 → `+417955` + 5 chiffres. Le site affiche le raccourci (ex. « 62 234 ») et le numéro complet ; l'appel utilise le numéro complet. À la saisie, 5 chiffres, 0xx xxx xx xx ou +41… sont acceptés et normalisés.

## Fonctions
- Recherche texte libre : nom, prénom, service, précision, e-mail, remarques, numéro (raccourci ou complet). Filtre Origine.
- Import Excel (admin et pharmacien, fonction `contacts_import()`), export Excel (avec raccourci CHUV et date de modification) et modèle à télécharger. Colonnes : Prénom, Nom, Service, Précision, Origine, Téléphone, E-mail, Remarques ; un numéro à 5 chiffres est converti. Clé : nom, prénom, service, précision, numéro.
- Tout utilisateur de l'outil crée et modifie ; suppression par l'auteur ou un admin ; avertissement si le même nom existe.

## Données
Les ~99 lignes initiales (tableaux de contacts internes CHUV) ont été insérées par SQL le 03.11.2026 et ne sont **pas** dans le dépôt (public).

## Idées non faites
Plusieurs numéros par fiche, favoris, liens vers l'annuaire des prestataires.
