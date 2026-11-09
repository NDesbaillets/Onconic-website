"""Tests de kmextract sur une figure synthétique (aucun PDF d'éditeur dans le dépôt).

Lancer :  python3 -m unittest tools/km/test_kmextract.py   (depuis la racine du dépôt)
Dépendances : pdfplumber, numpy, Pillow ; reportlab pour le test vectoriel (sinon ignoré).
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kmextract as K  # noqa: E402

# courbes de vérité (temps en mois, survie 0-1) : valeur à partir de t
A = [(0, 1.0), (3, 0.9), (6, 0.7), (9, 0.45), (12, 0.3), (15, 0.2)]  # médiane 9
B = [(0, 1.0), (2, 0.8), (4, 0.6), (6, 0.4), (9, 0.3)]               # médiane 6
RED, BLUE = (0.8, 0.1, 0.1), (0.1, 0.3, 0.8)


def step_points(curve, tmax):
    pts = []
    for i, (t, s) in enumerate(curve):
        if i:
            pts.append((t, curve[i - 1][1]))
        pts.append((t, s))
    pts.append((tmax, curve[-1][1]))
    return pts


def make_pdf(path):
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(path, pagesize=(595, 842))
    x0, x1, y0, y1 = 100, 400, 300, 700            # axes : 0-24 mois, 0-100 %

    def X(t): return x0 + (x1 - x0) * t / 24
    def Y(s): return y0 + (y1 - y0) * s
    c.setLineWidth(0.5)
    c.line(x0, y0, x0, y1)
    c.line(x0, y0, x1, y0)
    c.setFont('Helvetica', 8)
    for t in range(0, 25, 3):
        c.line(X(t), y0, X(t), y0 - 4)
        c.drawCentredString(X(t), y0 - 14, str(t))
    for k in range(6):
        s = k / 5
        c.line(x0, Y(s), x0 - 4, Y(s))
        c.drawRightString(x0 - 7, Y(s) - 3, '%.1f' % s)
    for curve, tmax, rgb in ((A, 22, RED), (B, 20, BLUE)):
        c.setStrokeColorRGB(*rgb)
        c.setLineWidth(1)
        p = c.beginPath()
        pts = step_points(curve, tmax)
        p.moveTo(X(pts[0][0]), Y(pts[0][1]))
        for t, s in pts[1:]:
            p.lineTo(X(t), Y(s))
        c.drawPath(p, stroke=1, fill=0)
        c.line(X(tmax - 1), Y(curve[-1][1]) - 2, X(tmax - 1), Y(curve[-1][1]) + 2)  # marque de censure
    c.save()


class VectorFigure(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import reportlab  # noqa: F401
        except ImportError:
            raise unittest.SkipTest('reportlab absent')
        cls.tmp = tempfile.mkdtemp()
        cls.pdf = os.path.join(cls.tmp, 'fig.pdf')
        make_pdf(cls.pdf)

    def test_probe_trouve_deux_courbes(self):
        rows = K.probe(self.pdf)
        self.assertEqual(len(rows), 2)
        med = sorted(r['median'] for r in rows)
        self.assertAlmostEqual(med[0], 6.0, delta=0.25)
        self.assertAlmostEqual(med[1], 9.0, delta=0.25)

    def test_item_valeurs_et_marques(self):
        it = K.item_from_pdf(self.pdf, 1, 0, [RED, BLUE], ['A', 'B'], 'axes', 'OS', 'HR 0,50 (0,30–0,80)',
                             'test', 'figure synthétique', xmax=24, step=0.5, with_atrisk=False)
        a, b = it['arms']
        self.assertAlmostEqual(a['median'], 9.0, delta=0.25)
        self.assertAlmostEqual(b['median'], 6.0, delta=0.25)
        self.assertAlmostEqual(dict(map(tuple, a['marks']))[12.0], 30.0, delta=1.5)
        self.assertAlmostEqual(dict(map(tuple, b['marks']))[12.0], 30.0, delta=1.5)
        self.assertEqual(a['points'][0], [0.0, 100.0])
        self.assertTrue(all(q[1] <= p[1] for p, q in zip(a['points'], a['points'][1:])))  # non croissante
        self.assertTrue(it['digitized'])

    def test_cli_item_et_probe(self):
        import contextlib
        import io
        import json
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(K.main(['item', self.pdf, '--page', '1', '--colors', '0.8,0.1,0.1;0.1,0.3,0.8',
                                     '--names', 'A;B', '--xmax', '24', '--no-atrisk']), 0)
        self.assertEqual(len(json.loads(buf.getvalue())['arms']), 2)


class RasterFigure(unittest.TestCase):
    def test_courbe_raster(self):
        import numpy as np
        from PIL import Image
        W, H = 800, 500
        img = np.full((H, W, 3), 255, np.uint8)
        xl, xr, yt, yb = 100, 700, 50, 450           # axes : 0-24 mois, 0-100 %
        img[yt:yb + 1, xl - 1:xl + 1] = 0
        img[yb:yb + 2, xl:xr + 1] = 0
        for curve, rgb in ((A, (200, 30, 30)), (B, (30, 60, 200))):
            pts = step_points(curve, 22)
            for (t0, s0), (t1, s1) in zip(pts, pts[1:]):
                xa, xb = int(xl + (xr - xl) * t0 / 24), int(xl + (xr - xl) * t1 / 24)
                ya, yb2 = int(yb - (yb - yt) * s0), int(yb - (yb - yt) * s1)
                img[min(ya, yb2) - 1:max(ya, yb2) + 2, xa:xb + 1] = rgb if xa != xb else img[min(ya, yb2) - 1:max(ya, yb2) + 2, xa:xb + 1]
                img[min(ya, yb2):max(ya, yb2) + 1, xa - 1:xa + 2] = rgb
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'fig.png')
            Image.fromarray(img).save(path)
            it = K.item_raster(path, (50, 20, 760, 480), 24, [(200, 30, 30), (30, 60, 200)], ['A', 'B'])
        a, b = it['arms']
        self.assertAlmostEqual(a['median'], 9.0, delta=0.5)
        self.assertAlmostEqual(b['median'], 6.0, delta=0.5)


if __name__ == '__main__':
    unittest.main()
