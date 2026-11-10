#!/usr/bin/env python3
"""Onconic : dosages et posologies par indication des médicaments per os, à partir du fichier AIPS (Swissmedic / Refdata).

Le fichier AIPS (XML, https://download.swissmedicinfo.ch/) liste les RCP du Compendium avec l'URL de leur texte HTML.
Ce script (bibliothèque standard uniquement) :
  1. choisit les RCP humains en français des substances de substances.json (nom commercial ou DCI dans l'intitulé) ;
  2. télécharge leur HTML (cache local) ;
  3. extrait les dosages disponibles (rubrique « Présentation ») et les posologies par indication (rubrique « Posologie ») ;
  4. écrit un SQL de brouillons pour public.sl_rx (jamais visibles des médecins avant validation d'un admin).

Usage :
  python3 tools/compendium/aips_rx.py fetch AipsDownload_AAAAMMJJ.xml  --cache DIR
  python3 tools/compendium/aips_rx.py build AipsDownload_AAAAMMJJ.xml  --cache DIR --sql supabase/sl_rx_auto.sql --report DIR/report.md
Aucune donnée patient. Ne pas commiter le XML ni le cache.
"""
import argparse, html, json, os, re, sys, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CANCER = re.compile(r"cancer|carcinom|tumeur|lymphom|leuc[ée]mie|m[ée]lanom|myélom|myelom|gliom|sarcom|néoplas|neoplas", re.I)


def load_substances():
    return json.loads((HERE / "substances.json").read_text(encoding="utf-8"))


# ----- 1. Sélection des RCP dans le XML AIPS -----
def smpc_documents(xml_path):
    """Itère (description, url_html_fr) des RCP humains en français."""
    txt = Path(xml_path).read_text(encoding="utf-8-sig")
    for b in re.findall(r"<MedicinalDocumentsBundle>.*?</MedicinalDocumentsBundle>", txt, re.S):
        if "<Domain>Human</Domain>" not in b or "<Type>SmPC</Type>" not in b:
            continue
        for d in re.findall(r"<AttachedDocument>.*?</AttachedDocument>", b, re.S):
            if "<Language>fr</Language>" not in d:
                continue
            desc = re.search(r"<Description>(.*?)</Description>", d, re.S)
            url = re.search(r"<ContentType>text/html</ContentType>\s*<Url>([^<]+)</Url>", d)
            if desc and url:
                yield html.unescape(desc.group(1)).strip(), url.group(1)


def select(xml_path):
    subs = load_substances()
    pats = {k: re.compile("|".join(re.escape(x) for x in [v["dci"]] + v["brands"]), re.I) for k, v in subs.items()}
    out = {}
    for desc, url in smpc_documents(xml_path):
        for k, p in pats.items():
            if p.search(desc):
                out.setdefault(k, []).append((desc, url))
    return out


# ----- 2. Téléchargement -----
def fetch(url, cache, delay=0.3):
    f = Path(cache) / (url.rsplit("/", 1)[-1])
    if f.exists() and f.stat().st_size > 0:
        return f.read_text(encoding="utf-8")
    req = urllib.request.Request(url, headers={"User-Agent": "onconic-aips/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read().decode("utf-8", "replace")
            f.write_text(data, encoding="utf-8")
            time.sleep(delay)
            return data
        except Exception as e:  # réseau instable : nouvel essai espacé
            if attempt == 3:
                raise
            time.sleep(2 ** (attempt + 1))


# ----- 3. Extraction -----
def to_lines(page):
    s = re.sub(r"<script.*?</script>|<style.*?</style>", "", page, flags=re.S)
    s = re.sub(r"</t[dh]>", " | ", s)
    s = re.sub(r"</(p|div|h\d|tr|li)>|<br\s*/?>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", " ", s)).replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", x).strip(" |\t") for x in s.split("\n")]
    return [x for x in lines if x]


def section(lines, start, ends):
    """Lignes entre un titre de rubrique et le prochain titre parmi `ends` (titres exacts de l'AIPS)."""
    norm = lambda x: re.sub(r"\s+", "", x.replace("’", "'").lower())
    i = next((n for n, x in enumerate(lines) if norm(x).startswith(norm(start)) and len(x) < 80), None)
    if i is None:
        return []
    j = next((n for n in range(i + 1, len(lines)) if len(lines[n]) < 80 and any(norm(lines[n]) == norm(e) for e in ends)), len(lines))
    return lines[i + 1:j]


SECTION_AFTER_POSO = ["Contre-indications", "Mises en garde et précautions", "Interactions", "Grossesse/Allaitement"]
UNIT = r"(?:mg|g|µg|mcg|ml|mL)"
FORM = r"(comprim[ée]s? (?:pellicul[ée]s?|orodispersibles?|dispersibles?|effervescents?|à croquer|gastro-r[ée]sistants?)?|comprim[ée]s?|capsules? (?:molles?|dures?|gastro-r[ée]sistantes?)?|capsules?|gélules?|granulés?|poudre|solution buvable|suspension buvable)"


NUM = r"\d+(?:\s?[.,]\s?\d+)?"
DOSE = r"(" + NUM + r")\s*(mg|µg|mcg)(?!\s*/\s*(?:m²|kg|ml|mL))"
PAIR = re.compile(r"(" + NUM + r")\s*mg\s*/\s*(" + NUM + r")\s*mg", re.I)  # associations fixes (trifluridine/tipiracil)
DOSE_LIST = re.compile(r"(\bà|\bde|\bdosés? à|contient|contenant|\bdu)\s+" + DOSE + r"(?:\s*\([^)]{0,40}\))?(?:\s*(?:,|ou de|ou|et de|et)\s*" + DOSE + r"(?:\s*\([^)]{0,40}\))?)*", re.I)
ONE_DOSE = re.compile(DOSE, re.I)
BAD_BEFORE = re.compile(r"(corresp\w*\.?|[ée]quival\w*|[ée]quivaut|sous (?:la )?forme|soit|sodium|lactose)\s*(?:à|de|d')?\s*$", re.I)
BAD_AFTER = re.compile(r"^\s*(?:de|d')\s*(?:sodium|lactose|potassium|alcool|sorbitol|sucrose|saccharose|gel de silice|[ée]thanol)", re.I)
BULLET = re.compile(r"^[·•\-]?\s*(?:\S+\s+){0,3}?(" + NUM + r")\s*(mg|µg|mcg)\s*[:,]\s*" + FORM, re.I)


def fmt_dose(n, u):
    n = re.sub(r"\s", "", n).replace(".", ",")
    n = re.sub(r",0+$", "", n)
    return f"{n} {u.replace('mcg', 'µg')}"


def base_form(f):
    return re.sub(r"s\b", "", f.lower().strip())


def strengths(lines):
    """Dosages disponibles : [{form, dose}] d'après « Forme pharmaceutique et quantité de principe actif » et « Présentation »."""
    src = section(lines, "Forme pharmaceutique", ["Indications/Possibilités d'emploi"]) \
        + section(lines, "Présentation", ["Titulaire de l'autorisation", "Mise à jour de l'information"])
    found, default_form = [], None
    for x in src:
        mf = re.search(FORM, x, re.I)
        bullet = x[:1] in "·•-"
        form = base_form(mf.group(1)) if mf else (default_form if bullet else None)
        if mf and default_form is None:
            default_form = form
        if not form:
            continue
        pairs = list(PAIR.finditer(x))
        for pm in pairs:
            found.append((form, f"{fmt_dose(pm.group(1), 'mg')}/{fmt_dose(pm.group(2), 'mg')}"))
        x = PAIR.sub(" ", x)
        got = 0
        for m in DOSE_LIST.finditer(x):
            lead = m.group(1).lower()
            if BAD_BEFORE.search(x[max(0, m.start() - 30):m.start()]) or BAD_AFTER.match(x[m.end():m.end() + 25]):
                continue
            if lead in ("contient", "contenant"):
                if got or pairs:  # « contient 183 mg de sel (correspond à 150 mg de base) » : déjà couvert
                    continue
                d = ONE_DOSE.search(m.group(0))
                found.append((form, fmt_dose(d.group(1), d.group(2))))
                got += 1
                continue
            for d in ONE_DOSE.finditer(m.group(0)):
                found.append((form, fmt_dose(d.group(1), d.group(2))))
                got += 1
        b = BULLET.match(x)
        if b:
            found.append((base_form(b.group(3)), fmt_dose(b.group(1), b.group(2))))
        head = re.split(r":|emballage|boîte|flacon|plaquette", x, maxsplit=1, flags=re.I)[0]
        if mf and re.search(r"\d", head) and not re.search(r"contien|inscription", x, re.I):
            for d in ONE_DOSE.finditer(head):
                if not BAD_BEFORE.search(head[max(0, d.start() - 30):d.start()]):
                    found.append((form, fmt_dose(d.group(1), d.group(2))))
    # un seul libellé par dosage : la forme la plus précise (« comprimé pelliculé » plutôt que « comprimé »)
    best = {}
    for form, dose in found:
        k = (form.split()[0], dose)
        if k not in best or len(form) > len(best[k]):
            best[k] = form
    pair_first = {d.split("/")[0] for (_, d) in best if "/" in d}
    rows = [{"form": f, "dose": k[1]} for k, f in best.items() if "/" in k[1] or k[1] not in pair_first]
    num = lambda r: float(r["dose"].split()[0].replace(",", ".")) * (0.001 if "µg" in r["dose"] else 1)
    return sorted(rows, key=lambda r: (r["form"].split()[0], num(r)))


FREQ = [
    (re.compile(r"(?:une|1) fois par jour|1 ?x ?/ ?j|une fois/jour|en une (?:seule )?prise|dose journalière unique|une prise (?:quotidienne|par jour)|prise quotidienne", re.I), "1x/j", "une fois par jour"),
    (re.compile(r"(?:deux|2) fois par jour|2 ?x ?/ ?j|toutes les 12 heures|deux fois/jour", re.I), "2x/j", "2 fois par jour"),
    (re.compile(r"(?:trois|3) fois par jour|3 ?x ?/ ?j", re.I), "3x/j", "3 fois par jour"),
]
SKIP_SENT = re.compile(r"pédiatri|enfant|adolescent|réduc|réduit|interrompu|arrêt|maximal|prophylax|lopéramide|omis|puis |titration|insuffisance|âgé|fonction (hépatique|rénale)|reprise|reprendre|reprise|augment|^Si |^Dans le cas|réapparition", re.I)
GENERIC_HEAD = re.compile(r"^(posologie( usuelle)?|adultes?|posologie chez l'adulte|dosage|dose recommandée)?$", re.I)
SYN = {  # mots du sous-titre RCP -> expressions cherchées dans le texte de la limitation LS
    "nsclc": ["non a petites cellules", "cbnpc", "nsclc"], "cbnpc": ["non a petites cellules", "cbnpc"], "rcc": ["renal", "cellules renales"],
    "gist": ["stromal", "gist"], "net": ["neuroendocrine"], "pancreatic": ["pancrea"], "colorectal": ["colorectal", "colon", "rectum"],
    "mélanome": ["melanome"], "melanome": ["melanome"], "prostate": ["prostat"], "sein": ["sein", "mammaire"], "glioblastome": ["glioblastome"],
    "gliome": ["gliom"], "thyroïde": ["thyroid"], "gastrique": ["gastri", "estomac"], "hépatocellulaire": ["hepatocellulaire"], "ovaire": ["ovair"],
}
STOP = {"cancer", "carcinome", "traitement", "association", "monothérapie", "combinaison", "avec", "dans", "pour", "chez", "les", "des", "une", "patients", "mois", "nouvellement", "diagnostiqués", "localement", "avancé", "métastatique", "phase", "cas", "etc"}


def norm(s):
    import unicodedata
    return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()


def regimens(lines):
    """Posologie recommandée de chaque sous-titre de la rubrique Posologie :
    [{head, dose, unit, freq, freq_txt, bsa, sentence}] (première phrase par sous-titre, hors réductions, enfants et titrations)."""
    sec = section(lines, "Posologie/Mode d'emploi", SECTION_AFTER_POSO)
    stop = next((n for n, x in enumerate(sec) if re.match(r"(Ajustement|Adaptation|Modification) de la posologie", x, re.I)), len(sec))
    sec = sec[:stop]
    dose_re = re.compile(r"(\d+(?:[ .,']?\d+)?)\s*(mg/m\s?²|mg/m\s?2|mg|g)\b", re.I)
    head, out, seen_head = "", [], set()
    for x in sec:
        short = len(x) < 90 and not x.endswith((".", ":", ";")) and not dose_re.search(x)
        if short:
            head = x
            continue
        if re.search(SKIP_SENT, head) or head.startswith("(") or re.match(r"^[a-z] ", head):
            continue
        for sent in re.split(r"(?<=[.!?])\s+(?=[A-ZÀ-Ý«])", x):
            if SKIP_SENT.search(sent) or not re.search(r"recommand|posologie|dose|doit être", sent, re.I):
                continue
            plain = re.sub(r"\([^)]*\)", " ", sent)
            fq = min(((m.start(), a_, b_) for rx, a_, b_ in FREQ for m in [rx.search(plain)] if m), default=None)
            if not fq:
                continue
            doses = [m for m in dose_re.finditer(plain[:fq[0]])
                     if not re.search(r"(comprim\w*|gélule\w*|capsule\w*)(\s+\w+){0,2}\s+(de|à|dosés? à)\s*$", plain[max(0, m.start() - 40):m.start()], re.I)]
            if not doses:
                continue
            d = doses[-1]
            unit = re.sub(r"\s", "", d.group(2)).replace("²", "2").replace("m2", "m²")
            key = (re.sub(r"[ ']", "", d.group(1)), unit, fq[1], head)
            if key in seen_head:
                continue
            seen_head.add(key)
            out.append({"head": head, "dose": re.sub(r"[ ']", "", d.group(1)).replace(".", ",") if "," not in d.group(1) else d.group(1).replace(" ", ""),
                        "unit": "mg/m²" if "m" in unit and "/" in unit else unit, "freq": fq[1], "freq_txt": fq[2],
                        "bsa": "/" in unit, "sentence": sent.strip()})
    return out


def indications(lines):
    sec = section(lines, "Indications/Possibilités d'emploi", ["Posologie/Mode d'emploi"])
    return [x.lstrip("· ").strip() for x in sec if x.startswith("·")] or sec[:3]


def analyse(subkey, docs, cache):
    res = []
    for desc, url in docs:
        lines = to_lines(fetch(url, cache))
        inds = indications(lines)
        if not CANCER.search(" ".join(section(lines, "Indications/Possibilités d'emploi", ["Posologie/Mode d'emploi"]))):
            continue  # exclut p. ex. évérolimus antirejet de greffe
        res.append({"desc": desc, "url": url, "strengths": strengths(lines), "regimens": regimens(lines), "indications": inds})
    return res


# ----- 4. Brouillons sl_rx -----
SOLID = re.compile(r"^(comprimé|gélule|capsule)(?!.*(dispersible|orodispersible|effervescent))", re.I)
DISPLAY = {"comprimé": ("comprimé", "cp"), "gélule": ("capsule", "caps"), "capsule": ("capsule", "caps")}
SEED_ROW = re.compile(r"^\s*\('([^']+)', '((?:[^']|'')+)', '((?:[^']|'')+)'")
AUTO_SRC = "RCP Swissmedic (AIPS, {d}), extraction automatique, à vérifier"


def sql_lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def seed_rows():
    """Textes déjà préparés (sl_rx_seed.sql) : substance -> [(product_line, sig)]."""
    f = HERE.parent.parent / "supabase" / "sl_rx_seed.sql"
    rows = {}
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            m = SEED_ROW.match(line)
            if m:
                rows.setdefault(m.group(1), []).append((m.group(2).replace("''", "'"), m.group(3).replace("''", "'")))
    return rows


def num(s):
    return float(s.replace(",", "."))


def pick_strength(dose_mg, strengths_):
    """Dosage qui permet de former la dose avec le moins d'unités (≤ 8) : (dosage, nombre d'unités) ou None."""
    best = None
    for s in strengths_:
        if "/" in s:
            continue
        v = num(s.split()[0]) * (0.001 if s.endswith("µg") else 1)
        n = dose_mg / v
        if v > 0 and abs(n - round(n)) < 1e-6 and 1 <= round(n) <= 8 and (best is None or round(n) < best[1] or (round(n) == best[1] and v > best[2])):
            best = (s, round(n), v)
    return (best[0], best[1]) if best else None


SYN.update({"précoce": ["precoce", "adjuvant"], "avancé": ["avance", "metastatique"], "adjuvant": ["adjuvant"], "entretien": ["entretien"],
            "poumon": ["poumon", "bronchique"], "rein": ["renal"], "thyroïde": ["thyroid"], "ovaire": ["ovair"], "foie": ["hepatocellulaire"]})


def keywords_for(label, extra=()):
    out = []
    for w in re.split(r"[^\wÀ-ÿ]+", label.lower()):
        out += SYN.get(w, [])
    for m in re.finditer(r"(?:association|combinaison) (?:avec|au|à) (?:le |la |l'|l’|les )?\s*([\wÀ-ÿ-]{5,})", label, re.I):
        out.append(norm(m.group(1)))  # médicament partenaire, cité dans le texte de la limitation
    out += [norm(x) for x in extra]
    return ";".join(dict.fromkeys(out))[:290]


def clean_label(s, names):
    s = re.sub(r"\s+([’'.,;:)])", r"\1", s)
    s = re.sub(r"([’'(])\s+", r"\1", s)
    for n in names:
        s = re.sub(r"\b" + re.escape(n) + r"\b®?™?", "", s, flags=re.I)
    s = re.sub(r"\s+", " ", s).strip(" ,;:-")
    s = re.sub(r"^Monothérapie par \((.*)\)$", r"Monothérapie (\1)", s, flags=re.I)
    s = re.sub(r"^(Monothérapie par|en monothérapie)$", "Monothérapie", s, flags=re.I)
    return (s[:1].upper() + s[1:]) if s else "Posologie standard"


def label_for(r):
    h = r["head"].strip(" :")
    if h and not GENERIC_HEAD.match(h):
        return h[:190]
    m = re.search(r"en association (?:avec|au|à) (?:le |la |l'|l’|les )?([\wÀ-ÿ-]+)", r["sentence"], re.I)
    if m:
        return f"En association avec {m.group(1)}"
    m = re.match(r"(?:En cas de|Lorsque|Chez|Pour) ([^,]{3,80}),", r["sentence"])
    return (m.group(0)[:-1] if m else "Posologie standard")[:190]


def rx_form(sub, form):
    f0 = form.split()[0]
    return DISPLAY.get(f0, (f0, f0))


def build(data, subs, date, seed):
    """Retourne (sql, rapport)."""
    sql, rep = [], []
    sql.append(f"-- Dosages disponibles et posologies par indication des médicaments per os, extraits du Compendium (fichier AIPS du {date}).\n"
               "-- Généré par tools/compendium/aips_rx.py ; les textes créés sont des brouillons invisibles des médecins jusqu'à validation par un admin.\n"
               "-- À exécuter après sl.sql et sl_rx_indication.sql. Sans danger si relancé (aucun texte existant n'est écrasé, sauf les dosages disponibles).\n")
    sql.append("alter table public.sl_rx add column if not exists strengths jsonb not null default '[]';\n")
    upd, adopt, ins = [], [], []
    for sub, docs in sorted(data.items()):
        docs = [d for d in docs if d["strengths"] or d["regimens"]]
        if not docs:
            rep.append(f"- **{sub}** : aucun RCP oncologique exploitable dans l'AIPS.")
            continue
        brands = [d for d in docs if re.search("|".join(re.escape(b) for b in subs[sub]["brands"]), d["desc"], re.I)]
        ref = (brands or docs)[0]
        st = ref["strengths"]
        if not st:
            st = next((d["strengths"] for d in docs if d["strengths"]), [])
        stj = json.dumps(st, ensure_ascii=False)
        upd.append(f"update public.sl_rx set strengths = {sql_lit(stj)}::jsonb where substance = {sql_lit(sub)};")
        # régimes distincts (dose, fréquence) -> libellés d'indication
        groups = {}
        for r in ref["regimens"]:
            groups.setdefault((r["dose"], r["unit"], r["freq"], r["freq_txt"]), []).append(r)
        rep.append(f"- **{sub}** ({ref['desc']}) : dosages {', '.join(s['form'] + ' ' + s['dose'] for s in st) or 'non trouvés'} ; {len(groups)} posologie(s) distincte(s)")
        seeds = seed.get(sub, [])
        names = [sub, subs[sub]["dci"]] + subs[sub]["brands"] + re.findall(r"[A-Za-zÀ-ÿ]+", ref["desc"].replace("®", " "))[:3]
        multi = len(groups) > 1 and not subs[sub].get("no_variants")
        if subs[sub].get("no_variants"):
            groups = {}
        seed_doses = set()
        for _, ssig in seeds:
            seed_doses.update(x.replace(".", ",") for x in re.findall(r"S\. (\d+(?:[.,]\d+)?)", ssig))
        seed_forms = {pl.split(",")[1].split()[0] for pl, _ in seeds if "," in pl}
        forms = []
        for s in st:
            if SOLID.match(s["form"]):
                f = rx_form(sub, s["form"])
                if f not in forms:
                    forms.append(f)
        dci = (seeds[0][0].split(",")[0] if seeds else sub)
        for (dose, unit, freq, freq_txt), rs in groups.items():
            label = " ; ".join(dict.fromkeys(clean_label(label_for(r), names) for r in rs))[:195] if multi else None
            kw = (keywords_for(label) or None) if label else None
            r0 = rs[0]
            flat = unit == "mg"
            dose_mg = num(dose) if flat else None
            note = r0["sentence"][:420]
            targets = []  # (product_line, sig, forme)
            for disp, abbr in (forms or [("comprimé", "cp")]):
                forms_st = [s["dose"] for s in st if SOLID.match(s["form"]) and rx_form(sub, s["form"]) == (disp, abbr)]
                if flat:
                    pk = pick_strength(dose_mg, forms_st)
                    if pk:
                        targets.append((f"{dci}, {disp} {pk[0]}", f"S. {dose} mg = {pk[1]} {abbr} à prendre {freq_txt}", disp))
                    else:
                        targets.append((f"{dci}, {disp} {forms_st[-1] if forms_st else ''}".strip(), f"S. {dose} mg à prendre {freq_txt} [préciser le nombre d'unités]", disp))
                else:
                    targets.append((f"{dci}, {disp} {forms_st[-1] if forms_st else ''}".strip(), f"S. {dose} mg/m² {freq_txt} [dose en mg à calculer selon la surface corporelle]", disp))
            levels = json.dumps([["Dose initiale", f"{dose} {unit} {freq}"]], ensure_ascii=False)
            src = AUTO_SRC.format(d=date) + f" : {ref['desc']}"
            for (pl, sig, disp) in targets:
                same_pl = next((s for s in seeds if s[0] == pl), None)
                if multi and dose in seed_doses and same_pl:
                    adopt.append(f"update public.sl_rx set indication = {sql_lit(label)}, indication_match = {sql_lit(kw) if kw else 'null'} where substance = {sql_lit(sub)} and product_line = {sql_lit(pl)} and indication is null and status = 'draft';")
                elif dose in seed_doses and (same_pl or disp in seed_forms):
                    continue  # texte déjà préparé pour cette dose et cette forme
                else:
                    ins.append((sub, pl, label, kw, sig, levels, note, src, stj))
    if upd:
        sql.append("-- 1. Dosages disponibles (affichés sous le tableau des paliers)")
        sql.extend(upd)
        sql.append("")
    if adopt:
        sql.append("-- 2. Indication ajoutée aux brouillons existants dont la posologie correspond à une indication du RCP")
        sql.extend(adopt)
        sql.append("")
    if ins:
        sql.append("-- 3. Nouvelles posologies par indication ou forme galénique (brouillons)")
        rows = []
        for i, (sub, pl, label, kw, sig, levels, note, src, stj) in enumerate(ins):
            rows.append(f"  ({sql_lit(sub)}, {sql_lit(pl)}, {sql_lit(label) if label else 'null'}, {sql_lit(kw) if kw else 'null'}, {sql_lit(sig)}, {sql_lit(levels)}::jsonb, {sql_lit(note)}, {sql_lit(src)}, 'draft', {100 + i}, "
                        f"{sql_lit(stj)}::jsonb)")
        # Relançable : pas de nouvelle variante si un texte (même corrigé, validé ou renommé) existe déjà pour cette présentation et cette dose
        sql.append("select v.* from (values\n" + ",\n".join(rows) + "\n) as v(substance, product_line, indication, indication_match, sig, dose_levels, dose_note, source, status, position, strengths)\n"
                   "where not exists (select 1 from public.sl_rx e where e.substance = v.substance and e.product_line = v.product_line and split_part(e.sig, ' ', 2) = split_part(v.sig, ' ', 2))")
        sql[-1] = sql[-1].replace("select v.* from (values", "insert into public.sl_rx (substance, product_line, indication, indication_match, sig, dose_levels, dose_note, source, status, position, strengths)\nselect v.* from (values", 1)
        sql.append("on conflict (substance, product_line, (coalesce(indication, ''))) do nothing;")
    return "\n".join(sql) + "\n", "\n".join(rep) + "\n"


AIPS_URL = "https://download.swissmedicinfo.ch/"


def download(out_dir):
    """Télécharge le fichier AIPS (conditions d'utilisation Refdata acceptées par le titulaire du site le 10.11.2026) et retourne le chemin du XML."""
    import zipfile, urllib.parse, http.cookiejar
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    page = op.open(urllib.request.Request(AIPS_URL, headers={"User-Agent": "onconic-aips/1.0"}), timeout=60).read().decode("utf-8", "replace")
    form = {k: html.unescape(re.search(r'id="%s" value="([^"]*)"' % k, page).group(1)) for k in ("__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION")}
    form["ctl00$MainContent$BtnYes"] = "Yes"
    r = op.open(urllib.request.Request(AIPS_URL, data=urllib.parse.urlencode(form).encode(), headers={"User-Agent": "onconic-aips/1.0"}), timeout=300)
    data = r.read()
    if not data.startswith(b"PK"):
        raise SystemExit("Téléchargement AIPS impossible : la réponse n'est pas un zip (page de conditions modifiée ?)")
    z = Path(out_dir, "aips.zip")
    z.write_bytes(data)
    with zipfile.ZipFile(z) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".xml"))
        zf.extract(name, out_dir)
    return str(Path(out_dir, name))


def fingerprint(sel):
    import hashlib
    items = sorted(f"{k}|{u}" for k, docs in sel.items() for _, u in docs)
    return hashlib.sha256("\n".join(items).encode()).hexdigest()


def summary(data):
    """Résumé comparable d'un run : par substance, dosages et régimes du RCP de référence."""
    out = {}
    for k, docs in data.items():
        docs = [d for d in docs if d["strengths"] or d["regimens"]]
        if not docs:
            continue
        ref = docs[0]
        out[k] = {"strengths": [f"{s['form']} {s['dose']}" for s in ref["strengths"]],
                  "regimens": sorted({f"{r['dose']} {r['unit']} {r['freq']} ({r['head'][:40]})" for r in ref["regimens"]})}
    return out


def diff_summary(old, new):
    lines = []
    for k in sorted(set(old) | set(new)):
        o, n = old.get(k), new.get(k)
        if o is None:
            lines.append(f"- **{k}** : nouveau RCP exploitable")
        elif n is None:
            lines.append(f"- **{k}** : RCP plus exploitable")
        else:
            for f, lab in (("strengths", "dosages"), ("regimens", "posologies")):
                add, rem = sorted(set(n[f]) - set(o[f])), sorted(set(o[f]) - set(n[f]))
                if add or rem:
                    lines.append(f"- **{k}** ({lab}) : " + "; ".join([f"+ {x}" for x in add] + [f"- {x}" for x in rem]))
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["download", "check", "fetch", "build"])
    ap.add_argument("xml", help="fichier AIPS (XML) ; pour « download », le dossier de destination")
    ap.add_argument("--cache")
    ap.add_argument("--state", help="état du dernier run (tools/compendium/state.json)")
    ap.add_argument("--sql")
    ap.add_argument("--report")
    ap.add_argument("--only")
    a = ap.parse_args()
    if a.cmd == "download":
        print(download(a.xml))
        return
    if a.cmd == "check":
        # code 0 : aucun RCP des substances suivies n'a changé depuis le dernier run ; 10 : mise à jour (ou premier run)
        sel = select(a.xml)
        fp = fingerprint(sel)
        old = json.loads(Path(a.state).read_text(encoding="utf-8")) if a.state and Path(a.state).exists() else {}
        changed = old.get("fingerprint") != fp
        print(json.dumps({"changed": changed, "fingerprint": fp, "previous": old.get("aips_date")}))
        sys.exit(10 if changed else 0)
    if not a.cache:
        ap.error("--cache est nécessaire")
    Path(a.cache).mkdir(parents=True, exist_ok=True)
    sel = select(a.xml)
    data = {}
    for k, docs in sel.items():
        if a.only and k != a.only:
            continue
        print(k, len(docs), "RCP", file=sys.stderr)
        data[k] = analyse(k, docs, a.cache)
    Path(a.cache, "analysis.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    missing = [k for k in load_substances() if k not in sel]
    if missing:
        print("Sans RCP trouvé :", ", ".join(missing), file=sys.stderr)
    if a.cmd == "build":
        m = re.search(r"AipsDownload_(\d{4})(\d{2})(\d{2})", a.xml)
        date = f"{m.group(3)}.{m.group(2)}.{m.group(1)}" if m else time.strftime("%d.%m.%Y")
        sql, rep = build(data, load_substances(), date, seed_rows())
        if a.sql:
            Path(a.sql).write_text(sql, encoding="utf-8")
        new_sum = summary(data)
        if a.state:
            sp = Path(a.state)
            old = json.loads(sp.read_text(encoding="utf-8")) if sp.exists() else {}
            ch = diff_summary(old.get("summary", {}), new_sum) if old else ["- premier run : aucun état précédent"]
            rep += "\n## Changements depuis le dernier run (" + str(old.get("aips_date", "-")) + ")\n" + ("\n".join(ch) if ch else "Aucun changement de dosage ni de posologie.") + "\n"
            sp.write_text(json.dumps({"aips_date": date, "fingerprint": fingerprint(sel), "summary": new_sum}, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        if a.report:
            Path(a.report).write_text(rep, encoding="utf-8")
        print(rep)


if __name__ == "__main__":
    main()
