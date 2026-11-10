#!/usr/bin/env python3
"""Retrouve et télécharge les PDF Zotero (collection KeyTrials-queue) pour une liste d'études.

Pourquoi ce script : la collection compte plus de 370 articles (près de 750 entrées avec les pièces
jointes). Un seul appel `items?limit=100` n'en voit qu'une fraction, d'où des fiches construites sur
l'abstract alors que le PDF était bien dans Zotero. Ici la pagination est exhaustive, la recherche se
fait par tag `KT:<étude>` ET par PMID, et seul un article qui a une pièce jointe PDF est retenu.

Usage :
  python3 tools/zotero/zotero_pdfs.py --out DOSSIER_NEUF 'MARIPOSA' 'CheckMate 816' 36108662 ...
  python3 tools/zotero/zotero_pdfs.py --list     # liste complète (tag, PMID, PDF oui/non)

Chaque argument est un nom d'étude (tag KT:<nom>, insensible à la casse) ou un PMID. La clé API est
injectée par le proxy de l'environnement : aucun en-tête d'authentification. Sortie : une ligne par
étude ("OK" avec le chemin du PDF, ou "ABSENT"), code retour 1 si une étude est absente.
Les PDF ne se commitent jamais (dépôt public).
"""
import argparse, json, os, re, subprocess, sys, time

USER, COLL = '22512740', 'XTGEQGYX'
BASE = f'https://api.zotero.org/users/{USER}'


def get(url, out=None, tries=4):
    for k in range(tries):
        cmd = ['curl', '-sS', '-L', '-H', 'Zotero-API-Version: 3', '-w', '\n%{http_code}']
        if out:
            cmd += ['-o', out]
        r = subprocess.run(cmd + [url], capture_output=True, text=True)
        body, _, code = r.stdout.rpartition('\n') if not out else ('', '', r.stdout.strip())
        if code.startswith('2'):
            return body
        time.sleep(2 ** (k + 1))
    raise SystemExit(f'Zotero injoignable ou refus ({code}) : {url}')


def fetch_all(path):
    """Pagine jusqu'à épuisement (100 par page)."""
    items, start = [], 0
    while True:
        page = json.loads(get(f'{BASE}{path}{"&" if "?" in path else "?"}limit=100&start={start}'))
        items += page
        if len(page) < 100:
            return items
        start += 100


def library():
    """Articles de la collection avec leurs pièces jointes PDF : liste de dicts."""
    tops = fetch_all(f'/collections/{COLL}/items/top')
    kids = [c for c in fetch_all(f'/collections/{COLL}/items')
            if c['data'].get('itemType') == 'attachment' and c['data'].get('contentType') == 'application/pdf']
    pdf_by_parent = {}
    for c in kids:
        pdf_by_parent.setdefault(c['data'].get('parentItem'), []).append(c['key'])
    out = []
    for it in tops:
        d = it['data']
        m = re.search(r'PMID:\s*(\d+)', d.get('extra', ''))
        out.append({'key': it['key'], 'title': d.get('title', ''), 'year': d.get('date', '')[:4],
                    'tags': [t['tag'][3:] for t in d.get('tags', []) if t['tag'].startswith('KT:')],
                    'pmid': m.group(1) if m else '', 'pdfs': pdf_by_parent.get(it['key'], [])})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('studies', nargs='*')
    ap.add_argument('--out', default='zotero_pdfs')
    ap.add_argument('--list', action='store_true')
    a = ap.parse_args()
    lib = library()
    if a.list:
        for r in sorted(lib, key=lambda r: (r['tags'] or [''])[0].lower()):
            print(f"{','.join(r['tags']) or '-':28} PMID {r['pmid'] or '-':9} {r['year']} PDF={'oui' if r['pdfs'] else 'non'}  {r['title'][:60]}")
        print(f'{len(lib)} articles, {sum(1 for r in lib if r["pdfs"])} avec PDF', file=sys.stderr)
        return
    os.makedirs(a.out, exist_ok=True)
    missing = 0
    for s in a.studies:
        s_low = s.strip().lower()
        hits = [r for r in lib if s_low in (t.lower() for t in r['tags']) or s_low == r['pmid']]
        with_pdf = [r for r in hits if r['pdfs']]
        if not with_pdf:
            note = f'{len(hits)} entrée(s) sans PDF' if hits else 'aucune entrée'
            print(f'ABSENT\t{s}\t{note}')
            missing += 1
            continue
        for r in with_pdf:  # plusieurs articles par étude possibles (princeps + mises à jour)
            dest = os.path.join(a.out, f"{r['pmid'] or r['key']}.pdf")
            get(f"{BASE}/items/{r['pdfs'][0]}/file", out=dest)
            ok = open(dest, 'rb').read(5) == b'%PDF-'
            print(f"{'OK' if ok else 'ERREUR'}\t{s}\tPMID {r['pmid']}\t{r['year']}\t{dest}\t{r['title'][:60]}")
            missing += 0 if ok else 1
    sys.exit(1 if missing else 0)


if __name__ == '__main__':
    main()
