"""Usage : python3 pptx2html.py deck.pptx sortie.html [diapositives_à_exclure, ex. 24] ["Titre"]
Dépendances : python-pptx, lxml. Les notes du présentateur ne sont pas reprises.
Convertit un PPTX simple (formes, texte, tableaux, images, graphiques en colonnes) en recueil HTML autonome pour Onconic Formation.
Chaque diapositive devient <section class="slide" data-title="..."> contenant une scène 960x540 aux positions du PPTX."""
import sys, re, base64, html, json
from lxml import etree
from pptx import Presentation
from pptx.util import Emu

NS = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main', 'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart'}
E = 9525.0  # EMU par pixel (scène 960 px = 9144000 EMU)
FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif'
FIX = [("concommitante", "concomitante"), ("Radiochimothérapie", "Radiochimiothérapie"), ("benefice", "bénéfice"),
       ("dans le diagnostique", "dans le diagnostic"), ("Diagnostique", "Diagnostic"), ("résection complete", "résection complète"),
       ("puis temozolomide adjuvant", "puis témozolomide adjuvant")]
FIXED = []

def fix(t):
    for a, b in FIX:
        if a in t:
            FIXED.append((a, b)); t = t.replace(a, b)
    return t

def q(el, path):
    return etree._Element.xpath(el, path, namespaces=NS)

def px(v):
    return float(v) / E

def css_num(x):
    return f"{x:.2f}".rstrip('0').rstrip('.')

def color_of(el):
    """Couleur srgb du premier solidFill descendant direct."""
    c = q(el, './a:solidFill/a:srgbClr/@val')
    return '#' + c[0] if c else None

# ---------- texte ----------
def run_style(rpr, dflt_color, ref=None):
    ref = ref or {}
    st = []
    if rpr is not None:
        sz = rpr.get('sz') or ref.get('sz')
        if sz: st.append(f"font-size:{css_num(int(sz) / 100 * 1.3333)}px")
        if rpr.get('b') == '1' or (rpr.get('b') is None and ref.get('b') == '1'): st.append('font-weight:700')
        if rpr.get('i') == '1': st.append('font-style:italic')
        if rpr.get('u') and rpr.get('u') != 'none': st.append('text-decoration:underline')
        if rpr.get('spc'): st.append(f"letter-spacing:{css_num(int(rpr.get('spc')) / 100 * 1.3333)}px")
        if rpr.get('cap') == 'all': st.append('text-transform:uppercase')
        if rpr.get('baseline') and int(rpr.get('baseline')) > 0: st.append('vertical-align:super;font-size:70%')
        col = color_of(rpr) or ref.get('color')
        st.append(f"color:{col or dflt_color}")
    else:
        st.append(f"color:{dflt_color}")
    return ';'.join(st)

def ref_of(tb):
    for rpr in q(tb, './/a:r/a:rPr[@sz]'):
        return {'sz': rpr.get('sz'), 'b': rpr.get('b'), 'color': color_of(rpr)}
    return {}

def render_paragraph(p, dflt_color, dflt_sz=1400, ref=None):
    ppr = p.find('a:pPr', NS)
    marL = int(ppr.get('marL', '0')) if ppr is not None else 0
    indent = int(ppr.get('indent', '0')) if ppr is not None else 0
    algn = ppr.get('algn') if ppr is not None else None
    bullet = None
    if ppr is not None:
        bc = ppr.find('a:buChar', NS)
        if bc is not None: bullet = bc.get('char')
    st = []
    if algn: st.append('text-align:' + {'l': 'left', 'ctr': 'center', 'r': 'right', 'just': 'justify'}.get(algn, 'left'))
    if ppr is not None:
        ls = q(ppr, './a:lnSpc/a:spcPct/@val')
        st.append(f"line-height:{int(ls[0]) / 100000 * 1.2:.3f}" if ls else 'line-height:1.2')
        sb = q(ppr, './a:spcBef/a:spcPts/@val'); sa = q(ppr, './a:spcAft/a:spcPts/@val')
        if sb: st.append(f"margin-top:{css_num(int(sb[0]) / 100 * 1.3333)}px")
        if sa: st.append(f"margin-bottom:{css_num(int(sa[0]) / 100 * 1.3333)}px")
    else:
        st.append('line-height:1.2')
    szs = [int(x) for x in q(p, './a:r/a:rPr/@sz')]
    if not szs and (ref or {}).get('sz'): szs = [int(ref['sz'])]
    if szs: st.append(f"font-size:{css_num(max(szs) / 100 * 1.3333)}px")
    runs = []
    last_sz = None
    for ch in p:
        tag = etree.QName(ch).localname
        if tag == 'r':
            rpr = ch.find('a:rPr', NS)
            t = ch.find('a:t', NS)
            txt = fix(t.text or '') if t is not None else ''
            last_sz = rpr.get('sz') if rpr is not None else last_sz
            runs.append(f'<span style="{run_style(rpr, dflt_color, ref)}">{html.escape(txt)}</span>')
        elif tag == 'br':
            runs.append('<br>')
        elif tag == 'fld':
            pass
    if not runs:
        e = p.find('a:endParaRPr', NS)
        sz = e.get('sz') if e is not None and e.get('sz') else str(dflt_sz)
        return f'<p style="{";".join(st)};font-size:{css_num(int(sz) / 100 * 1.3333)}px;min-height:1em">&nbsp;</p>'
    body = ''.join(runs)
    if bullet:
        hang = abs(indent) / E
        first = q(p, './a:r/a:rPr/@sz')
        bsz = f"font-size:{css_num(int(first[0]) / 100 * 1.3333)}px;" if first else ''
        padl = (marL + indent) / E if marL + indent > 0 else 0
        return (f'<p style="{";".join(st)};display:flex;padding-left:{css_num(padl)}px">'
                f'<span style="flex:0 0 {css_num(hang)}px;{bsz}color:{dflt_color}" aria-hidden="true">{html.escape(bullet)}</span><span>{body}</span></p>')
    return f'<p style="{";".join(st)};padding-left:{css_num(marL / E)}px">{body}</p>'

def render_textbody(tb, dflt_color, box_h=None, nowrap_title=False):
    bp = tb.find('a:bodyPr', NS)
    l = int(bp.get('lIns', '91440')) if bp is not None else 91440
    t = int(bp.get('tIns', '45720')) if bp is not None else 45720
    r = int(bp.get('rIns', '91440')) if bp is not None else 91440
    b = int(bp.get('bIns', '45720')) if bp is not None else 45720
    anchor = bp.get('anchor', 't') if bp is not None else 't'
    nowrap = (bp is not None and bp.get('wrap') == 'none') or nowrap_title
    just = {'t': 'flex-start', 'ctr': 'center', 'b': 'flex-end'}.get(anchor, 'flex-start')
    ref = ref_of(tb)
    paras = ''.join(render_paragraph(p, dflt_color, ref=ref) for p in q(tb, './a:p'))
    return (f'<div class="tx" style="display:flex;flex-direction:column;justify-content:{just};width:100%;height:100%;box-sizing:border-box;'
            f'padding:{css_num(t / E)}px {css_num(r / E)}px {css_num(b / E)}px {css_num(l / E)}px;overflow:visible{";white-space:nowrap" if nowrap else ""}">{paras}</div>')

# ---------- géométrie ----------
class Tf:
    def __init__(self, ox=0, oy=0, sx=1.0, sy=1.0, cx=0, cy=0):
        self.ox, self.oy, self.sx, self.sy, self.cx, self.cy = ox, oy, sx, sy, cx, cy
    def box(self, x, y, w, h):
        return ((self.ox + (x - self.cx) * self.sx) / E, (self.oy + (y - self.cy) * self.sy) / E, w * self.sx / E, h * self.sy / E)

def xfrm_of(el):
    x = q(el, './p:spPr/a:xfrm | ./p:xfrm | ./p:grpSpPr/a:xfrm')
    if not x: return None
    x = x[0]
    off = x.find('a:off', NS); ext = x.find('a:ext', NS)
    return int(off.get('x')), int(off.get('y')), int(ext.get('cx')), int(ext.get('cy')), x

def line_style(ln):
    """(épaisseur px, couleur, tiret) ou None."""
    if ln is None: return None
    if ln.find('a:noFill', NS) is not None: return None
    col = color_of(ln)
    if not col: return None
    w = int(ln.get('w', '9525')) / E
    dash = q(ln, './a:prstDash/@val')
    return w, col, (dash[0] if dash else 'solid')

IMG = {}
def img_uri(blob, ext):
    mime = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif'}.get(ext.lower(), 'image/png')
    return f'data:{mime};base64,' + base64.b64encode(blob).decode()

def render_shape(sp, tf, dflt_color, slide_part, out):
    xf = xfrm_of(sp)
    if xf is None: return
    x, y, w, h, xel = xf
    bx, by, bw, bh = tf.box(x, y, w, h)
    tag = etree.QName(sp).localname
    prst = (q(sp, './p:spPr/a:prstGeom/@prst') or ['rect'])[0]
    sppr = sp.find('p:spPr', NS)
    fill = color_of(sppr) if sppr is not None else None
    ln = line_style(sppr.find('a:ln', NS)) if sppr is not None else None
    if prst == 'line' or tag == 'cxnSp':
        flipH = xel.get('flipH') == '1'; flipV = xel.get('flipV') == '1'
        x1, x2 = (bw, 0) if flipH else (0, bw)
        y1, y2 = (bh, 0) if flipV else (0, bh)
        w_ = ln[0] if ln else 1; c_ = ln[1] if ln else '#000'
        dash = {'dash': '6 3', 'sysDash': '3 2', 'dot': '1 2', 'sysDot': '1 2', 'lgDash': '9 3'}.get(ln[2], '') if ln else ''
        pad = 4
        ar = ''
        ln_el = sppr.find('a:ln', NS) if sppr is not None else None
        tail = q(ln_el, './a:tailEnd/@type') if ln_el is not None else []
        mk = ''
        if tail and tail[0] not in ('none',):
            mk = ' marker-end="url(#ah)"'
        out.append(f'<svg class="ln" style="left:{css_num(bx - pad)}px;top:{css_num(by - pad)}px;width:{css_num(bw + 2 * pad)}px;height:{css_num(bh + 2 * pad)}px" '
                   f'viewBox="{-pad} {-pad} {css_num(bw + 2 * pad)} {css_num(bh + 2 * pad)}" aria-hidden="true">'
                   f'<line x1="{css_num(x1)}" y1="{css_num(y1)}" x2="{css_num(x2)}" y2="{css_num(y2)}" stroke="{c_}" stroke-width="{css_num(w_)}"'
                   f'{(" stroke-dasharray=" + chr(34) + dash + chr(34)) if dash else ""}{mk}/></svg>')
        return
    st = [f'left:{css_num(bx)}px', f'top:{css_num(by)}px', f'width:{css_num(bw)}px', f'height:{css_num(bh)}px']
    if fill: st.append(f'background:{fill}')
    if ln:
        st.append(f'border:{css_num(ln[0])}px {"dashed" if ln[2] in ("dash", "sysDash", "lgDash") else "solid"} {ln[1]}')
    if prst == 'ellipse': st.append('border-radius:50%')
    if prst == 'roundRect': st.append('border-radius:8px')
    tb = sp.find('p:txBody', NS)
    inner = ''
    if tb is not None and q(tb, './a:p/a:r | ./a:p/a:endParaRPr'):
        txt_col = dflt_color
        # texte clair sur fond foncé par défaut
        if fill and sum(int(fill[i:i + 2], 16) for i in (1, 3, 5)) < 300: txt_col = '#FFFFFF'
        is_title = bool(q(sp, './p:nvSpPr/p:nvPr/p:ph[@type="title"]'))
        inner = render_textbody(tb, txt_col, nowrap_title=is_title)
    name = sp.find('p:nvSpPr/p:cNvPr', NS).get('name') if sp.find('p:nvSpPr/p:cNvPr', NS) is not None else ''
    out.append(f'<div class="sh" style="{";".join(st)}">{inner}</div>')

def render_pic(pic, tf, slide_part, out):
    xf = xfrm_of(pic)
    x, y, w, h, xel = xf
    bx, by, bw, bh = tf.box(x, y, w, h)
    rid = q(pic, './p:blipFill/a:blip/@r:embed')[0]
    part = slide_part.related_part(rid)
    uri = img_uri(part.blob, part.partname.ext if hasattr(part.partname, 'ext') else 'png')
    sr = pic.find('p:blipFill/a:srcRect', NS)
    l = int(sr.get('l', '0')) / 100000 if sr is not None else 0
    t = int(sr.get('t', '0')) / 100000 if sr is not None else 0
    r = int(sr.get('r', '0')) / 100000 if sr is not None else 0
    b = int(sr.get('b', '0')) / 100000 if sr is not None else 0
    descr = pic.find('p:nvPicPr/p:cNvPr', NS).get('descr') or ''
    iw = bw / max(1 - l - r, 0.01); ih = bh / max(1 - t - b, 0.01)
    out.append(f'<div class="pic" style="left:{css_num(bx)}px;top:{css_num(by)}px;width:{css_num(bw)}px;height:{css_num(bh)}px">'
               f'<img src="{uri}" alt="{html.escape(descr)}" style="left:{css_num(-l * iw)}px;top:{css_num(-t * ih)}px;width:{css_num(iw)}px;height:{css_num(ih)}px"></div>')

def render_table(gf, tf, dflt_color, out):
    x, y, w, h, _ = xfrm_of(gf)
    bx, by, bw, bh = tf.box(x, y, w, h)
    tbl = q(gf, './/a:tbl')[0]
    cols = [int(c.get('w')) for c in q(tbl, './a:tblGrid/a:gridCol')]
    scale = (bw * E) / sum(cols)
    html_ = [f'<table class="tb" style="left:{css_num(bx)}px;top:{css_num(by)}px;width:{css_num(bw)}px"><colgroup>']
    html_ += [f'<col style="width:{css_num(c * scale / E)}px">' for c in cols]
    html_.append('</colgroup>')
    for tr in q(tbl, './a:tr'):
        rh = int(tr.get('h')) / E
        html_.append(f'<tr style="height:{css_num(rh)}px">')
        for tc in q(tr, './a:tc'):
            if tc.get('hMerge') == '1' or tc.get('vMerge') == '1': continue
            attrs = ''
            if tc.get('gridSpan'): attrs += f' colspan="{tc.get("gridSpan")}"'
            if tc.get('rowSpan'): attrs += f' rowspan="{tc.get("rowSpan")}"'
            tcpr = tc.find('a:tcPr', NS)
            st = []
            fill = color_of(tcpr) if tcpr is not None else None
            if fill: st.append(f'background:{fill}')
            anchor = tcpr.get('anchor', 't') if tcpr is not None else 't'
            st.append('vertical-align:' + {'t': 'top', 'ctr': 'middle', 'b': 'bottom'}.get(anchor, 'top'))
            mL = int(tcpr.get('marL', '91440')) if tcpr is not None else 91440
            mR = int(tcpr.get('marR', '91440')) if tcpr is not None else 91440
            mT = int(tcpr.get('marT', '45720')) if tcpr is not None else 45720
            mB = int(tcpr.get('marB', '45720')) if tcpr is not None else 45720
            st.append(f'padding:{css_num(mT / E)}px {css_num(mR / E)}px {css_num(mB / E)}px {css_num(mL / E)}px')
            for side, key in (('left', 'lnL'), ('right', 'lnR'), ('top', 'lnT'), ('bottom', 'lnB')):
                ln = line_style(tcpr.find(f'a:{key}', NS)) if tcpr is not None else None
                st.append(f'border-{side}:{css_num(max(ln[0], 1))}px solid {ln[1]}' if ln and ln[0] > 0 else f'border-{side}:0')
            txt_col = dflt_color
            if fill and sum(int(fill[i:i + 2], 16) for i in (1, 3, 5)) < 300: txt_col = '#FFFFFF'
            tref = ref_of(tc.find('a:txBody', NS))
            paras = ''.join(render_paragraph(p, txt_col, ref=tref) for p in q(tc, './a:txBody/a:p'))
            html_.append(f'<td{attrs} style="{";".join(st)}">{paras}</td>')
        html_.append('</tr>')
    html_.append('</table>')
    out.append(''.join(html_))

def render_chart(gf, tf, slide_part, out):
    x, y, w, h, _ = xfrm_of(gf)
    bx, by, bw, bh = tf.box(x, y, w, h)
    rid = q(gf, './/c:chart/@r:id')[0]
    root = slide_part.related_part(rid)._element
    title = ''.join(q(root, './/c:chart/c:title//a:t/text()'))
    cats = q(root, './/c:ser[1]/c:cat//c:pt/c:v/text()')
    sers = []
    for ser in q(root, './/c:ser'):
        name = ''.join(q(ser, './c:tx//c:v/text()'))
        vals = [float(v) for v in q(ser, './c:val//c:pt/c:v/text()')]
        col = (q(ser, './c:spPr/a:solidFill/a:srgbClr/@val') or ['9AA5B8'])[0]
        pts = {int(q(d, './c:idx/@val')[0]): q(d, './c:spPr/a:solidFill/a:srgbClr/@val')[0]
               for d in q(ser, './c:dPt[c:spPr]')}
        sers.append((name, vals, col, pts))
    legend = bool(q(root, './/c:legend'))
    W, H = bw, bh
    top = 34 if title else 10
    bottom = 56 if legend else 34
    plot_h = H - top - bottom
    vmax = max(v for _, vals, _, _ in sers for v in vals) * 1.12
    n = len(cats); ns = len(sers)
    gw = W / n
    bar_w = gw * 0.62 / ns
    svg = [f'<svg class="chart" style="left:{css_num(bx)}px;top:{css_num(by)}px;width:{css_num(W)}px;height:{css_num(H)}px" viewBox="0 0 {css_num(W)} {css_num(H)}" role="img" aria-label="{html.escape(title)}">']
    if title: svg.append(f'<text x="{css_num(W / 2)}" y="20" text-anchor="middle" font-size="14.7" fill="#0E2352">{html.escape(title)}</text>')
    base = top + plot_h
    svg.append(f'<line x1="0" y1="{css_num(base)}" x2="{css_num(W)}" y2="{css_num(base)}" stroke="#BFC7D6" stroke-width="1"/>')
    for ci, cat in enumerate(cats):
        gx = ci * gw + gw * 0.19
        for si, (name, vals, col, pts) in enumerate(sers):
            v = vals[ci]; bh_ = v / vmax * plot_h
            c = '#' + pts.get(ci, col)
            bxp = gx + si * bar_w
            svg.append(f'<rect x="{css_num(bxp)}" y="{css_num(base - bh_)}" width="{css_num(bar_w)}" height="{css_num(bh_)}" fill="{c}"/>')
            lab = f'{v:.1f}'.replace('.', ',')
            svg.append(f'<text x="{css_num(bxp + bar_w / 2)}" y="{css_num(base - bh_ - 6)}" text-anchor="middle" font-size="14.7" fill="#0E2352">{lab}</text>')
        svg.append(f'<text x="{css_num(ci * gw + gw / 2)}" y="{css_num(base + 20)}" text-anchor="middle" font-size="12" fill="#1A2A4A">{html.escape(cat)}</text>')
    if legend:
        lx = W / 2 - 70 * ns
        for si, (name, vals, col, pts) in enumerate(sers):
            svg.append(f'<rect x="{css_num(lx + si * 140)}" y="{css_num(H - 20)}" width="9" height="9" fill="#{col}"/>'
                       f'<text x="{css_num(lx + si * 140 + 14)}" y="{css_num(H - 11.5)}" font-size="12" fill="#5A6478">{html.escape(name)}</text>')
    svg.append('</svg>')
    out.append(''.join(svg))

def walk(tree, tf, dflt_color, slide_part, out):
    for ch in tree:
        tag = etree.QName(ch).localname
        if tag == 'sp' or tag == 'cxnSp':
            render_shape(ch, tf, dflt_color, slide_part, out)
        elif tag == 'pic':
            render_pic(ch, tf, slide_part, out)
        elif tag == 'graphicFrame':
            if q(ch, './/a:tbl'): render_table(ch, tf, dflt_color, out)
            elif q(ch, './/c:chart'): render_chart(ch, tf, slide_part, out)
        elif tag == 'grpSp':
            xf = ch.find('p:grpSpPr/a:xfrm', NS)
            off = xf.find('a:off', NS); ext = xf.find('a:ext', NS); co = xf.find('a:chOff', NS); ce = xf.find('a:chExt', NS)
            ox, oy, ex, ey = int(off.get('x')), int(off.get('y')), int(ext.get('cx')), int(ext.get('cy'))
            cx, cy, cex, cey = int(co.get('x')), int(co.get('y')), int(ce.get('cx')), int(ce.get('cy'))
            sx = ex / cex if cex else 1; sy = ey / cey if cey else 1
            # composition avec la transformation parente
            ntf = Tf(tf.ox + (ox - tf.cx) * tf.sx, tf.oy + (oy - tf.cy) * tf.sy, sx * tf.sx, sy * tf.sy, cx, cy)
            walk(ch, ntf, dflt_color, slide_part, out)

def slide_title(slide):
    for sh in slide.shapes:
        ph = q(sh._element, './/p:ph/@type')
        if ph and ph[0] == 'title' and sh.has_text_frame and sh.text_frame.text.strip():
            return fix(sh.text_frame.text.strip().replace('\n', ' '))
    return ''

def convert(path, skip=(), title='', meta=''):
    prs = Presentation(path)
    sections = []
    n_out = 0
    for i, slide in enumerate(prs.slides, 1):
        if i in skip: continue
        lay = slide.slide_layout
        bg = (q(lay._element, './/p:bg//a:srgbClr/@val') or ['FFFFFF'])[0]
        dark = sum(int(bg[k:k + 2], 16) for k in (0, 2, 4)) < 300
        dflt = '#FFFFFF' if dark else '#1A2A4A'
        out = []
        walk(slide.shapes._spTree, Tf(), dflt, slide.part, out)
        foot = ''
        pn = ''
        for sh in lay.shapes:
            t = sh.text_frame.text.strip() if sh.has_text_frame else ''
            if t and 'Formation' in t: foot = t
        n_out += 1
        t = slide_title(slide) or f'Diapositive {n_out}'
        kicker = ''
        cls = 'dark' if dark else 'light'
        sections.append(
            f'<section class="slide" data-title="{html.escape(t, quote=True)}"><div class="fit"><div class="stage {cls}" data-foot="{html.escape(foot, quote=True)}"'
            f' data-n="{"" if dark else n_out}">{"".join(out)}</div></div></section>')
    return sections

CSS = '''
:root { --s: 1; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #00123A; font-family: __FONT__; }
.deck { position: relative; width: 100%; height: 100%; overflow: hidden; }
.slide { position: absolute; left: 0; right: 0; top: 0; bottom: 38px; display: none; align-items: center; justify-content: center; }
.slide.on { display: flex; }
.fit { position: relative; width: calc(960px * var(--s)); height: calc(540px * var(--s)); }
.stage { position: absolute; left: 0; top: 0; width: 960px; height: 540px; transform: scale(var(--s)); transform-origin: 0 0; overflow: hidden; font-family: __FONT__; }
.stage.light { background: #fff; } .stage.dark { background: #0E2352; }
.stage::before { content: attr(data-foot); position: absolute; left: 48px; top: 507px; font-size: 12px; color: #5A6478; }
.stage.dark::before { color: #9AA5B8; }
.stage::after { content: attr(data-n); position: absolute; right: 48px; top: 507px; width: 48px; text-align: right; font-size: 12px; color: #5A6478; }
.sh, .pic, .tb, .chart, .ln { position: absolute; }
.sh { overflow: visible; } .sh p, .tb p { margin: 0; }
.pic { overflow: hidden; } .pic img { position: absolute; display: block; max-width: none; }
.tb { border-collapse: collapse; table-layout: fixed; }
.ln, .chart { overflow: visible; }
.chart text { font-family: __FONT__; }
.bar { position: absolute; left: 0; right: 0; bottom: 0; height: 38px; display: flex; align-items: center; gap: 12px; padding: 0 14px; background: rgba(0,18,58,.96); color: #C3CBD9; font-size: 14px; z-index: 5; }
.bar button { background: none; border: 1px solid #5A6478; color: #fff; border-radius: 4px; padding: 3px 12px; font-size: 14px; cursor: pointer; min-height: 28px; }
.bar .prog { flex: 1; height: 3px; background: #1B3A76; } .bar .prog i { display: block; height: 100%; width: 0; background: #F0B12B; }
@page { size: 960px 540px; margin: 0; }
@media print { html, body { height: auto; background: #fff; } :root { --s: 1 !important; } .deck { overflow: visible; height: auto; } .slide { position: relative; display: flex !important; width: 960px; height: 540px; bottom: auto; page-break-after: always; } .bar { display: none; } }
'''.replace('__FONT__', FONT)

JS = '''
(function () {
  var slides = [].slice.call(document.querySelectorAll(".slide")), i = 0;
  function fit() {
    var W = window.innerWidth, H = window.innerHeight - 38;
    document.documentElement.style.setProperty("--s", Math.max(0.2, Math.min(W / 960, H / 540)).toFixed(4));
  }
  function show(n) {
    i = Math.max(0, Math.min(slides.length - 1, n));
    slides.forEach(function (s, k) { s.classList.toggle("on", k === i); });
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
  window.addEventListener("resize", fit);
  fit(); show(0);
})();
'''

def build(path, out_path, skip=(), doc_title='Recueil'):
    FIXED.clear()
    secs = convert(path, skip)
    marker = '<defs></defs>'
    page = ('<!doctype html>\n<html lang="fr">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            f'<title>{html.escape(doc_title)}</title>\n<style>{CSS}</style>\n</head>\n<body>\n'
            '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#0E2352"/></marker></defs></svg>\n'
            '<div class="deck">\n' + '\n'.join(secs) + '\n</div>\n'
            '<div class="bar"><button id="prev" type="button" aria-label="Précédent">←</button><span id="cnt"></span><div class="prog"><i id="pg"></i></div><button id="next" type="button" aria-label="Suivant">→</button><button id="fs" type="button">Plein écran</button></div>\n'
            f'<script>{JS}</script>\n</body>\n</html>\n')
    open(out_path, 'w', encoding='utf-8').write(page)
    return len(secs), len(page), sorted(set(FIXED))

if __name__ == '__main__':
    n, size, fixed = build(sys.argv[1], sys.argv[2], skip={int(x) for x in sys.argv[3].split(',') if x} if len(sys.argv) > 3 else (), doc_title=sys.argv[4] if len(sys.argv) > 4 else 'Recueil')
    print(n, 'diapositives', round(size / 1e6, 2), 'Mo', fixed)
