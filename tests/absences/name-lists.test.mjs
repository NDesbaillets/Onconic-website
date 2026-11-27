// Garde-fou statique : toute liste de personnes affichée passe par OnconicSort (nom de famille par défaut).
// Sans base de données ni navigateur : lit assets/js/*.js et les pages app/ et admin/.
// Inventaire détaillé : docs/listes-de-personnes.md.
//
// POUR AJOUTER UNE LISTE DE PERSONNES : l'ajouter à INVENTAIRE ci-dessous (fichier, source des données, appel de tri attendu),
// la faire passer par OnconicSort (sortPeople ou compareNames) après réception des données, puis la décrire dans docs/listes-de-personnes.md.
// Une liste volontairement non triée (demandes chronologiques, étapes d'un circuit, organisations) va dans EXCLUS avec sa raison.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

const CONSIGNE = 'Toute liste de personnes doit passer par OnconicSort (assets/js/name-sort.js) : ajoutez la nouvelle liste à l\'inventaire de tests/absences/name-lists.test.mjs et à docs/listes-de-personnes.md, et triez-la par nom de famille après réception des données.';

// { fichier, liste, source : motif de la source de données, tri : motif de l'appel de tri attendu }
const INVENTAIRE = [
  // Absences
  { fichier: 'absences.js', liste: 'Direction : membre au nom duquel saisir une absence', source: /rpc\("absence_manageable_members"\)/, tri: /sortedPeople\(members, "direction-membres", DIR_MODES\)/ },
  { fichier: 'absences.js', liste: 'Mes absences : Résumé de', source: /rpc\("absence_people"\)/, tri: /sortedPeople\(cand, "absences-resume", WHO_MODES\)/ },
  { fichier: 'absences.js', liste: 'Planning, ordre d\'affichage, sélecteur de personnes', source: /rpc\("absence_people"\)/, tri: /\(b\.is_me - a\.is_me\) \|\| compareNames\(a, b, sortMode\(\)\)/ },
  { fichier: 'absences.js', liste: 'Planning : fenêtre « Choisir les personnes »', source: /rpc\("absence_people"\)/, tri: /state\.people\.slice\(\)\.sort\(\(x, y\) => compareNames\(x, y, sortMode\(\)\)\)/ },
  { fichier: 'absences.js', liste: 'Demande pour (secrétaire de médecin cadre)', source: /secretary_of/, tri: /byFamily\(\(state\.agendaCtx/ },
  { fichier: 'absences.js', liste: 'Avancement de la validation (par étape)', source: /rpc\("absence_approvals_all"/, tri: /byFamily\(items, \(r\) =>/ },
  { fichier: 'absences.js', liste: 'Validateurs prévenus à l\'envoi', source: /rpc\("absence_my_validators/, tri: /byFamily\(list\)\.map\(\(v\) => v\.name\)/ },
  { fichier: 'absences.js', liste: 'Suivi : personnes d\'une étape', source: /rpc\("absence_track"/, tri: /byFamily\(s\.people\)/ },
  { fichier: 'absences.js', liste: 'Blocage Ultragenda : médecins', source: /rpc\("absence_agenda_tasks_list"/, tri: /byFamily\(\[\.\.\.groups\.values\(\)\]/ },
  { fichier: 'admin-absences.js', liste: 'Validateurs par clinique (cadres)', source: /rpc\("admin_absence_config"\)/, tri: /sortPeople\(state\.cadres/ },
  { fichier: 'admin-circuit.js', liste: 'Circuits : attributions (membres)', source: /rpc\("absence_circuit_overview"\)/, tri: /sortedMembers\(o\.members \|\| \[\], "circuit-membres"\)/ },
  { fichier: 'admin-circuit.js', liste: 'Circuits : simulateur', source: /rpc\("absence_circuit_overview"\)/, tri: /sortedMembers\(o\.members \|\| \[\], "circuit-simulation"\)/ },
  { fichier: 'admin-circuit.js', liste: 'Circuits : personnes désignées d\'une étape', source: /rpc\("absence_circuit_overview"\)/, tri: /sortedMembers\(\[\.\.\.known\.values\(\)\], "circuit-personnes"\)/ },
  { fichier: 'admin-circuit.js', liste: 'Circuits : qui suit quel circuit', source: /rpc\("absence_circuit_who"\)/, tri: /sortedMembers\(state\.who\.filter\(/ },
  { fichier: 'admin-circuit.js', liste: 'Circuits : validateurs par clinique', source: /rpc\("absence_circuit_overview"\)/, tri: /byFamily\(c\.validators \|\| \[\]\)/ },
  { fichier: 'circuit-view.js', liste: 'Mon circuit : personnes d\'une étape', source: /s\.people/, tri: /sortPeople\(s\.people \|\| \[\], \{ mode: "family" \}\)/ },
  // Diffusion des absences
  { fichier: 'admin-diffusion.js', liste: 'Diffusion : cadres administratifs responsables de bloc', source: /rpc\("admin_blocs_list"\)/, tri: /sorted\(state\.leads\)/ },
  { fichier: 'admin-diffusion.js', liste: 'Diffusion : choix de membres (adresse personnelle)', source: /rpc\("admin_members"\)/, tri: /sorted\(state\.members\.filter\([^\n]*"diffusion-membres"/ },
  { fichier: 'admin-diffusion.js', liste: 'Diffusion : médecins', source: /rpc\("admin_form_routing_overview"\)/, tri: /sorted\(state\.docs\.filter\(/ },
  { fichier: 'admin-diffusion.js', liste: 'Diffusion : destinataires par défaut et effectifs', source: /rpc\("admin_form_routing_get"/, tri: /sorted\(data\.default\.members\)/ },
  // Membres et accès, demandes d'accès
  { fichier: 'admin-members.js', liste: 'Membres et accès : liste principale', source: /rpc\("admin_members"\)/, tri: /compareNames\(personOf\(a\), personOf\(b\)/ },
  { fichier: 'admin-members.js', liste: 'Membres et accès : demandes de changement de cliniques', source: /rpc\("admin_clinic_requests"\)/, tri: /sortPeople\(list, \{ mode: "family" \}\)/ },
  { fichier: 'admin-members.js', liste: 'Membres et accès : médecins cadres d\'une secrétaire', source: /rpc\("admin_members"\)/, tri: /sortPeople\(cadres, \{ get: personOf/ },
  // Autres outils
  { fichier: 'oncoodle.js', liste: 'Oncoodle : réponses des invités', source: /"oncoodle_get"/, tri: /sortPeople\(d\.invitees, "oncoodle-invites"/ },
  { fichier: 'oncoodle.js', liste: 'Oncoodle : suggestions de destinataires', source: /"oncoodle_people"/, tri: /sortPeople\(hits, "oncoodle-destinataires"/ },
  { fichier: 'oncoodle.js', liste: 'Oncoodle : destinataires calculés', source: /"oncoodle_audience_preview"/, tri: /sortPeople\(f\.members, "oncoodle-destinataires"/ },
  { fichier: 'oncoodle.js', liste: 'Oncoodle : destinataires actuels', source: /"oncoodle_get"/, tri: /sortPeople\(f\.current, "oncoodle-destinataires"/ },
  { fichier: 'planning.js', liste: 'Planning administratif : personnel', source: /rpc\("plan_grid"/, tri: /sortStaff\(st\.staff, mode \|\| sortMode\(\)\)/ },
  { fichier: 'planning.js', liste: 'Planning administratif : compte Onconic d\'une ligne', source: /rpc\("plan_accounts"\)/, tri: /sortPeople\(await accounts\(\), \{ mode: "family" \}\)/ },
  { fichier: 'temporaires.js', liste: 'Comptes temporaires', source: /rpc\("temp_accounts"\)/, tri: /sortPeople\(list, \{ mode: "family" \}\)/ },
  { fichier: 'medletters.js', liste: 'Lettres médicales : accès « médecin plus »', source: /rpc\("medletters_members"\)/, tri: /sortPeople\(data \|\| \[\], \{ mode: "family" \}\)/ },
  { fichier: 'congres.js', liste: 'Congrès : participants', source: /rpc\("event_attendees"/, tri: /sortPeople\(named\.filter\(/ },
  { fichier: 'congres.js', liste: 'Congrès : validateurs de la demande d\'absence', source: /rpc\("absence_my_validators"\)/, tri: /sortByFamily\(validators\.validators/ },
  { fichier: 'contacts.js', liste: 'Annuaire pour médecins : fiches de personnes', source: /from\("contacts"\)/, tri: /S\.splitName\(e\.person\)/ },
];

// Fonctions SQL qui renvoient des personnes : tout appel doit correspondre à une entrée de l'inventaire, ou figurer dans EXCLUS
const RPC_PERSONNES = [
  'absence_manageable_members', 'absence_people', 'admin_members', 'medletters_members', 'plan_grid', 'plan_accounts', 'temp_accounts',
  'event_attendees', 'oncoodle_people', 'absence_circuit_overview', 'absence_circuit_who', 'admin_blocs_list', 'admin_form_routing_overview',
  'admin_form_routing_get', 'admin_clinic_requests', 'absence_agenda_tasks_list', 'absence_my_validators', 'absence_my_validators_for',
  'absence_approvals_all', 'absence_track', 'admin_absence_config',
  // listes de demandes (une ligne par demande, avec le nom du demandeur)
  'absence_to_validate', 'absence_opinion_todo', 'absence_rejected_to_manage', 'absence_requests_history', 'absence_find', 'absence_list',
  'absence_decisions', 'absence_export', 'absence_planning', 'event_talks', 'event_takeaways_list', 'oncoodle_list', 'absence_circuit_mine',
  'admin_calendar_list', 'admin_calendar_log_list',
];
// { fichier, rpc, raison } : listes laissées dans l'ordre reçu, volontairement
const EXCLUS = [
  { fichier: 'absences.js', rpc: 'absence_to_validate', raison: 'demandes classées par date, une carte par demande' },
  { fichier: 'absences.js', rpc: 'absence_opinion_todo', raison: 'demandes classées par date' },
  { fichier: 'absences.js', rpc: 'absence_rejected_to_manage', raison: 'demandes classées par date de refus' },
  { fichier: 'absences.js', rpc: 'absence_requests_history', raison: 'historique des demandes, par date' },
  { fichier: 'absences.js', rpc: 'absence_find', raison: 'recherche de demandes, par date' },
  { fichier: 'absences.js', rpc: 'absence_list', raison: 'absences d\'une personne, par date' },
  { fichier: 'congres.js', rpc: 'absence_list', raison: 'absences de la personne connectée, par date' },
  { fichier: 'absences.js', rpc: 'absence_decisions', raison: 'journal des décisions, par date (export Excel)' },
  { fichier: 'absences.js', rpc: 'absence_export', raison: 'export Excel : lignes par demande, synthèse déjà triée par compareNames' },
  { fichier: 'absences.js', rpc: 'absence_planning', raison: 'export Excel du planning : personnes déjà triées par compareNames' },
  { fichier: 'absences.js', rpc: 'absence_circuit_mine', raison: 'schéma du circuit : étapes en séquence (les personnes d\'une étape passent par circuit-view.js)' },
  { fichier: 'absences.js', rpc: 'absence_approvals_all', raison: 'couvert par l\'inventaire (avancement de la validation)' },
  { fichier: 'admin-circuit.js', rpc: 'absence_circuit_mine', raison: 'idem' },
  { fichier: 'congres.js', rpc: 'event_talks', raison: 'présentations classées par date et heure' },
  { fichier: 'congres.js', rpc: 'event_takeaways_list', raison: 'retours classés du plus récent au plus ancien' },
  { fichier: 'oncoodle.js', rpc: 'oncoodle_list', raison: 'sondages, pas des personnes' },
  { fichier: 'admin-members.js', rpc: 'admin_blocs_list', raison: 'seuls les noms et cliniques des blocs sont affichés (raccourcis), pas les responsables' },
  { fichier: 'admin-calendrier.js', rpc: 'admin_calendar_list', raison: 'journal chronologique du calendrier commun (auteurs en légende)' },
  { fichier: 'admin-calendrier.js', rpc: 'admin_calendar_log_list', raison: 'journal chronologique' },
  { fichier: 'review.js', rpc: 'admin_absence_config', raison: 'identifiants de validateurs par clinique, jamais affichés' },
  { fichier: 'absences.js', rpc: 'absence_my_validators_for', raison: 'couvert par l\'inventaire (validateurs prévenus à l\'envoi)' },
  { fichier: 'planning.js', rpc: 'plan_grid', raison: 'couvert par l\'inventaire (export Excel : ordre du tableur conservé)' },
];

// Tables lues par .from(...) : une sélection qui contient un nom de personne (ou « * » sur une table de personnes) est inventoriée ou exclue
const TABLES_PERSONNES = ['contacts', 'trial_flags', 'providers'];
const EXCLUS_TABLES = [
  { fichier: 'trials.js', table: 'trial_flags', raison: 'signalements de fiches, classés par date (auteur en légende)' },
  { fichier: 'trials.js', table: 'profiles', raison: 'profil de la personne connectée' },
  { fichier: 'formation.js', table: 'profiles', raison: 'profil de la personne connectée' },
  { fichier: 'welcome.js', table: 'profiles', raison: 'profil de la personne connectée' },
  { fichier: 'account.js', table: 'profiles', raison: 'profil de la personne connectée' },
  { fichier: 'auth.js', table: 'profiles', raison: 'profil de la personne connectée' },
  { fichier: 'annuaire.js', table: 'providers', raison: 'annuaire de prestataires : organisations, pas des personnes' },
  { fichier: 'duree.js', table: 'ug_slots', raison: '« name » est le nom d\'un traitement' },
];

const jsFiles = readdirSync(new URL('assets/js/', ROOT)).filter((f) => f.endsWith('.js'));
const src = Object.fromEntries(jsFiles.map((f) => [f, read('assets/js/' + f)]));
const pages = ['app', 'admin'].flatMap((d) => readdirSync(new URL(d + '/', ROOT)).filter((f) => f.endsWith('.html')).map((f) => d + '/' + f));

test('inventaire : chaque liste existe encore et passe par OnconicSort', () => {
  const echecs = [];
  for (const e of INVENTAIRE) {
    const s = src[e.fichier];
    if (s === undefined) { echecs.push(`${e.fichier} introuvable (${e.liste})`); continue; }
    if (!e.source.test(s)) echecs.push(`${e.fichier} : source des données introuvable pour « ${e.liste} » (${e.source}) : mettez l'inventaire à jour`);
    if (!e.tri.test(s)) echecs.push(`${e.fichier} : « ${e.liste} » n'est plus triée par OnconicSort (attendu : ${e.tri})`);
  }
  assert.deepEqual(echecs, [], echecs.join('\n') + '\n' + CONSIGNE);
});

test('chaque fonction SQL qui renvoie des personnes est inventoriée ou exclue explicitement', () => {
  const echecs = [];
  for (const f of jsFiles) {
    for (const m of src[f].matchAll(/(?:rpc|call)\((["'`])([a-z_0-9]+)\1/g)) {
      const rpc = m[2];
      if (!RPC_PERSONNES.includes(rpc)) continue;
      const inventoriee = INVENTAIRE.some((e) => e.fichier === f && [`rpc("${rpc}")`, `rpc("${rpc}"`, `"${rpc}"`].some((t) => e.source.test(t)));
      const exclue = EXCLUS.some((e) => e.fichier === f && e.rpc === rpc);
      if (!inventoriee && !exclue) echecs.push(`${f} appelle ${rpc}, liste de personnes absente de l'inventaire`);
    }
  }
  assert.deepEqual([...new Set(echecs)], [], [...new Set(echecs)].join('\n') + '\n' + CONSIGNE);
});

test('chaque lecture de table qui contient des noms de personnes est inventoriée ou exclue', () => {
  const echecs = [];
  for (const f of jsFiles) {
    for (const m of src[f].matchAll(/\.from\((["'])([a-z_]+)\1\)\s*\.select\(\s*(["'`])([^"'`]*)\3/g)) {
      const [, , table, , cols] = m;
      const noms = /\b(first_name|last_name|full_name|name)\b/.test(cols) || (cols.trim() === '*' && TABLES_PERSONNES.includes(table));
      if (!noms) continue;
      const inventoriee = INVENTAIRE.some((e) => e.fichier === f && [`from("${table}")`, `from('${table}')`].some((t) => e.source.test(t)));
      const exclue = EXCLUS_TABLES.some((e) => e.fichier === f && e.table === table);
      if (!inventoriee && !exclue) echecs.push(`${f} lit la table ${table} (${cols.trim().slice(0, 40)}) : liste de personnes absente de l'inventaire`);
    }
  }
  assert.deepEqual([...new Set(echecs)], [], [...new Set(echecs)].join('\n') + '\n' + CONSIGNE);
});

test('mutation : retirer l\'appel de tri fait échouer le motif de chaque entrée', () => {
  const faibles = [];
  for (const e of INVENTAIRE) {
    const s = src[e.fichier], m = e.tri.exec(s);
    if (!m) continue; // déjà signalé par le premier test
    const retire = s.slice(0, m.index) + '/* tri retiré */' + s.slice(m.index + m[0].length);
    if (e.tri.test(retire)) faibles.push(`${e.fichier} : le motif de tri de « ${e.liste} » reste vrai sans l'appel de tri (motif trop faible : ${e.tri})`);
  }
  assert.deepEqual(faibles, [], faibles.join('\n') + '\nLe motif doit viser l\'appel de tri lui-même, pas la création du sélecteur.');
});

test('les pages qui chargent un script trié chargent aussi name-sort.js avant lui', () => {
  const echecs = [];
  const fichiers = new Set(INVENTAIRE.map((e) => e.fichier));
  for (const p of pages) {
    const html = read(p);
    const scripts = [...html.matchAll(/<script[^>]*src="\/assets\/js\/([a-z-]+\.js)/g)].map((m) => m[1]);
    for (const f of scripts) {
      if (!fichiers.has(f)) continue;
      const i = scripts.indexOf('name-sort.js');
      // circuit-view.js lit OnconicSort à l'appel seulement ; les autres scripts le lisent au démarrage ou à l'appel, après leur chargement différé
      if (i < 0 || (f !== 'circuit-view.js' && i > scripts.indexOf(f))) echecs.push(`${p} charge ${f} sans name-sort.js avant lui`);
    }
  }
  assert.deepEqual(echecs, [], echecs.join('\n') + '\n' + CONSIGNE);
});

test('les listes à sélecteur déclarent un emplacement dans la page', () => {
  const emplacements = [
    ['app/absences.html', ['ab-dir-sort-slot', 'ab-who-sort-slot', 'ab-sort-slot']],
    ['admin/circuit-absences.html', ['cc-as-sort', 'cc-sim-sort', 'cc-who-sort']],
    ['admin/diffusion-absences.html', ['df-sort-slot']],
    ['admin/membres.html', ['am-sort-slot']],
    ['admin/absences.html', ['aa-sort-slot']],
    ['app/planning.html', ['pl-sort-slot']],
    ['app/contacts.html', ['an-sort-slot']],
    ['app/oncoodle.html', ['oc-sort-slot']],
  ];
  const echecs = [];
  for (const [p, ids] of emplacements) for (const id of ids) if (!read(p).includes(`id="${id}"`)) echecs.push(`${p} : emplacement ${id} manquant`);
  assert.deepEqual(echecs, [], echecs.join('\n'));
});
