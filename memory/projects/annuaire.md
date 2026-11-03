# Annuaire des prestataires

**Page :** `/app/annuaire.html` · **JS :** `assets/js/annuaire.js` · **SQL :** `supabase/annuaire.sql`

Outil « annuaire » (`has_tool('annuaire')`) : médecins, assistantes et pharmaciens **à adresse CHUV** (`profiles.institution = 'CHUV'`), et admins (toujours). Pas d'exception par membre pour l'instant (la contrainte `tool_access.tool` ne contient pas « annuaire »).

## Contenu d'une fiche (table `providers`)
Nom, origine (interne CHUV ou externe), catégorie (centre d'imagerie, laboratoire, cabinet médical, autres), précision libre (CMS, soins à domicile, IRM, médecin généraliste…), adresse, téléphone rapide, autre numéro (urgences, après-heures, fax), e-mail, site web, personne ou service de contact, remarques (jamais de données de patient). Date de dernière modification en pied de fiche ; badge « À vérifier » au-delà d'un an sans modification.

## Fonctions
- Recherche texte libre (nom, ville, spécialité, e-mail, remarques, et numéros de téléphone par chiffres), filtres Origine et Catégorie (bouton « Filtres »), bouton « Favoris » qui affiche « Mes favoris » en haut de page (étoile sur chaque fiche, favoris propres à chaque utilisateur, table `provider_favorites`).
- Tout utilisateur de l'outil crée et modifie des fiches ; avertissement si un nom proche existe ; unicité sur (nom, adresse). Suppression : auteur de la fiche ou admin.
- Téléphone et e-mail cliquables (appel, message), lien « Plan » sur l'adresse.
- Admin (admin ou pharmacien) : import Excel (ajoute les nouvelles fiches, met à jour celles de même nom et même adresse, ne supprime rien, cellules vides ignorées), export Excel (avec la date de dernière modification), modèle Excel à télécharger. Fonction `providers_import()`.
- Tuile « Annuaire des prestataires » dans l'Espace admin de The Hive uniquement (plus dans l'espace collaboratif).

## Idées non faites
Plusieurs contacts par prestataire, horaires structurés, historique des modifications, signalement d'une donnée périmée, archivage au lieu de suppression, accès par membre (nécessite d'ajouter « annuaire » à la contrainte de `tool_access`).
