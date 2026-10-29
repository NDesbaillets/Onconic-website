// Modèles d'ordonnance (Rp.) des traitements de support, repris mot pour mot de l'exemple fourni par le médecin.
// {pegDay} est remplacé par le jour suivant la dernière chimiothérapie du cycle.
(function (root) {
  const RX = {
    pemetrexed: {
      title: "Prémédication Pemetrexed",
      lines: [
        ["Andreafol - 0.4 mg - comprimé (Acide folique (vitamine B9))",
         "S. 0.4 mg = 1 cpr po le matin dès une semaine avant le 1er traitement et jusqu'à 21 jours après la dernière dose"],
        ["Vitarubine parentéral - 1000 µg/mL - solution inj (Vitamine B12)",
         "S. 1000 µg = 1 mL im ou sc toutes les 9 semaines, dès une semaine avant le 1er traitement"],
        ["Dexaméthasone - 4 mg - comprimé (Dexaméthasone)",
         "S. 4 mg = 1 cpr po 2x/j matin et soir dès la veille du traitement et jusqu'à J5 post traitement, à chaque cycle"]
      ]
    },
    paclitaxel: {
      title: "Prémédication Paclitaxel",
      lines: [
        ["Dexaméthasone - 4 mg - comprimé (Dexaméthasone)",
         "S. 20 mg = 5 cpr po 12 heures et 6 heures avant le traitement"]
      ]
    },
    antiemetic: {
      title: "Réserves anti-émétiques",
      lines: [
        ["Olanzapine - 2.5 mg - comprimé (Olanzapine)",
         "S. 5 mg = 2 cpr po max. 1x/j si nausées (1ère réserve)"],
        ["Paspertin - 10 mg - comprimé filmé (Métoclopramide HCl)",
         "S. Métoclopramide HCl 10 mg = 1 cpr po 3x/j en réserve si nausée (1ère réserve)"],
        ["Ondansétron ODT - 4 mg - comprimé orodisp (Ondansétron)",
         "S. Ondansétron 4 mg = 1 cpr po max. 2x/j si nausées, pas dans les 4 jours suivant la chimiothérapie (2ème réserve)"],
        ["Dexaméthasone - 4 mg - comprimé (Dexaméthasone)",
         "S. 4 mg = 1 cpr po max. 1x/j si nausées (3ème réserve)"]
      ]
    },
    constipation: {
      title: "Réserves constipation",
      lines: [
        ["Movicol - poudre (Macrogol en association)",
         "S. 1 sachet(s) po max. 2x/j si constipation , Pendant un traitement par laxatifs, il est recommandé de boire une quantité suffisante de liquide (min 1.5 L/jour = 6 verres)"],
        ["Laxoberon - 7.5 mg/ml - goutte (Sodium picosulfate)",
         "S. 5 mg = 10 goutte(s) po en réserve max 1x/j si constipation"]
      ]
    },
    diarrhea: {
      title: "Réserves si diarrhées",
      lines: [
        ["Imodium - 2 mg - capsule (Lopéramide HCl)",
         "S. 2 mg = 1 caps po 6x/j, en réserve si diarrhée"]
      ]
    },
    filgrastim: {
      title: "Stimulation médullaire",
      lines: [
        ["Filgrastim - 30 mio UI - solution inj (Filgrastim ADNr)",
         "S. 1 seringue(s) sc 1x/j [08:00] - une injection par jour de J5 à J9 inclus, J1 étant le jour de la chimiothérapie"]
      ]
    },
    pegfilgrastim: {
      title: "Stimulation médullaire",
      lines: [
        ["Fulphila - 6 mg/0.6mL - solution inj (Pegfilgrastime)",
         "S. 6 mg = 0.6 mL inj sc Ordre unique - pour 1 Dose(s) à J{pegDay} post traitement"]
      ]
    }
  };

  // Antiémèse MASCC/ESMO, utilisée seulement si le protocole PDF ne la précise pas
  const MASCC = {
    high: "Hautement émétisant : antagoniste NK1 + antagoniste 5-HT3 + dexaméthasone + olanzapine J1 ; dexaméthasone et olanzapine J2-4 (MASCC/ESMO).",
    carbo: "Carboplatine AUC ≥ 4 : antagoniste NK1 + antagoniste 5-HT3 + dexaméthasone J1 (MASCC/ESMO).",
    moderate: "Modérément émétisant : antagoniste 5-HT3 + dexaméthasone J1 (MASCC/ESMO).",
    low: "Faiblement émétisant : dose unique d'antagoniste 5-HT3, de dexaméthasone ou d'antagoniste dopaminergique (MASCC/ESMO).",
    minimal: "Minimalement émétisant : pas de prophylaxie de routine (MASCC/ESMO)."
  };

  const RENEW = "Renouvelable 6 mois";

  const api = { RX, MASCC, RENEW };
  if (typeof module !== "undefined") module.exports = api;
  else root.InitRx = api;
})(this);
