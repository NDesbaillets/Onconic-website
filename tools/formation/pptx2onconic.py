"""Convertit un PowerPoint en recueil HTML au style Onconic (polices, tailles, couleurs, composants), autonome et sans ressource externe.

Usage : python3 pptx2onconic.py deck.pptx sortie.html [diapositives_à_exclure, ex. 24] ["Titre du recueil"]
Dépendances : python-pptx, lxml. Les notes du présentateur ne sont pas reprises.

Principe : le contenu (texte, tableaux, images, graphiques) est extrait puis remis en page avec les composants Onconic
(eyebrow, titre léger et filet ambre, cartes à bord supérieur, tableaux, encadrés, palette navy et ambre, Helvetica Neue).
La disposition est reconstruite par découpage XY (colonnes, lignes) à partir des positions du PowerPoint. Les schémas
à connecteurs sont conservés tels quels mais recolorés. Un ajustement automatique réduit une diapositive trop dense."""
import sys, re, os, html, base64
from lxml import etree
from pptx import Presentation

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pptx2html as base
from pptx2html import q, NS, E, fix, line_style, color_of, img_uri, Tf, xfrm_of

TOK = {  # palette Onconic
    'navy-900': '#00123A', 'navy-800': '#001B4D', 'navy-700': '#1B3A76', 'navy-200': '#C3CBD9', 'navy-100': '#DDE2EB',
    'mist': '#F2F4F8', 'amber-700': '#8A6000', 'amber-500': '#F0B12B', 'amber-50': '#FDF4E0', 'white': '#FFFFFF',
    'ink-900': '#1A2A4A', 'ink-600': '#5A6478', 'ink-400': '#8A93A6'}
FILL_TOKENS = ['navy-900', 'navy-800', 'navy-700', 'navy-200', 'navy-100', 'mist', 'amber-50', 'white']
TEXT_TOKENS = ['navy-900', 'navy-800', 'navy-700', 'ink-900', 'ink-600', 'ink-400', 'navy-200', 'white', 'amber-700', 'amber-500']

def rgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))

def lum(h):
    r, g, b = rgb(h); return 0.299 * r + 0.587 * g + 0.114 * b

def nearest(h, names):
    r, g, b = rgb(h)
    return min(names, key=lambda n: sum((a - c) ** 2 for a, c in zip((r, g, b), rgb(TOK[n]))))

def is_accent_blue(h):
    r, g, b = rgb(h); return b > 150 and b > r + 80 and g > r + 40

def tok_text(h, on_dark):
    """Couleur de texte Onconic la plus proche ; bleu vif du modèle -> ambre (accent du site)."""
    if not h: return 'white' if on_dark else 'ink-900'
    if is_accent_blue(h): return 'amber-500' if on_dark else 'amber-700'
    if on_dark and lum(h) > 150: return 'white' if lum(h) > 215 else 'navy-200'
    n = nearest(h, TEXT_TOKENS)
    if on_dark and n in ('navy-800', 'navy-900', 'navy-700', 'ink-900'): return 'white'
    if not on_dark and n in ('white', 'navy-200'): return 'ink-900' if lum(h) > 200 else n
    return n

def tok_fill(h):
    if not h: return None
    r, g, b = rgb(h)
    if r > 230 and g > 200 and b < 215 and r > b + 25: return 'amber-50'  # jaunes pâles
    if r > 200 and g > 140 and b < 110: return 'amber-50'                  # ambre du modèle
    return nearest(h, FILL_TOKENS)

DARK_FILLS = {'navy-900', 'navy-800', 'navy-700'}

# ---------- extraction ----------
class It(dict):
    __getattr__ = dict.get

def parse_paras(tb):
    out = []
    if tb is None: return out
    for p in q(tb, './a:p'):
        ppr = p.find('a:pPr', NS)
        runs = []
        for ch in p:
            tag = etree.QName(ch).localname
            if tag == 'r':
                rpr = ch.find('a:rPr', NS); t = ch.find('a:t', NS)
                txt = fix(t.text or '') if t is not None else ''
                runs.append(dict(t=txt, b=(rpr is not None and rpr.get('b') == '1'), i=(rpr is not None and rpr.get('i') == '1'),
                                 u=(rpr is not None and rpr.get('u') not in (None, 'none')), c=color_of(rpr) if rpr is not None else None,
                                 sz=int(rpr.get('sz')) if rpr is not None and rpr.get('sz') else None))
            elif tag == 'br':
                runs.append(dict(t='\n', b=False, i=False, u=False, c=None, sz=None))
        text = ''.join(r['t'] for r in runs).strip()
        if not text: continue
        bullet = ppr is not None and ppr.find('a:buChar', NS) is not None
        out.append(dict(runs=runs, text=text, bullet=bullet, lvl=int(ppr.get('lvl', '0')) if ppr is not None else 0,
                        algn=ppr.get('algn') if ppr is not None else None))
    return out

def collect(tree, tf, part, items, gid=0):
    for ch in tree:
        tag = etree.QName(ch).localname
        if tag in ('sp', 'cxnSp'):
            xf = xfrm_of(ch)
            if xf is None: continue
            x, y, w, h, xel = xf
            bx, by, bw, bh = tf.box(x, y, w, h)
            prst = (q(ch, './p:spPr/a:prstGeom/@prst') or ['rect'])[0]
            sppr = ch.find('p:spPr', NS)
            nm = ch.find('p:nvSpPr/p:cNvPr', NS)
            ph = q(ch, './p:nvSpPr/p:nvPr/p:ph/@type')
            it = It(kind='line' if (prst == 'line' or tag == 'cxnSp') else 'sp', bbox=(bx, by, bw, bh), prst=prst, el=ch,
                    fill=color_of(sppr) if sppr is not None else None,
                    line=line_style(sppr.find('a:ln', NS)) if sppr is not None else None,
                    paras=parse_paras(ch.find('p:txBody', NS)), name=nm.get('name') if nm is not None else '', ph=ph[0] if ph else None, gid=gid)
            items.append(it)
        elif tag == 'pic':
            x, y, w, h, _ = xfrm_of(ch)
            bx, by, bw, bh = tf.box(x, y, w, h)
            rid = q(ch, './p:blipFill/a:blip/@r:embed')[0]
            pt = part.related_part(rid)
            sr = ch.find('p:blipFill/a:srcRect', NS)
            crop = [int(sr.get(k, '0')) / 100000 if sr is not None else 0 for k in ('l', 't', 'r', 'b')]
            items.append(It(kind='pic', bbox=(bx, by, bw, bh), uri=img_uri(pt.blob, pt.partname.ext), crop=crop, alt=ch.find('p:nvPicPr/p:cNvPr', NS).get('descr') or '', gid=gid))
        elif tag == 'graphicFrame':
            x, y, w, h, _ = xfrm_of(ch)
            bx, by, bw, bh = tf.box(x, y, w, h)
            if q(ch, './/a:tbl'):
                items.append(It(kind='table', bbox=(bx, by, bw, bh), el=ch, gid=gid))
            elif q(ch, './/c:chart'):
                items.append(It(kind='chart', bbox=(bx, by, bw, bh), el=ch, part=part, gid=gid))
        elif tag == 'grpSp':
            xf = ch.find('p:grpSpPr/a:xfrm', NS)
            off, ext, co, ce = (xf.find('a:' + k, NS) for k in ('off', 'ext', 'chOff', 'chExt'))
            ox, oy, ex, ey = int(off.get('x')), int(off.get('y')), int(ext.get('cx')), int(ext.get('cy'))
            cx, cy, cex, cey = int(co.get('x')), int(co.get('y')), int(ce.get('cx')), int(ce.get('cy'))
            sx = ex / cex if cex else 1; sy = ey / cey if cey else 1
            ntf = Tf(tf.ox + (ox - tf.cx) * tf.sx, tf.oy + (oy - tf.cy) * tf.sy, sx * tf.sx, sy * tf.sy, cx, cy)
            collect(ch, ntf, part, items, gid + len(items) + 1)

def cx_(b): return b[0] + b[2] / 2
def cy_(b): return b[1] + b[3] / 2
def inside(inner, outer):
    return outer[0] - 2 <= cx_(inner) <= outer[0] + outer[2] + 2 and outer[1] - 2 <= cy_(inner) <= outer[1] + outer[3] + 2

def make_blocks(items):
    """Regroupe les formes : un rectangle plein absorbe les formes qu'il contient (carte)."""
    conts = [it for it in items if it.kind == 'sp' and it.fill and it.prst in ('rect', 'roundRect') and it.bbox[2] > 60 and it.bbox[3] > 28]
    for it in items: it.parent = None
    for it in items:
        best = None
        for c in conts:
            if c is it: continue
            if inside(it.bbox, c.bbox) and c.bbox[2] * c.bbox[3] > it.bbox[2] * it.bbox[3] * 1.01:
                if best is None or c.bbox[2] * c.bbox[3] < best.bbox[2] * best.bbox[3]: best = c
        it.parent = best
    for c in conts: c.kids = []
    for it in items:
        if it.parent is not None: it.parent.kids.append(it)
    return [it for it in items if it.parent is None]

# ---------- mise en page par découpage XY ----------
def merge_intervals(ivs, tol):
    ivs = sorted(ivs); out = [list(ivs[0])]
    for a, b in ivs[1:]:
        if a <= out[-1][1] + tol: out[-1][1] = max(out[-1][1], b)
        else: out.append([a, b])
    return out

def split(blocks, axis, tol):
    k = 1 if axis == 'y' else 0
    ivs = [(b.bbox[k], b.bbox[k] + b.bbox[k + 2]) for b in blocks]
    groups = merge_intervals(ivs, tol)
    if len(groups) < 2: return None
    res = [[] for _ in groups]
    for b in blocks:
        c = b.bbox[k] + b.bbox[k + 2] / 2
        for gi, (a, z) in enumerate(groups):
            if a - 1 <= c <= z + 1: res[gi].append(b); break
    return [r for r in res if r]

def layout(blocks):
    if len(blocks) == 1: return ('leaf', blocks[0])
    for axis, kind in (('y', 'stack'), ('x', 'row')):
        parts = split(blocks, axis, -12 if axis == 'y' else 6)
        if parts:
            return (kind, [layout(p) for p in parts], [sum(b.bbox[2] for b in p) / len(p) if axis == 'x' else 0 for p in parts],
                    [max(b.bbox[0] + b.bbox[2] for b in p) - min(b.bbox[0] for b in p) for p in parts] if axis == 'x' else None)
    return ('stack', [('leaf', b) for b in sorted(blocks, key=lambda b: (b.bbox[1], b.bbox[0]))], None, None)

# ---------- rendu des composants ----------
def esc(t): return html.escape(t, quote=False)

def run_html(r, on_dark, base_sz, cell=False):
    t = esc(r['t']).replace('\n', '<br>')
    st = []
    ratio = (r['sz'] / base_sz) if (r['sz'] and base_sz) else 1
    c = tok_text(r['c'], on_dark)
    if r['c'] and c not in ('ink-900', 'white'): st.append(f'color:var(--{c})')
    elif c == 'white' and not on_dark: st.append('color:#fff')
    if r['b']: st.append('font-weight:700')
    if r['i']: st.append('font-style:italic')
    if r['u']: st.append('text-decoration:underline')
    cls = ''
    if ratio >= 2.0: cls = 'xl'
    elif ratio >= 1.25: cls = 'lg'
    elif ratio <= 0.85: cls = 'sm'
    attr = (f' class="{cls}"' if cls else '') + (f' style="{";".join(st)}"' if st else '')
    return f'<span{attr}>{t}</span>' if attr else t

def base_size(paras):
    tot = {}
    for p in paras:
        for r in p['runs']:
            if r['sz']: tot[r['sz']] = tot.get(r['sz'], 0) + len(r['t'])
    return max(tot, key=tot.get) if tot else None

def paras_html(paras, on_dark, cell=False):
    out = []; bs = base_size(paras); i = 0
    while i < len(paras):
        p = paras[i]
        if p['bullet']:
            j = i; lis = []
            while j < len(paras) and paras[j]['bullet']:
                q_ = paras[j]
                lis.append(f'<li class="l{min(q_["lvl"], 2)}">' + ''.join(run_html(r, on_dark, bs) for r in q_['runs']).strip() + '</li>')
                j += 1
            out.append('<ul>' + ''.join(lis) + '</ul>'); i = j; continue
        al = ' style="text-align:center"' if p['algn'] == 'ctr' else (' style="text-align:right"' if p['algn'] == 'r' else '')
        out.append(f'<p{al}>' + ''.join(run_html(r, on_dark, bs) for r in p['runs']).strip() + '</p>')
        i += 1
    return ''.join(out)

def kid_rows(kids):
    """Enfants d'une carte : lignes (formes alignées côte à côte) triées de haut en bas."""
    ks = sorted(kids, key=lambda k: (k.bbox[1], k.bbox[0]))
    rows = []
    for k in ks:
        for r in rows:
            top = max(r[0].bbox[1], k.bbox[1]); bot = min(r[0].bbox[1] + r[0].bbox[3], k.bbox[1] + k.bbox[3])
            if bot - top >= 0.5 * min(r[0].bbox[3], k.bbox[3]): r.append(k); break
        else: rows.append([k])
    return [sorted(r, key=lambda k: k.bbox[0]) for r in rows]

def kid_html(k, on_dark):
    if k.kind == 'pic': return pic_html(k)
    if k.kind == 'sp' and k.prst == 'ellipse' and k.paras:
        return f'<span class="badge">{esc(k.paras[0]["text"])}</span>'
    if k.paras:
        kd = on_dark or (k.fill and tok_fill(k.fill) in DARK_FILLS)
        return paras_html(k.paras, kd)
    return ''

def pic_html(it):
    l, t, r, b = it.crop
    bw, bh = it.bbox[2], it.bbox[3]
    iw = 1 / max(1 - l - r, 0.01); ih = 1 / max(1 - t - b, 0.01)
    ratio = bw / bh if bh else 1
    if l or t or r or b:
        return (f'<figure class="pic crop" style="aspect-ratio:{ratio:.4f}"><img alt="{html.escape(it.alt or "", quote=True)}" src="{it.uri}" '
                f'style="left:{-l * iw * 100:.3f}%;top:{-t * ih * 100:.3f}%;width:{iw * 100:.3f}%;height:{ih * 100:.3f}%"></figure>')
    return f'<figure class="pic"><img alt="{html.escape(it.alt or "", quote=True)}" src="{it.uri}"></figure>'

def card_html(b):
    fill = tok_fill(b.fill)
    dark = fill in DARK_FILLS
    cls = {'navy-900': 'dk', 'navy-800': 'dk', 'navy-700': 'dk2', 'navy-200': 'md', 'navy-100': 'lt', 'mist': 'card', 'amber-50': 'key', 'white': 'card'}.get(fill, 'card')
    inner = paras_html(b.paras, dark) if b.paras else ''
    for row in kid_rows(b.kids):
        parts = [kid_html(k, dark) for k in row]
        parts = [p for p in parts if p]
        if not parts: continue
        inner += parts[0] if len(parts) == 1 else '<div class="inl">' + ''.join(f'<div>{p}</div>' for p in parts) + '</div>'
    return f'<div class="blk {cls}">{inner}</div>'

PAL_SER = {'9AA5B8': '#C3CBD9', '0E2352': '#001B4D'}

def chart_html(it):
    gf = it.el
    rid = q(gf, './/c:chart/@r:id')[0]
    root = it.part.related_part(rid)._element
    title = ''.join(q(root, './/c:chart/c:title//a:t/text()'))
    cats = q(root, './/c:ser[1]/c:cat//c:pt/c:v/text()')
    sers = []
    for ser in q(root, './/c:ser'):
        name = ''.join(q(ser, './c:tx//c:v/text()'))
        vals = [float(v) for v in q(ser, './c:val//c:pt/c:v/text()')]
        col = (q(ser, './c:spPr/a:solidFill/a:srgbClr/@val') or ['9AA5B8'])[0]
        pts = {int(q(d, './c:idx/@val')[0]): q(d, './c:spPr/a:solidFill/a:srgbClr/@val')[0] for d in q(ser, './c:dPt[c:spPr]')}
        sers.append((name, vals, col, pts))
    legend = bool(q(root, './/c:legend'))
    W, H = 520, 340
    top = 40 if title else 14; bottom = 58 if legend else 36
    ph = H - top - bottom
    vmax = max(v for _, vals, _, _ in sers for v in vals) * 1.15
    n = len(cats); ns = len(sers); gw = W / n; bw = gw * 0.6 / ns
    def pal(c):
        t = tok_fill('#' + c)
        return {'navy-200': '#C3CBD9', 'navy-100': '#C3CBD9', 'mist': '#C3CBD9'}.get(t, TOK.get(t, '#001B4D'))
    svg = [f'<svg class="chart" viewBox="0 0 {W} {H}" role="img" aria-label="{html.escape(title, quote=True)}">']
    if title: svg.append(f'<text x="{W / 2}" y="22" text-anchor="middle" font-size="16" fill="#5A6478">{esc(title)}</text>')
    base_y = top + ph
    svg.append(f'<line x1="0" y1="{base_y}" x2="{W}" y2="{base_y}" stroke="#DDE2EB" stroke-width="1"/>')
    for ci, cat in enumerate(cats):
        gx = ci * gw + gw * 0.2
        for si, (name, vals, col, pts) in enumerate(sers):
            v = vals[ci]; h = v / vmax * ph; x = gx + si * bw
            svg.append(f'<rect x="{x:.1f}" y="{base_y - h:.1f}" width="{bw:.1f}" height="{h:.1f}" fill="{pal(pts.get(ci, col))}"/>')
            svg.append(f'<text x="{x + bw / 2:.1f}" y="{base_y - h - 7:.1f}" text-anchor="middle" font-size="18" font-weight="300" fill="#001B4D">{f"{v:.1f}".replace(".", ",")}</text>')
        svg.append(f'<text x="{ci * gw + gw / 2:.1f}" y="{base_y + 22}" text-anchor="middle" font-size="14" fill="#1A2A4A">{esc(cat)}</text>')
    if legend:
        lx = W / 2 - 70 * ns
        for si, (name, vals, col, pts) in enumerate(sers):
            svg.append(f'<rect x="{lx + si * 140:.0f}" y="{H - 22}" width="10" height="10" fill="{pal(col)}"/><text x="{lx + si * 140 + 16:.0f}" y="{H - 12.5}" font-size="13" fill="#5A6478">{esc(name)}</text>')
    svg.append('</svg>')
    return f'<figure class="chartf">{"".join(svg)}</figure>'

def table_html(it):
    tbl = q(it.el, './/a:tbl')[0]
    cols = [int(c.get('w')) for c in q(tbl, './a:tblGrid/a:gridCol')]
    tot = sum(cols)
    rows = q(tbl, './a:tr')
    def cell_info(tc):
        tcpr = tc.find('a:tcPr', NS)
        fill = color_of(tcpr) if tcpr is not None else None
        paras = parse_paras(tc.find('a:txBody', NS))
        return fill, paras
    first = [cell_info(tc) for tc in q(rows[0], './a:tc')]
    head = any(f and tok_fill(f) in DARK_FILLS and any(p for p in ps) for f, ps in first)
    out = ['<table class="ot"><colgroup>' + ''.join(f'<col style="width:{c / tot * 100:.1f}%">' for c in cols) + '</colgroup>']
    for ri, tr in enumerate(rows):
        tag = 'th' if (ri == 0 and head) else 'td'
        if ri == 0 and head: out.append('<thead>')
        elif ri == 1 and head: out.append('<tbody>')
        out.append('<tr>')
        for tc in q(tr, './a:tc'):
            if tc.get('hMerge') == '1' or tc.get('vMerge') == '1': continue
            fill, paras = cell_info(tc)
            span = f' colspan="{tc.get("gridSpan")}"' if tc.get('gridSpan') else ''
            f = tok_fill(fill) if fill else None
            fcls = ' class="c1"' if (tag == 'td' and f in ('mist', 'navy-100')) else (' class="amb"' if f == 'amber-50' else '')
            out.append(f'<{tag}{span}{fcls}>{paras_html(paras, tag == "th")}</{tag}>')
        out.append('</tr>')
        if ri == 0 and head: out.append('</thead>')
    out.append('</tbody></table>' if head else '</table>')
    return ''.join(out)

def block_html(b):
    if b.kind == 'pic': return pic_html(b)
    if b.kind == 'table': return table_html(b)
    if b.kind == 'chart': return chart_html(b)
    if b.kind == 'sp' and b.fill and getattr(b, 'kids', None) is not None:
        return card_html(b)
    if b.kind == 'sp':
        if b.fill and b.paras: return card_html(b)
        return f'<div class="blk txt">{paras_html(b.paras, False)}</div>'
    return ''

def node_html(n, ctx_w):
    if n[0] == 'leaf': return f'<div class="leaf">{block_html(n[1])}</div>'
    if n[0] == 'stack':
        return '<div class="stack">' + ''.join(node_html(c, ctx_w) for c in n[1]) + '</div>'
    ws = n[3]
    return '<div class="row">' + ''.join(f'<div class="col" style="flex:{max(w, 1):.0f} 1 0">{node_html(c, ctx_w)}</div>' for c, w in zip(n[1], ws)) + '</div>'

# ---------- diapositives ----------
def role_of(it):
    nm = (it.name or '').lower()
    if it.ph == 'title': return 'title'
    if nm == 'kicker': return 'kicker'
    if nm == 'source': return 'source'
    return None

def slide_texts(paras): return ' '.join(p['text'] for p in paras)

def dark_slide(slide_items, n_out, logo_dark):
    texts = []
    for it in sorted([i for i in slide_items if i.kind == 'sp' and i.paras], key=lambda i: (i.bbox[1], i.bbox[0])):
        for p in it.paras:
            sz = max([r['sz'] or 0 for r in p['runs']] or [0])
            texts.append((p['text'], sz, any(r['b'] for r in p['runs'])))
    if not texts: return '', ''
    title_i = max(range(len(texts)), key=lambda i: texts[i][1])
    title = texts[title_i][0]
    if len(texts) <= 3 and re.fullmatch(r'\d{1,2}', texts[0][0]):
        num = texts[0][0]
        return (f'<div class="dk-wrap sec"><div class="num">{esc(num)}</div><h2>{esc(texts[title_i][0] if title_i else texts[-1][0])}</h2><div class="rule"></div></div>',
                texts[-1][0])
    kick = [t for t, _, _ in texts[:title_i]]
    after = [(t, b) for t, _, b in texts[title_i + 1:]]
    sub = after[0][0] if after else ''
    rest = after[1:]
    h = '<div class="dk-wrap ttl">'
    if kick: h += f'<div class="eyebrow">{esc(" ".join(kick))}</div>'
    h += f'<h1>{esc(title)}</h1><div class="rule"></div>'
    if sub: h += f'<p class="sub">{esc(sub)}</p>'
    if rest:
        h += '<div class="by">' + ''.join(f'<p class="{"b" if b else ""}">{esc(t)}</p>' for t, b in rest) + '</div>'
    h += f'</div>'
    return h, title

LOGOS = {}

def convert(path, skip=(), doc_title='Recueil'):
    prs = Presentation(path)
    logos = {}
    for k in ('light', 'dark'):
        p = os.path.join(HERE, '..', '..', 'assets', 'img', f'mark-on-{k}.svg')
        try:
            s = open(p, encoding='utf-8').read()
            s = re.sub(r'<metadata>.*?</metadata>', '', s, flags=re.S).replace('<?xml version="1.0"?>', '')
            logos[k] = 'data:image/svg+xml;base64,' + base64.b64encode(s.encode()).decode()
        except OSError:
            logos[k] = ''
    LOGOS.update(logos)
    secs = []
    n_out = 0
    for i, slide in enumerate(prs.slides, 1):
        if i in skip: continue
        lay = slide.slide_layout
        bg = (q(lay._element, './/p:bg//a:srgbClr/@val') or ['FFFFFF'])[0]
        dark = lum('#' + bg) < 120
        foot = ''
        for sh in lay.shapes:
            t = sh.text_frame.text.strip() if sh.has_text_frame else ''
            if t and 'Formation' in t: foot = t
        items = []
        collect(slide.shapes._spTree, Tf(), slide.part, items)
        n_out += 1
        if dark:
            inner, title = dark_slide(items, n_out, logos['dark'])
            secs.append(f'<section class="slide" data-title="{html.escape(title, quote=True)}"><div class="fit"><div class="stage d">'
                        f'{inner}<div class="ft"><i class="mk"></i><span class="ftx" data-t="{html.escape(foot, quote=True)}"></span></div></div></div></section>')
            continue
        roles = {r: [] for r in ('title', 'kicker', 'source')}
        rest = []
        for it in items:
            r = role_of(it) if it.kind == 'sp' else None
            (roles[r] if r else rest).append(it)
        title = ' '.join(slide_texts(t.paras) for t in roles['title']) or f'Diapositive {n_out}'
        kicker = ' '.join(slide_texts(t.paras) for t in roles['kicker'])
        source = ' '.join(slide_texts(t.paras) for t in roles['source'])
        scene = sum(1 for it in rest if it.kind == 'line') >= 3
        if scene:
            xs = [it.bbox for it in rest if it.kind != 'line' or True]
            x0 = min(b[0] for b in xs); y0 = min(b[1] for b in xs); x1 = max(b[0] + b[2] for b in xs); y1 = max(b[1] + b[3] for b in xs)
            out = []
            skipnames = {'Kicker', 'Source'}
            tree = slide.shapes._spTree
            class _Skip:  # copie de l'arbre sans titre, kicker et source
                pass
            from copy import deepcopy
            tcopy = deepcopy(tree)
            for sp in list(tcopy):
                nm = sp.find('p:nvSpPr/p:cNvPr', NS)
                if etree.QName(sp).localname == 'sp' and (q(sp, './p:nvSpPr/p:nvPr/p:ph[@type="title"]') or (nm is not None and nm.get('name') in skipnames)):
                    tcopy.remove(sp)
            base.walk(tcopy, Tf(ox=-x0 * E, oy=-y0 * E), '#1A2A4A', slide.part, out)
            sc = ''.join(out)
            for a, b in (('#0E2352', '#001B4D'), ('#0070C0', '#8A6000'), ('#34497A', '#1B3A76'), ('#9AA5B8', '#C3CBD9'), ('#DDE3EF', '#DDE2EB'), ('#C9D1E0', '#DDE2EB'),
                         ('#F2B233', '#F0B12B'), ('#FFF4D6', '#FDF4E0'), ('#1A2A4A', '#1A2A4A')):
                sc = sc.replace(a, b).replace(a.lower(), b)
            body = f'<div class="scene" data-w="{x1 - x0:.0f}" data-h="{y1 - y0:.0f}" style="width:{x1 - x0:.0f}px;height:{y1 - y0:.0f}px">{sc}</div>'
        else:
            blocks = make_blocks(rest)
            blocks = [b for b in blocks if not (b.kind in ('line',) or (b.kind == 'sp' and not b.paras and not b.fill and not getattr(b, 'kids', None)))]
            body = '<div class="cnt">' + (node_html(layout(blocks), 0) if blocks else '') + '</div>' if blocks else '<div class="cnt"></div>'
        secs.append(
            f'<section class="slide" data-title="{html.escape(title, quote=True)}"><div class="fit"><div class="stage l">'
            f'<header>{f"<div class=eyebrow>{esc(kicker)}</div>" if kicker else ""}<h2>{esc(title)}</h2><div class="rule"></div></header>'
            f'<div class="body">{body}</div>'
            f'{f"<div class=src>{esc(source)}</div>" if source else ""}'
            f'<div class="ft"><i class="mk"></i><span class="ftx" data-t="{html.escape(foot, quote=True)}"></span><span class="pn" data-t="{n_out}"></span></div></div></div></section>')
    return secs

CSS = '''
:root { --s: 1; --navy-900:#00123A; --navy-800:#001B4D; --navy-700:#1B3A76; --navy-200:#C3CBD9; --navy-100:#DDE2EB; --mist:#F2F4F8; --amber-700:#8A6000; --amber-500:#F0B12B; --amber-50:#FDF4E0; --paper:#FDFDFC; --ink-900:#1A2A4A; --ink-600:#5A6478; --ink-400:#8A93A6; --white:#fff; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--navy-900); font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif; color: var(--ink-900); }
.deck { position: relative; width: 100%; height: 100%; overflow: hidden; }
.slide { position: absolute; left: 0; right: 0; top: 0; bottom: 38px; display: none; align-items: center; justify-content: center; }
.slide.on { display: flex; }
.fit { position: relative; width: calc(960px * var(--s)); height: calc(540px * var(--s)); }
.stage { position: absolute; left: 0; top: 0; width: 960px; height: 540px; transform: scale(var(--s)); transform-origin: 0 0; overflow: hidden; }
.stage.l { background: var(--paper); padding: 30px 48px 66px; display: flex; flex-direction: column; }
.stage.d { background: var(--navy-900); color: #fff; }
.eyebrow { font-size: 12.5px; text-transform: uppercase; letter-spacing: .2em; color: var(--amber-700); margin: 0 0 8px; }
.stage.d .eyebrow { color: var(--amber-500); font-size: 14px; }
h1, h2 { font-weight: 300; letter-spacing: -.018em; line-height: 1.12; color: var(--navy-800); margin: 0; }
.stage.l h2 { font-size: 31px; }
.rule { width: 64px; height: 3px; background: var(--amber-500); margin: 12px 0 0; }
.stage.l header { flex: 0 0 auto; }
.body { flex: 1 1 auto; min-height: 0; position: relative; margin: 16px 0 6px; overflow: hidden; }
.cnt, .scene { position: absolute; left: 0; top: 0; transform-origin: 0 0; font-size: 18px; line-height: 1.42; }
.scene { font-size: inherit; }
.src { position: absolute; left: 48px; right: 48px; bottom: 36px; font-size: 11.5px; color: var(--ink-600); line-height: 1.3; }
.ft { position: absolute; left: 48px; right: 48px; bottom: 11px; height: 18px; display: flex; align-items: center; gap: 10px; font-size: 11.5px; color: var(--ink-400); border-top: 0; }
.ft .mk { height: 14px; width: 16px; display: block; background: var(--mk-l) center / contain no-repeat; } .stage.d .mk { background-image: var(--mk-d); } .ft .pn { margin-left: auto; letter-spacing: .1em; } .ft .ftx::after, .ft .pn::after { content: attr(data-t); }
.stage.d .ft { color: var(--navy-200); }
.stage.d { display: flex; align-items: center; }
.dk-wrap { padding: 0 72px; width: 100%; }
.dk-wrap h1 { color: #fff; font-size: 54px; line-height: 1.06; margin: 0; }
.dk-wrap.sec h2 { color: #fff; font-size: 46px; margin: 0; }
.dk-wrap .num { font-size: 104px; font-weight: 300; color: var(--amber-500); line-height: 1; margin-bottom: 8px; }
.dk-wrap .rule { margin: 20px 0 22px; }
.dk-wrap .sub { color: var(--navy-200); font-size: 22px; font-weight: 300; margin: 0 0 56px; max-width: 760px; }
.dk-wrap .by p { margin: 0; color: #fff; font-size: 16px; line-height: 1.5; } .dk-wrap .by p.b { font-weight: 700; }
.stack { display: flex; flex-direction: column; gap: 14px; }
.row { display: flex; gap: 22px; align-items: stretch; }
.col { min-width: 0; display: flex; flex-direction: column; } .col > .stack, .col > .row, .col > .leaf { flex: 1 1 auto; }
.leaf { display: flex; flex-direction: column; } .leaf > * { flex: 1 1 auto; }
.blk p { margin: 0 0 .45em; } .blk p:last-child { margin-bottom: 0; }
.blk ul, .blk.txt ul { margin: .2em 0 .5em; padding-left: 1.15em; } .blk li { margin: .32em 0; padding-left: .15em; } .blk li::marker { color: var(--amber-500); }
.blk li.l1 { margin-left: 1.1em; font-size: .94em; list-style: circle; } .blk li.l1::marker { color: var(--ink-400); }
.card { background: var(--mist); border-top: 4px solid var(--navy-800); padding: 14px 18px 16px; }
.card p, .card li { color: var(--ink-900); } .card p:first-child { color: var(--navy-800); }
.lt { background: var(--navy-100); padding: 12px 16px; }
.md { background: var(--navy-200); padding: 12px 16px; color: var(--navy-800); }
.dk { background: var(--navy-800); color: #fff; padding: 14px 18px; border-top: 4px solid var(--amber-500); }
.dk2 { background: var(--navy-700); color: #fff; padding: 12px 16px; }
.key { background: var(--amber-50); border-left: 4px solid var(--amber-500); padding: 12px 16px; color: var(--navy-800); }
.dk p, .dk2 p, .dk li { color: #fff; } .dk .xl, .dk .lg { font-weight: 300; }
.txt { padding: 2px 0; }
.xl { display: block; font-size: 2.4em; font-weight: 300; line-height: 1.05; color: var(--navy-800); } .card .xl { color: var(--amber-700); }
.lg { font-size: 1.3em; } .sm { font-size: .82em; color: var(--ink-600); }
.badge { display: inline-flex; width: 1.8em; height: 1.8em; align-items: center; justify-content: center; background: var(--navy-800); color: #fff; font-weight: 700; font-size: .9em; border-radius: 50%; flex: 0 0 auto; }
.inl { display: flex; gap: 12px; align-items: center; } .inl > div { min-width: 0; } .inl p { margin: 0; }
.pic { margin: 0 auto; position: relative; width: calc(100% * var(--ps, 1)); } .pic:not(.crop) img { width: 100%; height: auto; display: block; }
.pic.crop { overflow: hidden; } .pic.crop img { position: absolute; max-width: none; }
.leaf > .pic { flex: 0 0 auto; align-self: flex-start; }
.chartf { margin: 0; } .chart { width: 100%; height: auto; display: block; font-family: inherit; }
table.ot { width: 100%; border-collapse: collapse; font-size: .84em; table-layout: fixed; }
table.ot th { background: var(--navy-800); color: #fff; text-align: left; font-weight: 500; padding: 9px 12px; letter-spacing: .01em; }
table.ot td { padding: 8px 12px; border-bottom: 1px solid var(--navy-100); vertical-align: middle; }
table.ot td.c1 { background: var(--mist); font-weight: 700; color: var(--navy-800); } table.ot td.amb { background: var(--amber-50); }
table.ot p { margin: 0; } table.ot ul { margin: 0; padding-left: 1.1em; }
.bar { position: absolute; left: 0; right: 0; bottom: 0; height: 38px; display: flex; align-items: center; gap: 12px; padding: 0 14px; background: rgba(0,18,58,.96); color: var(--navy-200); font-size: 14px; z-index: 5; }
.bar button { background: none; border: 1px solid var(--ink-600); color: #fff; border-radius: 0; padding: 3px 12px; font-size: 14px; cursor: pointer; min-height: 28px; font-family: inherit; }
.bar .prog { flex: 1; height: 3px; background: var(--navy-700); } .bar .prog i { display: block; height: 100%; width: 0; background: var(--amber-500); }
.scene .sh, .scene .pic, .scene .tb, .scene .chart, .scene .ln { position: absolute; } .scene .sh p, .scene .tb p { margin: 0; } .scene .ln { overflow: visible; }
.scene .pic { overflow: hidden; } .scene .pic img { position: absolute; display: block; max-width: none; } .scene .tb { border-collapse: collapse; table-layout: fixed; }
@page { size: 960px 540px; margin: 0; }
@media print { html, body { height: auto; background: #fff; } :root { --s: 1 !important; } .deck { overflow: visible; height: auto; } .slide { position: relative; display: flex !important; width: 960px; height: 540px; bottom: auto; page-break-after: always; } .bar { display: none; } }
'''

JS = '''
(function () {
  var slides = [].slice.call(document.querySelectorAll(".slide")), i = 0;
  function fitStage() {
    var W = window.innerWidth, H = window.innerHeight - 38;
    document.documentElement.style.setProperty("--s", Math.max(0.2, Math.min(W / 960, H / 540)).toFixed(4));
  }
  function fitContent(sl) {
    var body = sl.querySelector(".body"); if (!body) return;
    var aw = body.clientWidth, ah = body.clientHeight;
    var sc = body.querySelector(".scene");
    if (sc) { var k = Math.min(aw / sc.dataset.w, ah / sc.dataset.h, 1.25); sc.style.transform = "scale(" + k + ")"; sc.style.left = Math.max(0, (aw - sc.dataset.w * k) / 2) + "px"; return; }
    var c = body.querySelector(".cnt"); if (!c) return;
    function put(k, ps) {
      c.style.setProperty("--ps", ps); c.style.width = (aw / k) + "px"; c.style.transform = k < 1 ? "scale(" + k + ")" : "";
      return c.scrollHeight * k;
    }
    if (put(1, 1) <= ah) return;
    var ks = [1, 0.94, 0.88, 0.82];
    for (var a = 0; a < ks.length; a++) {
      if (put(ks[a], 0.3) > ah) continue;
      var pl = 0.3, ph = 1;
      for (var u = 0; u < 7; u++) { var pm = (pl + ph) / 2; if (put(ks[a], pm) <= ah) pl = pm; else ph = pm; }
      if (pl >= 0.4) { put(ks[a], pl); return; }
    }
    var lo = 0.5, hi = 1;
    for (var t = 0; t < 8; t++) { var mid = (lo + hi) / 2; if (put(mid, 1) <= ah) lo = mid; else hi = mid; }
    put(lo, 1);
  }
  function show(n) {
    i = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach(function (s, k) { s.classList.toggle("on", k === i); });
    fitContent(slides[i]);
    document.getElementById("cnt").textContent = (i + 1) + " / " + slides.length;
    document.getElementById("pg").style.width = ((i + 1) / slides.length * 100) + "%";
  }
  document.getElementById("prev").onclick = function () { show(i - 1); };
  document.getElementById("next").onclick = function () { show(i + 1); };
  document.getElementById("fs").onclick = function () { var d = document.documentElement; (d.requestFullscreen || d.webkitRequestFullscreen || function () {}).call(d); };
  document.addEventListener("keydown", function (e) {
    if (["ArrowRight", "PageDown", " "].indexOf(e.key) > -1) { e.preventDefault(); show(i + 1); }
    else if (["ArrowLeft", "PageUp"].indexOf(e.key) > -1) { e.preventDefault(); show(i - 1); }
    else if (e.key === "Home") show(0); else if (e.key === "End") show(slides.length - 1);
    else if (e.key === "f" || e.key === "F") document.getElementById("fs").click();
  });
  var x0 = null;
  document.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
  document.addEventListener("touchend", function (e) { if (x0 === null) return; var dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 60) show(i + (dx < 0 ? 1 : -1)); x0 = null; });
  window.addEventListener("message", function (e) { var m = e.data || {}; if (m.type === "goto") show(m.n - 1); });
  window.addEventListener("resize", fitStage);
  window.addEventListener("load", function () { show(i); });
  fitStage(); show(0);
})();
'''

def build(path, out_path, skip=(), doc_title='Recueil'):
    base.FIXED.clear()
    secs = convert(path, skip, doc_title)
    logo_css = f':root {{ --mk-l: url("{LOGOS["light"]}"); --mk-d: url("{LOGOS["dark"]}"); }}'
    page = ('<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f'<title>{html.escape(doc_title)}</title>\n<style>{logo_css}{CSS}</style>\n</head>\n<body>\n<div class="deck">\n' + '\n'.join(secs) + '\n</div>\n'
            '<div class="bar"><button id="prev" type="button" aria-label="Précédent">←</button><span id="cnt"></span><div class="prog"><i id="pg"></i></div>'
            '<button id="next" type="button" aria-label="Suivant">→</button><button id="fs" type="button">Plein écran</button></div>\n'
            f'<script>{JS}</script>\n</body>\n</html>\n')
    open(out_path, 'w', encoding='utf-8').write(page)
    return len(secs), len(page), sorted(set(base.FIXED))

if __name__ == '__main__':
    skip = {int(x) for x in sys.argv[3].split(',') if x} if len(sys.argv) > 3 else set()
    n, size, fixed = build(sys.argv[1], sys.argv[2], skip, sys.argv[4] if len(sys.argv) > 4 else 'Recueil')
    print(n, 'diapositives', round(size / 1e6, 2), 'Mo', fixed)
