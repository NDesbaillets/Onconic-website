# Listes de personnes : ordre d'affichage

Règle (27.11.2026) : toute liste de personnes passe par `OnconicSort` (`assets/js/name-sort.js`), nom de famille puis prénom par défaut. Le tri se fait dans le navigateur, après réception des données ; l'ordre renvoyé par le SQL n'est pas modifié (il est souvent par prénom, `lower(member_name)`). Quand `first_name` et `last_name` sont fournis, ils servent au tri ; sinon le nom complet est découpé (dernier mot = nom de famille, particules rattachées).

Garde-fou : `tests/absences/name-lists.test.mjs`. Toute nouvelle liste de personnes s'ajoute à ce tableau, à l'inventaire du test et au tri. Aucune donnée réelle dans ce document.

## Listes triées

| Fichier | Fonction ou liste | Source des données | Ordre avant | Ordre après | Sélecteur |
|---|---|---|---|---|---|
| `absences.js` | Onglet Direction, « Membre » | `absence_manageable_members` | prénom (SQL) | nom de famille | oui, `direction-membres` (nom, prénom, rôle, clinique) |
| `absences.js` | Mes absences, « Résumé de » | `absence_people` et `secretary_of` | nom de famille (clé `absences`), secrétaires ajoutées à la suite | nom de famille, secrétaires fondues dans la liste | oui, `absences-resume` (nom, prénom) |
| `absences.js` | Planning, ordre d'affichage, sélecteur de personnes | `absence_people` | nom de famille | inchangé | oui, `absences` (déjà livré) |
| `absences.js` | Historique, « Personne » | `absence_people`, `secretary_of` | nom de famille (clé `absences`) | inchangé | non (suit la clé `absences`) |
| `absences.js` | Demande pour (secrétaire de médecin cadre) | `absence_agenda_context.secretary_of` | SQL | nom de famille | non |
| `absences.js` | Avancement de la validation, par étape | `absence_approvals_all` | ordre des étapes puis SQL | étapes inchangées, nom de famille dans chaque étape | non |
| `absences.js` | Validateurs prévenus à l'envoi | `absence_my_validators`, `absence_my_validators_for` | SQL | nom de famille | non |
| `absences.js` | Suivi : personnes d'une étape | `absence_track` | SQL | nom de famille | non |
| `absences.js` | Blocage Ultragenda : médecins | `absence_agenda_tasks_list` | SQL | nom de famille | non |
| `absences.js` | Exports (Word, Excel) | `absence_export`, `absence_planning` | déjà triés par `compareNames` | inchangé | clé `absences` |
| `admin-absences.js` | Validateurs par clinique (cadres) | `admin_absence_config` | nom de famille | inchangé | oui, `admin-validateurs` (déjà livré) |
| `admin-circuit.js` | Attributions, membres | `absence_circuit_overview` | nom de famille | inchangé | oui, `circuit-membres` |
| `admin-circuit.js` | Simulateur, « Membre » | `absence_circuit_overview` | SQL | nom de famille | oui, `circuit-simulation` |
| `admin-circuit.js` | Personnes désignées d'une étape | `absence_circuit_overview` | libellé complet (prénom d'abord) | nom de famille | oui, `circuit-personnes` |
| `admin-circuit.js` | Qui suit quel circuit | `absence_circuit_who` | prénom (SQL) | nom de famille | oui, `circuit-qui` |
| `admin-circuit.js` | Validateurs par clinique (tableau) | `absence_circuit_overview` | SQL | nom de famille | non |
| `circuit-view.js` | Personnes d'une étape (Mon circuit, simulation) | `absence_circuit_mine`, `absence_circuit_simulate` | SQL | nom de famille | non |
| `admin-diffusion.js` | Responsables de bloc (cadres administratifs) | `admin_blocs_list` | prénom (SQL) | nom de famille | non |
| `admin-diffusion.js` | Médecins | `admin_form_routing_overview` | prénom (SQL) | nom de famille | oui, `diffusion-medecins` (nom, prénom, clinique) |
| `admin-diffusion.js` | Choix de membres (adresse personnelle) | `admin_members` | SQL | nom de famille (prénom et nom séparés) | oui, `diffusion-membres` |
| `admin-diffusion.js` | Destinataires par défaut et effectifs (texte) | `admin_form_routing_get` | SQL | nom de famille | non |
| `admin-members.js` | Liste principale (en attente en tête) | `admin_members` | nom de famille | inchangé | oui, `membres` (déjà livré) |
| `admin-members.js` | Demandes de changement de cliniques | `admin_clinic_requests` | date | nom de famille | non |
| `admin-members.js` | Médecins cadres d'une secrétaire | `admin_members` | SQL | nom de famille | non |
| `oncoodle.js` | Réponses, commentaires | `oncoodle_get` | nom de famille | inchangé (commentaires désormais dans le même ordre) | oui, `oncoodle-invites` (déjà livré) |
| `oncoodle.js` | Destinataires : suggestions, actuels, calculés | `oncoodle_people`, `oncoodle_get`, `oncoodle_audience_preview` | nom de famille | inchangé | oui, `oncoodle-destinataires` (déjà livré) |
| `planning.js` | Personnel du planning administratif, dans chaque équipe | `plan_grid` | `position` puis nom (SQL) | nom de famille (le champ `position`, libellé « Ordre dans l'export Excel », n'agit plus que sur l'export) | oui, `planning-personnel` (nom, prénom) |
| `planning.js` | Compte Onconic d'une ligne | `plan_accounts` | prénom (SQL) | nom de famille | non |
| `temporaires.js` | Comptes temporaires, actifs puis terminés | `temp_accounts` | actifs, fin d'accès décroissante | actifs puis terminés, nom de famille dans chaque groupe | non |
| `medletters.js` | Accès « médecin plus » | `medletters_members` | prénom (SQL) | nom de famille | non |
| `congres.js` | Participants d'un congrès, intervenants en tête | `event_attendees` | intervenants, puis nom de famille (SQL) | intervenants, puis nom de famille (navigateur) | oui, `congres-participants` |
| `congres.js` | Validateurs de la demande d'absence (texte) | `absence_my_validators` | SQL | nom de famille | non |
| `contacts.js` | Annuaire pour médecins : fiches de personnes mêlées aux services | table `contacts` | titre de la fiche (prénom d'abord) | personnes par nom de famille, services par titre (comparaison sur une clé de chaîne, égalités départagées par identifiant) | oui, `annuaire-contacts` |

## Listes laissées telles quelles

| Fichier | Liste | Raison |
|---|---|---|
| `absences.js` | À valider, pré-avis, demandes refusées, historique, recherche, suivi (lignes) | une ligne par demande, classées par date, pas des listes de personnes |
| `absences.js` | Pré-avis de la direction dans le suivi | ordre chronologique des avis |
| `absences.js` | Étapes du parcours d'une demande, validateurs d'un circuit | ordre des étapes du circuit |
| `admin-calendrier.js` | Auteurs des entrées du calendrier commun | un nom par ligne de journal, ordre chronologique |
| `admin-members.js` | Raccourcis par bloc | blocs, pas des personnes |
| `planning.js` | Export Excel du planning | ordre du tableur d'origine (`position`, champ « Ordre dans l'export Excel ») conservé |
| `congres.js` | Présentations, retours de congrès | classés par date |
| `oncoodle.js` | Liste des sondages, puces des destinataires choisis | sondages ; puces dans l'ordre de saisie |
| `annuaire.js` | Annuaire de prestataires | organisations, pas des personnes |
| `trials.js`, `formation.js`, `lettres.js`, `duree.js`, `limitations.js` | études, formations, lettres, durées, spécialités | pas de liste de personnes |
| `account.js`, `review.js`, `welcome.js` | profil de la personne connectée, demande d'accès unique | une seule personne |
