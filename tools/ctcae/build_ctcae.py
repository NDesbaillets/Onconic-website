"""Construit assets/data/ctcae.json à partir des Excel NCIt CTCAE v5.0 et v6.0 (NCI, domaine public).

Usage : python3 -I tools/ctcae/build_ctcae.py CTCAE_5.0_NCIt.xls NCIt_CTCAE_6.0.xls assets/data/ctcae.json
Dépendances : pandas, xlrd. Les fichiers Excel ne sont pas dans le dépôt.

Les traductions françaises (noms de termes, définitions de grade) sont dans fr_terms.json et fr_grades.json,
indexées par le texte anglais normalisé (espaces simples). Une chaîne sans traduction est signalée et laissée vide.
"""
import json
import os
import re
import sys

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
n = lambda x: re.sub(r"\s+", " ", str(x)).strip()
key = lambda t: re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()

SOC_FR = {
    "Blood and Lymphatic System Disorders": "Affections hématologiques et du système lymphatique",
    "Cardiac Disorders": "Affections cardiaques",
    "Congenital, Familial and Genetic Disorders": "Affections congénitales, familiales et génétiques",
    "Ear and Labyrinth Disorders": "Affections de l'oreille et du labyrinthe",
    "Endocrine Disorders": "Affections endocriniennes",
    "Eye Disorders": "Affections oculaires",
    "Gastrointestinal Disorders": "Affections gastro-intestinales",
    "General Disorders and Administration Site Conditions": "Troubles généraux et anomalies au site d'administration",
    "Hepatobiliary Disorders": "Affections hépatobiliaires",
    "Immune System Disorders": "Affections du système immunitaire",
    "Infections and Infestations": "Infections et infestations",
    "Injury, Poisoning and Procedural Complications": "Lésions, intoxications et complications d'interventions",
    "Investigations": "Investigations",
    "Metabolism and Nutrition Disorders": "Troubles du métabolisme et de la nutrition",
    "Musculoskeletal and Connective Tissue Disorders": "Affections musculo-squelettiques et du tissu conjonctif",
    "Neoplasms Benign, Malignant and Unspecified (Incl Cysts and Polyps)": "Tumeurs bénignes, malignes et non précisées (incl. kystes et polypes)",
    "Nervous System Disorders": "Affections du système nerveux",
    "Pregnancy, Puerperium and Perinatal Conditions": "Grossesse, puerpéralité et affections périnatales",
    "Psychiatric Disorders": "Affections psychiatriques",
    "Renal and Urinary Disorders": "Affections du rein et des voies urinaires",
    "Reproductive System and Breast Disorders": "Affections des organes de reproduction et du sein",
    "Respiratory, Thoracic and Mediastinal Disorders": "Affections respiratoires, thoraciques et médiastinales",
    "Skin and Subcutaneous Tissue Disorders": "Affections de la peau et du tissu sous-cutané",
    "Social Circumstances": "Circonstances sociales",
    "Surgical and Medical Procedures": "Actes chirurgicaux et médicaux",
    "Vascular Disorders": "Affections vasculaires",
}

# Termes renommés entre v5 et v6 (clé = nom v5, valeur = nom v6) : une seule fiche, deux noms
RENAMED = {
    "Platelet count decreased": "Thrombocytopenia",
    "Lymphocyte count decreased": "Lymphopenia",
    "Ejection fraction decreased": "Left ventricular dysfunction",
    "Encephalitis infection": "Encephalitis",
    "Encephalomyelitis infection": "Encephalomyelitis",
    "Edema limbs": "Peripheral edema",
    "Night blindness": "Decreased night vision",
    "Proteinuria": "Urinary protein increased",
    "Bullous dermatitis": "Dermatosis bullous",
    "Eczema": "Eczematous dermatitis",
    "Thrush": "Candidiasis",
}


def parse(path, sheet, ptcol, defcol, cpcol):
    d = pd.read_excel(path, sheet_name=sheet)
    socs, cur_soc, cur = [], None, None
    for _, r in d.iterrows():
        name = r[ptcol]
        if not isinstance(name, str) or "by Body System" in name:
            continue
        cp = r[cpcol] if isinstance(r[cpcol], str) else None
        de = r[defcol] if isinstance(r[defcol], str) else None
        if pd.isna(r.get("MedDRA Code")) and not name.startswith("Grade"):
            cur_soc = {"soc": re.sub(r",\s*CTCAE( 6\.0)?$", "", name), "terms": []}
            socs.append(cur_soc)
            cur = None
            continue
        m = re.match(r"^Grade ([1-5]) ", cp or name)
        if m:
            if cur is not None and de:
                cur["grades"][int(m.group(1))] = n(de)
            continue
        cur = {"term": n(cp), "def": n(de or ""), "grades": {}}
        cur_soc["terms"].append(cur)
    return socs


def main(f5, f6, out):
    fr_terms = json.load(open(os.path.join(HERE, "fr_terms.json"), encoding="utf8"))
    fr_grades = json.load(open(os.path.join(HERE, "fr_grades.json"), encoding="utf8"))
    v5 = parse(f5, "CTCAE5.0", "NCIt PT", "CTCAE 5.0 Definition", "CTCAE PT")
    v6 = parse(f6, 0, "NCIt Preferred Term", "CTCAE 6.0 Definition", "CTCAE Preferred Term")

    soc_list = sorted({s["soc"] for s in v5 + v6}, key=lambda s: list(SOC_FR).index(s))
    soc_idx = {s: i for i, s in enumerate(soc_list)}

    gtab, gpos = [], {}
    dtab, dpos = [], {}
    missing = set()

    def gref(text):
        if text not in gpos:
            fr = fr_grades.get(text)
            if fr is None:
                missing.add(text)
            gpos[text] = len(gtab)
            gtab.append([text, fr or ""])
        return gpos[text]

    def dref(text):
        if not text:
            return -1
        if text not in dpos:
            dpos[text] = len(dtab)
            dtab.append(text)
        return dpos[text]

    terms = {}  # clé -> fiche
    order = []
    for ver, socs in (("5", v5), ("6", v6)):
        for s in socs:
            for t in s["terms"]:
                k = key(t["term"])
                if ver == "6":
                    old = next((a for a, b in RENAMED.items() if key(b) == k), None)
                    if old and key(old) in terms:
                        k = key(old)
                if k not in terms:
                    terms[k] = {"n": {}, "s": {}, "d": {}, "g": {}}
                    order.append(k)
                f = terms[k]
                f["n"][ver] = t["term"]
                f["s"][ver] = soc_idx[s["soc"]]
                f["d"][ver] = t["def"]
                f["g"][ver] = t["grades"]

    out_terms = []
    for k in order:
        f = terms[k]
        v = "6" if "6" in f["n"] else "5"          # nom et SOC de référence : la version la plus récente
        en = f["n"][v]
        fr = fr_terms.get(en) or fr_terms.get(f["n"].get("5", "")) or ""
        if not fr:
            missing.add(en)
        item = {"en": en, "fr": fr, "s": f["s"][v]}
        if "5" in f["n"] and "6" in f["n"] and f["n"]["5"] != f["n"]["6"]:
            item["n5"] = f["n"]["5"]
            item["fr5"] = fr_terms.get(f["n"]["5"], "")
        for ver in ("5", "6"):
            if ver in f["g"]:
                item["v" + ver] = [gref(f["g"][ver][i]) if i in f["g"][ver] else -1 for i in range(1, 6)]
                item["d" + ver] = dref(f["d"][ver])
        if "5" in f["g"] and "6" in f["g"]:
            item["soc5"] = f["s"]["5"] if f["s"]["5"] != f["s"]["6"] else None
            if item["soc5"] is None:
                del item["soc5"]
        out_terms.append(item)

    out_terms.sort(key=lambda t: (t["s"], t["en"].lower()))
    data = {
        "meta": {
            "v5": {"label": "CTCAE v5.0", "date": "27.11.2017", "meddra": "MedDRA 20.1"},
            "v6": {"label": "CTCAE v6.0", "date": "11.09.2025", "meddra": "MedDRA 28.0"},
            "source": "NCI Common Terminology Criteria for Adverse Events, fichiers NCIt (domaine public)",
        },
        "soc": [{"en": s, "fr": SOC_FR[s]} for s in soc_list],
        "g": gtab,
        "d": dtab,
        "t": out_terms,
    }
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    both = sum(1 for t in out_terms if "v5" in t and "v6" in t)
    print(f"{len(out_terms)} termes ({both} dans les deux versions), {len(gtab)} libellés de grade, {os.path.getsize(out) // 1024} Ko")
    if missing:
        print("SANS TRADUCTION :", len(missing))
        for m in sorted(missing)[:20]:
            print("  -", m)
        sys.exit(1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
