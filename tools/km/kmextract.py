#!/usr/bin/env python3
"""Extraction de courbes de Kaplan-Meier depuis le PDF d'une publication (fiches Key trials).

Principe : la plupart des PDF d'éditeurs contiennent les figures en vectoriel. On lit
directement les tracés (pdfplumber) au lieu de les estimer à l'oeil, ce qui donne des
médianes à ±0,3 mois et des taux à ±1 point. Quatre méthodes :

  - axes    : axes dessinés par des traits (cas le plus fréquent : NEJM, JCO, Lancet)
  - free    : sans traits d'axes ; on regroupe les tracés colorés et on calibre sur les graduations
  - rot     : figure pivotée de 90° sur la page (texte inversé, temps en vertical)
  - raster  : figure en image (manuscrits PMC) ; seuillage de couleur, précision moindre

Sous-commandes :  probe | item | rot | raster   (voir README.md)

Règles de contrôle (memory/projects/key-trials.md) : médiane à ±0,5 mois et taux publiés à ±2 points,
sinon ne pas enregistrer la courbe. Aucun PDF ne doit être commité (droits d'auteur).
"""
import argparse
import collections
import json
import re
import statistics
import sys

import numpy as np


# ---------------------------------------------------------------- régression
def fit(pairs):
    a = np.array(pairs, float)
    A = np.vstack([a[:, 0], np.ones(len(a))]).T
    m, c = np.linalg.lstsq(A, a[:, 1], rcond=None)[0]
    return float(m), float(c)


def robust(pairs, minn=4):
    """Régression linéaire en écartant les étiquettes aberrantes (texte parasite)."""
    pairs = list(pairs)
    while True:
        m, c = fit(pairs)
        res = [abs(m * a + c - b) for a, b in pairs]
        if max(res) <= max(0.6 * abs(m), 0.8) or len(pairs) <= minn:
            return pairs, (m, c)
        pairs.pop(res.index(max(res)))


def _num_words(page):
    return [w for w in page.extract_words() if re.fullmatch(r'\d+(\.\d+)?', w['text'])]


def _snap(pairs, ticks, tol):
    """Cale les étiquettes sur les vrais traits de graduation (corrige 0,5 à 1,5 pt de décalage)."""
    if len(ticks) < 3:
        return pairs
    out = []
    for a, b in pairs:
        d = [abs(t - b) for t in ticks]
        if min(d) < tol:
            out.append((a, ticks[d.index(min(d))]))
    return out if len(out) >= 3 else pairs


def _color_axes(o):
    c = o.get('stroking_color')
    return bool(c) and isinstance(c, tuple) and len(c) >= 3 and max(c) - min(c) >= 0.05


def _colored(o):
    c = o.get('stroking_color')
    if not c or not isinstance(c, tuple) or len(c) < 3:
        return False
    if len(c) == 4:
        return (not (c[0] < 0.03 and c[1] < 0.03 and c[2] < 0.03) and max(c[:3]) - min(c[:3]) > 0.05) \
            or (c[3] < 0.9 and max(c[:3]) > 0.05)
    return max(c) - min(c) > 0.08


def _marker(o):
    """Trait de repère de la médiane : 3 à 4 points, uniquement horizontal et vertical (en L)."""
    pts = o['pts']
    return len(pts) <= 4 and all(abs(a[0] - b[0]) < 0.3 or abs(a[1] - b[1]) < 0.3 for a, b in zip(pts, pts[1:]))


def _hsegments(page, test, colorfn):
    """Courbes dessinées en petits segments (2 points) : on garde les segments horizontaux
    (niveaux de survie) d'une couleur si elle en compte au moins 6 sur 4 niveaux distincts, sans remontée (une ligne de repère en pointillés n'a qu'un niveau) ; les verticaux (chutes,
    marques de censure) sont ignorés."""
    by = collections.defaultdict(list)
    for o in page.lines:
        if not colorfn(o) or len(o['pts']) != 2 or not test(o):
            continue
        (xa, ya), (xb, yb) = o['pts']
        if abs(ya - yb) < 0.2 and abs(xb - xa) >= 0.4:
            by[_key(o)].append(o['pts'])
    out = {}
    for k, v in by.items():
        segs = sorted(v, key=lambda sg: min(sg[0][0], sg[1][0]))
        levels = sorted({round(sg[0][1], 1) for sg in segs})
        ys = [sg[0][1] for sg in segs]  # y PDF croissant = survie décroissante : les niveaux ne remontent pas
        monotone = all(b >= a - 0.5 for a, b in zip(ys, ys[1:]))
        if len(levels) >= 4 and monotone and len(segs) >= 6:
            out[k] = [pt for sg in v for pt in sg]
    return out


def _key(o):
    return tuple(round(v, 2) for v in o['stroking_color'])


# ---------------------------------------------------------------- méthode « axes »
def panels(page):
    """Panneaux repérés par leurs axes (trait vertical long + trait horizontal à sa base)."""
    L = list(page.lines) + list(page.rects)
    v = [o for o in L if (o['x1'] - o['x0']) < 2 and (o['bottom'] - o['top']) > 60]
    out = []
    for ya in sorted(v, key=lambda o: o['top']):
        h = [o for o in L if (o['bottom'] - o['top']) < 2 and (o['x1'] - o['x0']) > 60
             and abs(o['top'] - ya['bottom']) < 4 and abs(o['x0'] - ya['x0']) < 4]
        if not h:
            continue
        xa = max(h, key=lambda o: o['x1'] - o['x0'])
        bb = (ya['x0'] - 45, ya['top'] - 14, xa['x1'] + 12, xa['bottom'] + 22)
        if not any(abs(bb[0] - q[0]) < 3 and abs(bb[1] - q[1]) < 3 for q in out):
            out.append(bb)
    return out


def axes(page, bbox):
    x0, t0, x1, b0 = bbox
    L = [o for o in list(page.lines) + list(page.rects)
         if x0 - 3 <= o['x0'] and o['x1'] <= x1 + 3 and t0 - 3 <= o['top'] and o['bottom'] <= b0 + 3]
    v = [o for o in L if (o['x1'] - o['x0']) < 2 and (o['bottom'] - o['top']) > 60]
    if not v:
        return None
    ya = max(v, key=lambda o: o['bottom'] - o['top'])
    h = [o for o in L if (o['bottom'] - o['top']) < 2 and (o['x1'] - o['x0']) > 60
         and abs(o['top'] - ya['bottom']) < 4 and abs(o['x0'] - ya['x0']) < 4]
    if not h:
        return None
    return ya, max(h, key=lambda o: o['x1'] - o['x0'])


def calibrate(page, bbox):
    """Retourne ((mx,cx),(my,cy),(xmin,xmax),(ymin,ymax),(axe_y,axe_x)) ou None.
    temps = mx*x_pdf + cx ; survie (0-1 ou 0-100 selon l'axe) = my*y_pdf + cy."""
    ax = axes(page, bbox)
    if not ax:
        return None
    ya, xa = ax
    ws = _num_words(page)
    rows = collections.defaultdict(list)
    for w in ws:
        if xa['top'] <= w['top'] <= xa['top'] + 16 and xa['x0'] - 8 <= w['x0'] <= xa['x1'] + 8:
            rows[round(w['top'] / 2)].append(w)
    xp = None
    for k in sorted(rows):
        r = sorted(rows[k], key=lambda w: w['x0'])
        if len(r) >= 3:
            pr, _ = robust([(float(w['text']), (w['x0'] + w['x1']) / 2) for w in r], 3)
            if len(pr) >= 3:
                xp = pr
                break

    def ylabels(axis):
        yt = [w for w in ws if axis['x0'] - 32 <= w['x1'] <= axis['x0'] + 2
              and axis['top'] - 8 <= w['top'] <= axis['bottom'] + 4]
        if len(yt) >= 3:
            pr, _ = robust([(float(w['text']), (w['top'] + w['bottom']) / 2) for w in yt], 3)
            if len(pr) >= 3:
                return pr
        return None

    yp = ylabels(ya)
    if xp and not yp:  # panneau de droite sans graduations Y : emprunter celles du panneau frère
        for sb in panels(page):
            if abs(sb[1] - bbox[1]) < 4 and abs(sb[3] - bbox[3]) < 4 and sb[0] != bbox[0]:
                sax = axes(page, sb)
                if sax and abs(sax[0]['top'] - ya['top']) < 3 and abs(sax[0]['bottom'] - ya['bottom']) < 3:
                    yp = ylabels(sax[0])
                    if yp:
                        break
    if not xp or not yp:
        return None
    lines = list(page.lines)
    tx = [o['x0'] for o in lines if (o['x1'] - o['x0']) < 0.6 and 1.5 <= (o['bottom'] - o['top']) <= 7
          and xa['top'] - 1 <= o['top'] <= xa['top'] + 2 and xa['x0'] - 4 <= o['x0'] <= xa['x1'] + 4]
    ty = [(o['top'] + o['bottom']) / 2 for o in lines if (o['bottom'] - o['top']) < 0.6
          and 1.5 <= (o['x1'] - o['x0']) <= 7 and ya['x0'] - 7 <= o['x0'] <= ya['x0'] + 2
          and ya['top'] - 3 <= o['top'] <= ya['bottom'] + 3]
    xp, yp = _snap(xp, tx, 4), _snap(yp, ty, 4)
    mx, cx = fit([(b, a) for a, b in xp])
    my, cy = fit([(b, a) for a, b in yp])
    return ((mx, cx), (my, cy), (min(a for a, b in xp), max(a for a, b in xp)),
            (min(a for a, b in yp), max(a for a, b in yp)), ax)


def series(page, bbox, cal):
    """{couleur: [(t, S), ...]} pour les tracés colorés du panneau (marques de censure exclues)."""
    (mx, cx), (my, cy), xr, yr = cal[:4]
    x0, t0, x1, b0 = bbox
    by = collections.defaultdict(list)
    for o in list(page.curves) + list(page.lines):
        if not _color_axes(o) or len(o['pts']) < 3:
            continue
        if max(o['x1'] - o['x0'], o['bottom'] - o['top']) < 6:
            continue
        if _marker(o):  # repères de médiane (traits en L, pointillés)
            continue
        if not (x0 - 5 <= o['x0'] and o['x1'] <= x1 + 5 and t0 - 5 <= o['top'] and o['bottom'] <= b0 + 5):
            continue
        by[_key(o)] += [(px * mx + cx, py * my + cy) for px, py in o['pts']
                        if min(xr[0], 0.0) - 0.3 <= px * mx + cx <= xr[1] + 0.3
                        and min(yr[0], 0.0) - 1 <= py * my + cy <= yr[1] + 1]
    inbox = lambda o: x0 - 5 <= o['x0'] and o['x1'] <= x1 + 5 and t0 - 5 <= o['top'] and o['bottom'] <= b0 + 5
    for k, v in _hsegments(page, inbox, _color_axes).items():
        if len(by.get(k, [])) < 10:  # pas de polyligne pour cette couleur : courbe en segments
            by[k] = [(px * mx + cx, py * my + cy) for px, py in v
                     if min(xr[0], 0.0) - 0.3 <= px * mx + cx <= xr[1] + 0.3
                     and min(yr[0], 0.0) - 1 <= py * my + cy <= yr[1] + 1]
    return {k: sorted(v) for k, v in by.items()}


# ---------------------------------------------------------------- méthode « free »
def panels_free(page, minsize=60):
    """Panneaux sans traits d'axes : composantes connexes des tracés colorés (au moins 2 couleurs)."""
    objs = [o for o in list(page.curves) + list(page.lines) if _colored(o)]
    boxes = [[o['x0'], o['top'], o['x1'], o['bottom']] for o in objs]
    n = len(boxes)
    par = list(range(n))

    def f(i):
        while par[i] != i:
            par[i] = par[par[i]]
            i = par[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            a, b = boxes[i], boxes[j]
            if a[0] <= b[2] + 2 and b[0] <= a[2] + 2 and a[1] <= b[3] + 2 and b[1] <= a[3] + 2:
                par[f(i)] = f(j)
    cl = collections.defaultdict(list)
    for i in range(n):
        cl[f(i)].append(i)
    out = []
    for v in cl.values():
        x0 = min(boxes[i][0] for i in v)
        t0 = min(boxes[i][1] for i in v)
        x1 = max(boxes[i][2] for i in v)
        b0 = max(boxes[i][3] for i in v)
        cols = {_key(objs[i]) for i in v}
        if x1 - x0 >= minsize and b0 - t0 >= minsize * 0.6 and len(cols) >= 2:
            out.append((x0, t0, x1, b0))
    return sorted(out, key=lambda b: (round(b[1] / 50), b[0]))


def calibrate_free(page, bb):
    x0, t0, x1, b0 = bb
    ws = _num_words(page)
    xt = [w for w in ws if b0 - 3 <= w['top'] <= b0 + 140 and x0 - 20 <= w['x0'] <= x1 + 20]
    rows = collections.defaultdict(list)
    for w in xt:
        rows[round(w['top'] / 2)].append(w)
    xp = None
    for k in sorted(rows):
        r = sorted(rows[k], key=lambda w: w['x0'])
        if len(r) >= 5:
            pr, _ = robust([(float(w['text']), (w['x0'] + w['x1']) / 2) for w in r], 5)
            if len(pr) >= 5:
                xp = pr
                break
    yt = [w for w in ws if x0 - 45 <= w['x1'] <= x0 + 3 and t0 - 12 <= w['top'] <= b0 + 8]
    if len(yt) >= 4:  # étiquettes alignées à droite : écarter le texte parasite
        med = statistics.median([w['x1'] for w in yt])
        yt = [w for w in yt if abs(w['x1'] - med) <= 2.5]
    yp = None
    if len(yt) >= 4:
        pr, _ = robust([(float(w['text']), (w['top'] + w['bottom']) / 2) for w in yt], 4)
        if len(pr) >= 4:
            yp = pr
    marks = list(page.lines) + list(page.rects)
    if xp and xt:
        ytop = min(w['top'] for w in xt)
        tx = [o['x0'] for o in marks if (o['x1'] - o['x0']) < 0.8 and 1.2 <= (o['bottom'] - o['top']) <= 8
              and ytop - 12 <= o['bottom'] <= ytop + 1 and x0 - 20 <= o['x0'] <= x1 + 20]
        xp = _snap(xp, tx, 3.5) if len(tx) >= 4 else xp
    if yp:
        xr_ = max(w['x1'] for w in yt)
        ty = [(o['top'] + o['bottom']) / 2 for o in marks if (o['bottom'] - o['top']) < 0.8
              and 1.2 <= (o['x1'] - o['x0']) <= 8 and xr_ - 1 <= o['x0'] <= xr_ + 10 and t0 - 12 <= o['top'] <= b0 + 160]
        yp = _snap(yp, ty, 3.5) if len(ty) >= 4 else yp
    return xp, yp


def series_free(page, bb, xp, yp):
    mx, cx = fit([(b, a) for a, b in xp])
    my, cy = fit([(b, a) for a, b in yp])
    xr = (min(a for a, b in xp), max(a for a, b in xp))
    yr = (min(a for a, b in yp), max(a for a, b in yp))
    x0, t0, x1, b0 = bb
    by = collections.defaultdict(list)
    for o in list(page.curves) + list(page.lines):
        if not _colored(o) or len(o['pts']) < 3:
            continue
        if max(o['x1'] - o['x0'], o['bottom'] - o['top']) < 6:
            continue
        if _marker(o):  # repères de médiane (traits en L, pointillés)
            continue
        if not (x0 - 3 <= o['x0'] and o['x1'] <= x1 + 3 and t0 - 3 <= o['top'] and o['bottom'] <= b0 + 3):
            continue
        by[_key(o)] += [(px * mx + cx, py * my + cy) for px, py in o['pts']
                        if min(xr[0], 0.0) - 0.3 <= px * mx + cx <= xr[1] + 0.3
                        and min(yr[0], 0.0) - 1 <= py * my + cy <= yr[1] + 1]
    inbox = lambda o: x0 - 3 <= o['x0'] and o['x1'] <= x1 + 3 and t0 - 3 <= o['top'] and o['bottom'] <= b0 + 3
    for k, v in _hsegments(page, inbox, _colored).items():
        if len(by.get(k, [])) < 10:
            by[k] = [(px * mx + cx, py * my + cy) for px, py in v
                     if min(xr[0], 0.0) - 0.3 <= px * mx + cx <= xr[1] + 0.3
                     and min(yr[0], 0.0) - 1 <= py * my + cy <= yr[1] + 1]
    return {k: sorted(v) for k, v in by.items()}, yr


# ---------------------------------------------------------------- figure pivotée
def series_rot(page, px0, px1, y0, y1, tmax):
    """Figure pivotée de 90° : la survie est lue sur x (px0 -> 100 %, px1 -> 0 %), le temps sur y
    (y0 -> 0, y1 -> tmax). Utiliser les objets `curves` (les `lines` contiennent les marques de censure)."""
    out = {}
    for o in page.curves:
        if not o.get('stroking_color') or len(o['pts']) < 20:
            continue
        if not (px0 - 3 <= o['x0'] and o['x1'] <= px1 + 3
                and min(y0, y1) - 3 <= o['top'] and o['bottom'] <= max(y0, y1) + 3):
            continue
        out[_key(o)] = sorted(((py - y0) / (y1 - y0) * tmax, (1 - (px - px0) / (px1 - px0)) * 100)
                              for px, py in o['pts'])
    return out


# ---------------------------------------------------------------- effectifs à risque
def atrisk(page, cal, nrows, step=None):
    (mx, cx), _, xr, _, ax = cal
    xa = ax[1]
    if step is None:
        step = 3 if xr[1] <= 36 else 6 if xr[1] <= 60 else 12
    ws = [w for w in page.extract_words() if re.fullmatch(r'\d+', w['text'])
          and xa['top'] + 14 <= w['top'] <= xa['top'] + 14 + 16 * (nrows + 2)
          and xa['x0'] - 8 <= w['x0'] <= xa['x1'] + 14]
    rows = collections.defaultdict(list)
    for w in ws:
        rows[round(w['top'] / 3)].append(w)
    rr = [sorted(v, key=lambda w: w['x0']) for _, v in sorted(rows.items())]
    rr = [r for r in rr if len(r) >= 3][-nrows:]
    out = []
    for r in rr:
        d = {}
        for w in r:
            t = ((w['x0'] + w['x1']) / 2) * mx + cx
            k = round(t / step) * step
            if abs(t - k) < 0.45 * step:
                d[k] = int(w['text'])
        out.append(sorted(d.items()))
    return out


# ---------------------------------------------------------------- courbes -> items `km`
def to_percent(pts, yr):
    return [(x, y * (100 if yr[1] <= 1.0 else 1)) for x, y in pts]


def sample(pts, step=0.5, mark_every=12):
    """Fonction en escalier échantillonnée tous les `step` mois (valeur = minimum des points à t' <= t)."""
    tmax = max(x for x, _ in pts)
    sm, t = [], 0.0
    while t <= tmax + 1e-9:
        v = min([y for x, y in pts if x <= t + 1e-6] or [100.0])
        sm.append([round(t, 2), round(min(v, 100.0), 1)])
        t += step
    for i in range(1, len(sm)):
        sm[i][1] = min(sm[i][1], sm[i - 1][1])
    median = next((round(float(x), 1) for x, y in sorted(pts) if y <= 50), None)
    marks = [[t, v] for t, v in sm if t > 0 and abs(t / mark_every - round(t / mark_every)) < 1e-9]
    arm = {'points': sm, 'marks': marks}
    if median is not None:
        arm['median'] = median
    return arm


def make_item(series_by_color, yr, colors, names, ep, hr, label, source, xmax, step=0.5,
              atrisk_rows=None, atrisk_step=None):
    arms = []
    for col, nm in zip(colors, names):
        a = sample(to_percent(series_by_color[tuple(col)], yr), step)
        a['arm'] = nm
        arms.append(a)
    item = {'ep': ep, 'hr': hr, 'arms': arms, 'xmax': xmax, 'label': label, 'source': source, 'digitized': True}
    if atrisk_rows:
        n = max(len(r) for r in atrisk_rows)
        st = atrisk_step or 1
        item['atrisk'] = {'times': [i * st for i in range(n)],
                          'counts': [[c for _, c in r] + [0] * (n - len(r)) for r in atrisk_rows]}
    return item


def item_from_pdf(pdf_path, page_no, panel, colors, names, method='axes', ep='OS', hr='', label='',
                  source='', xmax=None, step=0.5, with_atrisk=True, atrisk_step=None):
    import pdfplumber
    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[page_no - 1]
        if method == 'axes':
            bb = panels(page)[panel]
            cal = calibrate(page, bb)
            ser, yr = series(page, bb, cal), cal[3]
            rows = atrisk(page, cal, len(names), atrisk_step) if with_atrisk else None
        else:
            bb = panels_free(page)[panel]
            xp, yp = calibrate_free(page, bb)
            ser, yr = series_free(page, bb, xp, yp)
            rows = None
        if xmax is None:
            xmax = max(x for pts in ser.values() for x, _ in pts)
    st = atrisk_step if atrisk_step else (3 if xmax <= 36 else 6 if xmax <= 60 else 12)
    return make_item(ser, yr, colors, names, ep, hr, label, source, xmax, step, rows, st)


def item_rot(pdf_path, page_no, px0, px1, y0, y1, tmax, colors, names, ep='PFS', hr='', label='',
             source='', xmax=None, step=0.5):
    import pdfplumber
    with pdfplumber.open(pdf_path) as pdf:
        ser = series_rot(pdf.pages[page_no - 1], px0, px1, y0, y1, tmax)
    return make_item(ser, (0, 100), colors, names, ep, hr, label, source, xmax or tmax, step)


# ---------------------------------------------------------------- figure en image (raster)
def raster_axes(img, crop):
    """Axes d'un panneau raster : (colonne axe Y, ligne 100 %, ligne 0 %, colonne fin de l'axe X)."""
    x0, y0, x1, y1 = crop
    dark = img[y0:y1, x0:x1].max(axis=2) < 110
    cx, ry = int(dark.sum(axis=0).argmax()), int(dark.sum(axis=1).argmax())
    ys = np.where(dark[:, cx])[0]
    xs = np.where(dark[ry, :])[0]
    return x0 + cx, y0 + int(ys.min()), y0 + ry, x0 + int(xs.max())


def raster_mask(img, rgb, tol=70):
    d = np.abs(img - np.array(rgb)).sum(axis=2)
    return d < tol


def raster_trace(mask, ax, xmax, step=0.1):
    xl, yt, yb, xr = ax
    prev, out, t = yt, [], 0.0
    while t <= xmax + 1e-9:
        col = min(max(int(round(xl + (xr - xl) * t / xmax)), xl + 1), xr)
        ys = np.where(mask[yt - 3:yb + 3, col])[0] + yt - 3
        if len(ys):
            groups = np.split(ys, np.where(np.diff(ys) > 3)[0] + 1)
            c = min((g.mean() for g in groups), key=lambda v: abs(v - prev))
            prev = c if abs(c - prev) < (yb - yt) * 0.25 else prev  # continuité : ignore la légende
        out.append((round(t, 2), 100.0 * (yb - prev) / (yb - yt)))
        t += step
    return out


def item_raster(image_path, crop, xmax, colors_rgb, names, ep='OS', hr='', label='', source='', step=0.5):
    from PIL import Image
    img = np.array(Image.open(image_path).convert('RGB')).astype(int)
    ax = raster_axes(img, crop)
    ser = {}
    for rgb in colors_rgb:
        ser[tuple(rgb)] = raster_trace(raster_mask(img, rgb), ax, xmax)
    return make_item(ser, (0, 100), colors_rgb, names, ep, hr, label, source, xmax, step)


# ---------------------------------------------------------------- inspection
def median_of(pts, yr):
    return next((x for x, y in sorted(to_percent(pts, yr)) if y <= 50), None)


def surv_at(pts, yr, t):
    return min([y for x, y in to_percent(pts, yr) if x <= t + 1e-6] or [100.0])


def probe(pdf_path, pages=None):
    """Liste les panneaux de survie détectés avec médiane et taux à 12/24/36/60 mois."""
    import pdfplumber
    rows = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, p in enumerate(pdf.pages):
            if pages and (i + 1) not in pages:
                continue
            if len(p.lines) + len(p.curves) < 20:
                continue
            found = []
            for k, bb in enumerate(panels(p)):
                try:
                    cal = calibrate(p, bb)
                    if cal:
                        found.append(('axes', k, bb, series(p, bb, cal), cal[3]))
                except Exception:
                    pass
            if not found:
                for k, bb in enumerate(panels_free(p)):
                    try:
                        xp, yp = calibrate_free(p, bb)
                        if xp and yp:
                            s, yr = series_free(p, bb, xp, yp)
                            found.append(('free', k, bb, s, yr))
                    except Exception:
                        pass
            for method, k, bb, ser, yr in found:
                for col, pts in ser.items():
                    rows.append({'page': i + 1, 'method': method, 'panel': k, 'color': list(col),
                                 'tmax': round(max(x for x, _ in pts), 1),
                                 'median': median_of(pts, yr) and round(median_of(pts, yr), 1),
                                 'S12': round(surv_at(pts, yr, 12), 1), 'S24': round(surv_at(pts, yr, 24), 1),
                                 'S36': round(surv_at(pts, yr, 36), 1), 'S60': round(surv_at(pts, yr, 60), 1)})
    return rows


def _colors(s):
    return [tuple(float(v) for v in c.split(',')) for c in s.split(';')]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('probe', help='lister les panneaux et leurs médianes')
    p.add_argument('pdf')
    p.add_argument('--pages', type=lambda s: [int(x) for x in s.split(',')])
    for name in ('item', 'rot', 'raster'):
        q = sub.add_parser(name)
        q.add_argument('source_file')
        q.add_argument('--colors', required=True, help='couleurs des tracés, séparées par « ; » (r,g,b[,k])')
        q.add_argument('--names', required=True, help='noms des bras, séparés par « ; »')
        q.add_argument('--ep', default='OS')
        q.add_argument('--hr', default='')
        q.add_argument('--label', default='')
        q.add_argument('--source', default='')
        q.add_argument('--xmax', type=float)
        q.add_argument('--step', type=float, default=0.5)
        if name == 'item':
            q.add_argument('--page', type=int, required=True)
            q.add_argument('--panel', type=int, default=0)
            q.add_argument('--method', choices=('axes', 'free'), default='axes')
            q.add_argument('--no-atrisk', action='store_true')
            q.add_argument('--atrisk-step', type=float)
        elif name == 'rot':
            q.add_argument('--page', type=int, required=True)
            for k in ('px0', 'px1', 'y0', 'y1', 'tmax'):
                q.add_argument('--' + k, type=float, required=True)
        else:
            q.add_argument('--crop', required=True, help='x0,y0,x1,y1 en pixels')
            q.add_argument('--tol', type=int, default=70)
    a = ap.parse_args(argv)
    if a.cmd == 'probe':
        for r in probe(a.pdf, a.pages):
            print(json.dumps(r, ensure_ascii=False))
        return 0
    names = a.names.split(';')
    colors = _colors(a.colors)
    if a.cmd == 'item':
        it = item_from_pdf(a.source_file, a.page, a.panel, colors, names, a.method, a.ep, a.hr, a.label,
                           a.source, a.xmax, a.step, not a.no_atrisk, a.atrisk_step)
    elif a.cmd == 'rot':
        it = item_rot(a.source_file, a.page, a.px0, a.px1, a.y0, a.y1, a.tmax, colors, names, a.ep, a.hr,
                      a.label, a.source, a.xmax, a.step)
    else:
        crop = tuple(int(v) for v in a.crop.split(','))
        it = item_raster(a.source_file, crop, a.xmax, [tuple(int(v) for v in c) for c in colors], names,
                         a.ep, a.hr, a.label, a.source, a.step)
    print(json.dumps(it, ensure_ascii=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
