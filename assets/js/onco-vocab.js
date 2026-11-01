// Listes de saisie rapide par clinique : histologies et biomarqueurs fréquents (insérés dans le champ, à compléter).
// « … » marque la valeur à saisir. Listes à enrichir au fil de l'usage.
(function (root) {
  const V = {
    "Thoracique": {
      histo: ["Adénocarcinome pulmonaire, TTF-1+", "Carcinome épidermoïde pulmonaire, p40+", "Carcinome pulmonaire à petites cellules",
        "Carcinome neuroendocrine à grandes cellules", "Tumeur carcinoïde atypique", "Mésothéliome pleural épithélioïde",
        "Mésothéliome pleural biphasique", "Thymome de type …", "Carcinome thymique"],
      markers: ["PD-L1 TPS … %", "EGFR délétion exon 19", "EGFR L858R", "EGFR insertion exon 20", "Réarrangement ALK", "Réarrangement ROS1",
        "KRAS G12C", "BRAF V600E", "Saut de l'exon 14 de MET", "Fusion RET", "Mutation HER2 (ERBB2)", "Fusion NTRK", "Fusion NRG1",
        "EGFR/ALK/ROS1 négatifs", "Ki-67 … %"]
    },
    "Sénologie": {
      histo: ["Carcinome mammaire invasif de type non spécifique (NST), grade … de Nottingham", "Carcinome lobulaire invasif",
        "Carcinome canalaire in situ", "Carcinome mammaire triple négatif", "Carcinome mucineux", "Carcinome mammaire inflammatoire"],
      markers: ["RE … %", "RP … %", "HER2 IHC 0", "HER2 IHC 1+ (HER2-low)", "HER2 IHC 2+, ISH négative", "HER2 IHC 2+, ISH positive",
        "HER2 IHC 3+", "Ki-67 … %", "Mutation germinale BRCA1", "Mutation germinale BRCA2", "PALB2", "PIK3CA muté", "ESR1 muté",
        "AKT1/PTEN altéré", "PD-L1 CPS …", "Oncotype DX RS …"]
    },
    "Gynécologie": {
      histo: ["Carcinome séreux de haut grade de l'ovaire", "Carcinome endométrioïde de l'endomètre, grade …", "Carcinome séreux de l'endomètre",
        "Carcinosarcome utérin", "Carcinome à cellules claires", "Carcinome épidermoïde du col utérin", "Adénocarcinome du col utérin",
        "Carcinome épidermoïde de la vulve"],
      markers: ["Stade FIGO …", "BRCA1 muté", "BRCA2 muté", "HRD positif", "dMMR / MSI-H", "pMMR", "POLE muté", "p53 anormal",
        "HER2 IHC …", "PD-L1 CPS …", "FRα élevé", "RE … %", "CA-125 … U/ml"]
    },
    "Urologie": {
      histo: ["Adénocarcinome prostatique acinaire, Gleason … (ISUP …)", "Carcinome rénal à cellules claires, grade ISUP …",
        "Carcinome rénal papillaire", "Carcinome rénal chromophobe", "Carcinome urothélial de vessie de haut grade",
        "Carcinome urothélial du haut appareil", "Tumeur germinale séminomateuse", "Tumeur germinale non séminomateuse"],
      markers: ["PSA … ng/ml", "Temps de doublement du PSA … mois", "BRCA2 muté", "Altération HRR", "Risque IMDC …",
        "Composante sarcomatoïde", "FGFR3 altéré", "PD-L1 …", "Nectine-4", "HER2 IHC …", "AFP … ng/ml", "β-hCG … UI/l", "LDH … U/l"]
    },
    "Neuro-oncologie": {
      histo: ["Glioblastome IDH-wildtype, OMS grade 4", "Astrocytome IDH-muté, OMS grade …",
        "Oligodendrogliome IDH-muté et codélété 1p/19q, OMS grade …", "Gliome diffus de la ligne médiane H3 K27-altéré",
        "Méningiome, OMS grade …", "Lymphome primitif du système nerveux central", "Métastases cérébrales de …"],
      markers: ["IDH1 R132H", "IDH-wildtype", "Promoteur MGMT méthylé", "Promoteur MGMT non méthylé", "Codélétion 1p/19q",
        "Délétion homozygote CDKN2A/B", "Mutation du promoteur TERT", "Amplification EGFR", "Gain 7 / perte 10", "ATRX perdu",
        "BRAF V600E", "H3 K27M", "Ki-67 … %"]
    },
    "Mélanome": {
      histo: ["Mélanome cutané à extension superficielle, Breslow … mm", "Mélanome nodulaire, Breslow … mm", "Mélanome acrolentigineux",
        "Mélanome de type lentigo malin", "Mélanome muqueux", "Mélanome uvéal", "Carcinome de Merkel", "Carcinome épidermoïde cutané",
        "Carcinome basocellulaire"],
      markers: ["Ulcération présente", "Ulcération absente", "Index mitotique … /mm²", "BRAF V600E", "BRAF V600K", "BRAF sauvage",
        "NRAS muté", "KIT muté", "LDH … U/l", "HLA-A*02:01 positif", "Ganglion sentinelle positif", "Ganglion sentinelle négatif"]
    },
    "Lower GI": {
      histo: ["Adénocarcinome du côlon droit", "Adénocarcinome du côlon gauche", "Adénocarcinome du rectum", "Adénocarcinome mucineux",
        "Carcinome épidermoïde du canal anal", "Tumeur neuroendocrine de grade …"],
      markers: ["RAS sauvage", "KRAS muté (…)", "KRAS G12C", "NRAS muté", "BRAF V600E", "dMMR / MSI-H", "pMMR / MSS",
        "HER2 amplifié", "Fusion NTRK", "POLE muté", "ACE … µg/l", "Résection R0", "TME de bonne qualité"]
    },
    "Upper GI": {
      histo: ["Adénocarcinome gastrique, type … de Lauren", "Adénocarcinome de la jonction œsogastrique",
        "Carcinome épidermoïde de l'œsophage", "Adénocarcinome canalaire du pancréas", "Cholangiocarcinome intrahépatique",
        "Cholangiocarcinome extrahépatique", "Carcinome de la vésicule biliaire", "Carcinome hépatocellulaire", "Tumeur stromale gastro-intestinale (GIST)",
        "Tumeur neuroendocrine pancréatique de grade …"],
      markers: ["HER2 IHC …", "PD-L1 CPS …", "Claudine 18.2 positive", "dMMR / MSI-H", "Fusion FGFR2", "IDH1 muté", "KRAS G12D",
        "KRAS sauvage", "BRCA muté", "CA 19-9 … U/ml", "AFP … ng/ml", "Child-Pugh …", "BCLC …", "KIT exon 11"]
    },
    "ORL": {
      histo: ["Carcinome épidermoïde de l'oropharynx p16-positif", "Carcinome épidermoïde de l'oropharynx p16-négatif",
        "Carcinome épidermoïde de la cavité buccale", "Carcinome épidermoïde du larynx", "Carcinome épidermoïde de l'hypopharynx",
        "Carcinome du nasopharynx", "Carcinome adénoïde kystique", "Carcinome canalaire salivaire"],
      markers: ["p16 positif", "HPV positif", "PD-L1 CPS …", "EBV ADN plasmatique … copies/ml", "HER2 IHC …",
        "Récepteur des androgènes positif", "Extension extracapsulaire", "Marges positives"]
    },
    "Sarcomes": {
      histo: ["Léiomyosarcome, grade FNCLCC …", "Liposarcome dédifférencié", "Liposarcome myxoïde", "Sarcome pléomorphe indifférencié",
        "Synovialosarcome", "Ostéosarcome", "Sarcome d'Ewing", "Rhabdomyosarcome", "Tumeur stromale gastro-intestinale (GIST)",
        "Tumeur desmoïde"],
      markers: ["Grade FNCLCC …", "Amplification MDM2", "Translocation SS18-SSX", "Réarrangement EWSR1", "KIT exon 11",
        "KIT exon 9", "PDGFRA D842V", "Fusion NTRK", "Index mitotique … /5 mm²"]
    },
    "Radiologie interventionnelle": {
      histo: ["Carcinome hépatocellulaire", "Métastases hépatiques de …", "Cholangiocarcinome intrahépatique", "Carcinome rénal"],
      markers: ["AFP … ng/ml", "Child-Pugh …", "BCLC …", "ALBI grade …", "Nombre de lésions …", "Plus grande lésion … mm"]
    }
  };
  root.OncoVocab = V;
})(this);
