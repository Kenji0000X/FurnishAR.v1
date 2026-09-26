#!/usr/bin/env python3
"""
Builds docs/FURNISHAR-DFD-V2.drawio: one draw.io file, one page per
function below (the list is main()'s `pages`): Level 0, Level 1, the Level 2
and Level 3 DFDs, the step-by-step flows (protected 3D access, checkout,
device check) and the use case diagram. docs/FURNISHAR-DFD-V2.md lists them.

Every node and connector is taken from docs/FURNISHAR-DFD-V2.md; nothing here
names a route or process the repository does not have. Re-run after editing
the markdown so the two stay in sync:

    python3 scripts/build-dfd-drawio.py            # writes the .drawio
    python3 scripts/build-dfd-drawio.py --preview DIR   # also writes an SVG per page

Positions and waypoints are explicit so connectors meet the node they name and
never run through an unrelated one (rules 1-3 in the DFD's reliability list).
"""
import re
import sys
from pathlib import Path
from html import unescape
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
DRAWIO = ROOT / 'docs' / 'FURNISHAR-DFD-V2.drawio'

# Styles, matching the Level 1 page already in the file.
EXTERNAL = 'rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1;'
PROCESS = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;'
SYSTEM = 'ellipse;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;fontStyle=1;fontSize=16;'
STORE = 'shape=partialRectangle;whiteSpace=wrap;html=1;left=0;right=0;fillColor=#fff2cc;strokeColor=#d6b656;'
DECISION = 'rhombus;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;'
ALERT = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;'
OK = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;'
PAGE_ROUTE = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#6c8ebf;dashed=1;'
ACTOR = 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;fontStyle=1;'
USECASE = 'ellipse;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#333333;'
USECASE_INC = 'ellipse;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#333333;fontStyle=2;'
BOUNDARY = 'rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#333333;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fontSize=14;'
GROUP = 'text;html=1;align=left;verticalAlign=middle;fontStyle=1;fontColor=#666666;fontSize=12;'
NOTE = 'shape=note;whiteSpace=wrap;html=1;size=14;fillColor=#fffbe6;strokeColor=#d6b656;align=left;spacingLeft=8;fontSize=11;'

# Gane–Sarson notation for the levelled DFDs.
DFD_PROCESS = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;arcSize=18;'
DFD_REF = 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#999999;dashed=1;fontColor=#555555;arcSize=18;'
DFD_STORE = 'shape=partialRectangle;whiteSpace=wrap;html=1;right=0;fillColor=#fff2cc;strokeColor=#d6b656;align=left;spacingLeft=8;'
DFD_EXTERNAL = 'rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1;'
TITLE = 'text;html=1;align=left;verticalAlign=middle;fontStyle=1;fontSize=16;'
DIALOG = 'startArrow=block;startFill=1;'   # a request and its reply on one line (Gane–Sarson)
JUMP = 'jumpStyle=arc;jumpSize=8;'

EDGE_ORTHO = 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;fontSize=11;labelBackgroundColor=#ffffff;'
EDGE_STRAIGHT = 'rounded=0;html=1;fontSize=11;labelBackgroundColor=#ffffff;endArrow=block;endFill=1;'
ASSOC = 'rounded=0;html=1;endArrow=none;'
INCLUDE = 'rounded=0;html=1;dashed=1;endArrow=open;endFill=0;fontSize=10;labelBackgroundColor=#ffffff;'
GENERAL = 'rounded=0;html=1;endArrow=block;endFill=0;endSize=14;'


class Page:
    def __init__(self, pid, name, width, height):
        self.pid, self.name, self.width, self.height = pid, name, width, height
        self.nodes, self.edges = {}, []

    def node(self, nid, label, style, x, y, w, h):
        assert nid not in self.nodes, nid
        self.nodes[nid] = dict(label=label, style=style, x=x, y=y, w=w, h=h)
        return nid

    def edge(self, src, tgt, label='', style=EDGE_ORTHO, exit=None, entry=None, points=(), label_pos=None):
        assert src in self.nodes and tgt in self.nodes, (src, tgt)
        self.edges.append(dict(src=src, tgt=tgt, label=label, style=style, exit=exit, entry=entry,
                               points=list(points), label_pos=label_pos))

    def align(self):
        """Straighten flows whose two ends face each other.

        A flow with no waypoints that leaves one node sideways and enters the
        next sideways (or top-to-bottom) is snapped so the entry sits exactly
        level with the exit, when that point is on the target's edge. Without
        this a few pixels of rounding draw a small hook at the arrowhead.
        """
        for e in self.edges:
            if e['points'] or not e['exit'] or not e['entry']:
                continue
            a, b = self.nodes[e['src']], self.nodes[e['tgt']]
            (ex, ey), (nx, ny) = e['exit'], e['entry']
            if ex in (0, 1) and nx in (0, 1):
                y = a['y'] + ey * a['h']
                if b['y'] <= y <= b['y'] + b['h']:
                    e['entry'] = (nx, round((y - b['y']) / b['h'], 4))
            elif ey in (0, 1) and ny in (0, 1):
                x = a['x'] + ex * a['w']
                if b['x'] <= x <= b['x'] + b['w']:
                    e['entry'] = (round((x - b['x']) / b['w'], 4), ny)

    # ---------------------------------------------------------------- draw.io
    def xml(self):
        self.align()
        out = [f'<diagram id="{self.pid}" name="{escape(self.name)}">',
               f'<mxGraphModel dx="1600" dy="1000" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" '
               f'arrows="1" fold="1" page="1" pageScale="1" pageWidth="{self.width}" pageHeight="{self.height}">',
               '<root>', '<mxCell id="0"/><mxCell id="1" parent="0"/>']
        for nid, n in self.nodes.items():
            out.append(f'<mxCell id="{self.pid}-{nid}" value="{escape(n["label"], {chr(34): "&quot;"})}" '
                       f'style="{n["style"]}" vertex="1" parent="1">'
                       f'<mxGeometry x="{n["x"]}" y="{n["y"]}" width="{n["w"]}" height="{n["h"]}" as="geometry"/></mxCell>')
        for i, e in enumerate(self.edges, 1):
            style = e['style']
            if e['exit']:
                style += f'exitX={e["exit"][0]};exitY={e["exit"][1]};exitDx=0;exitDy=0;'
            if e['entry']:
                style += f'entryX={e["entry"][0]};entryY={e["entry"][1]};entryDx=0;entryDy=0;'
            geo = '<mxGeometry relative="1" as="geometry">'
            if e['label_pos'] is not None:
                geo = f'<mxGeometry x="{e["label_pos"]}" relative="1" as="geometry">'
            if e['points']:
                geo += '<Array as="points">' + ''.join(f'<mxPoint x="{x}" y="{y}"/>' for x, y in e['points']) + '</Array>'
            geo += '</mxGeometry>'
            out.append(f'<mxCell id="{self.pid}-e{i}" value="{escape(e["label"], {chr(34): "&quot;"})}" '
                       f'style="{style}" edge="1" parent="1" source="{self.pid}-{e["src"]}" '
                       f'target="{self.pid}-{e["tgt"]}">{geo}</mxCell>')
        out += ['</root>', '</mxGraphModel>', '</diagram>']
        return '\n'.join(out)

    # ---------------------------------------------------------- SVG preview
    def _anchor(self, nid, rel, toward):
        n = self.nodes[nid]
        if rel:
            return n['x'] + rel[0] * n['w'], n['y'] + rel[1] * n['h']
        cx, cy = n['x'] + n['w'] / 2, n['y'] + n['h'] / 2
        tx, ty = toward
        dx, dy = tx - cx, ty - cy
        if dx == 0 and dy == 0:
            return cx, cy
        sx = (n['w'] / 2) / abs(dx) if dx else float('inf')
        sy = (n['h'] / 2) / abs(dy) if dy else float('inf')
        s = min(sx, sy)
        return cx + dx * s, cy + dy * s

    def svg(self):
        self.align()
        def text(x, y, label, size=12, weight='normal', anchor='middle', italic=False):
            lines = re.sub(r'<br\s*/?>', '\n', label).split('\n')
            lines = [unescape(re.sub('<[^>]+>', '', l)) for l in lines]
            y0 = y - (len(lines) - 1) * size * 0.6
            style = 'font-style:italic;' if italic else ''
            return ''.join(f'<text x="{x}" y="{y0 + i * size * 1.2 + size * 0.35}" font-size="{size}" '
                           f'font-weight="{weight}" text-anchor="{anchor}"' + (f' style="{style}"' if style else '') + f'>{escape(l)}</text>' for i, l in enumerate(lines))

        def fill(style, key, default):
            m = re.search(key + r'=([^;]+)', style)
            return m.group(1) if m else default

        parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" '
                 f'viewBox="0 0 {self.width} {self.height}" font-family="Helvetica,Arial,sans-serif">'
                 '<rect width="100%" height="100%" fill="#fff"/>',
                 '<defs><marker id="a" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">'
                 '<path d="M0,0 L10,4 L0,8 z" fill="#333"/></marker>'
                 '<marker id="s" markerWidth="10" markerHeight="8" refX="1" refY="4" orient="auto">'
                 '<path d="M10,0 L0,4 L10,8 z" fill="#333"/></marker>'
                 '<marker id="o" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">'
                 '<path d="M0,0 L10,4 L0,8" fill="none" stroke="#333"/></marker>'
                 '<marker id="t" markerWidth="16" markerHeight="14" refX="15" refY="7" orient="auto">'
                 '<path d="M0,0 L15,7 L0,14 z" fill="#fff" stroke="#333"/></marker></defs>']
        for n in self.nodes.values():
            s, x, y, w, h = n['style'], n['x'], n['y'], n['w'], n['h']
            f, st = fill(s, 'fillColor', '#fff'), fill(s, 'strokeColor', '#333')
            f = 'none' if f == 'none' else f
            dash = ' stroke-dasharray="6 4"' if 'dashed=1' in s else ''
            label_y = y + h / 2
            if s.startswith('ellipse'):
                parts.append(f'<ellipse cx="{x + w/2}" cy="{y + h/2}" rx="{w/2}" ry="{h/2}" fill="{f}" stroke="{st}"/>')
            elif s.startswith('rhombus'):
                parts.append(f'<polygon points="{x + w/2},{y} {x + w},{y + h/2} {x + w/2},{y + h} {x},{y + h/2}" fill="{f}" stroke="{st}"/>')
            elif 'umlActor' in s:
                cx = x + w / 2
                parts.append(f'<circle cx="{cx}" cy="{y + h*0.12}" r="{h*0.12}" fill="#fff" stroke="#333"/>'
                             f'<path d="M{cx},{y + h*0.24} V{y + h*0.62} M{x + w*0.2},{y + h*0.36} H{x + w*0.8} '
                             f'M{cx},{y + h*0.62} L{x + w*0.25},{y + h} M{cx},{y + h*0.62} L{x + w*0.75},{y + h}" stroke="#333" fill="none"/>')
                label_y = y + h + 14
            elif 'partialRectangle' in s:
                d = f'M{x},{y} H{x + w} M{x},{y + h} H{x + w}'
                if 'left=0' not in s:
                    d += f' M{x},{y} V{y + h}'
                if 'right=0' not in s:
                    d += f' M{x + w},{y} V{y + h}'
                parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{f}" stroke="none"/>'
                             f'<path d="{d}" stroke="{st}"/>')
            elif 'shape=note' in s:
                parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{f}" stroke="{st}"/>')
            elif s.startswith('text'):
                pass
            else:
                r = 10 if 'rounded=1' in s else 0
                parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{f}" stroke="{st}"{dash}/>')
            if s.startswith('shape=note'):
                # Wrap each paragraph to the note's width, as draw.io does.
                import textwrap
                width = max(int((w - 20) / 5.6), 20)
                paras = re.sub(r'<br\s*/?>', '\n', n['label']).split('\n')
                wrapped = '<br>'.join(line for para in paras for line in (textwrap.wrap(para, width) or ['']))
                lines = wrapped.count('<br>')
                parts.append(text(x + 10, y + 18 + lines * 11 * 0.6, wrapped, 11, 'normal', 'start'))
            elif s.startswith('rounded=0;whiteSpace=wrap;html=1;fillColor=none') or 'verticalAlign=top;align=left' in s:
                parts.append(text(x + 10, y + 18, n['label'], 13 if 'fontSize=14' in s else 11, 'bold' if 'fontStyle=1' in s else 'normal', 'start'))
            elif s.startswith('text'):
                parts.append(text(x, y + h / 2, n['label'], 12, 'bold', 'start'))
            else:
                parts.append(text(x + w / 2, label_y, n['label'], 15 if 'fontSize=16' in s else 12,
                                  'bold' if 'fontStyle=1' in s else 'normal', italic='fontStyle=2' in s))
        for e in self.edges:
            a, b = self.nodes[e['src']], self.nodes[e['tgt']]
            first_toward = e['points'][0] if e['points'] else (b['x'] + b['w'] / 2, b['y'] + b['h'] / 2)
            last_from = e['points'][-1] if e['points'] else (a['x'] + a['w'] / 2, a['y'] + a['h'] / 2)
            p0 = self._anchor(e['src'], e['exit'], first_toward)
            p1 = self._anchor(e['tgt'], e['entry'], last_from)
            pts = [p0] + e['points'] + [p1]
            if 'orthogonal' in e['style']:
                ortho = [pts[0]]
                last = len(pts) - 2
                for i, ((x1, y1), (x2, y2)) in enumerate(zip(pts, pts[1:])):
                    if abs(x1 - x2) > 0.5 and abs(y1 - y2) > 0.5:
                        if i == 0 and e['exit'] is not None:
                            sideways = e['exit'][0] in (0, 1)
                        elif i == last and e['entry'] is not None:
                            sideways = e['entry'][0] not in (0, 1)
                        else:
                            sideways = True
                        ortho.append((x2, y1) if sideways else (x1, y2))
                    ortho.append((x2, y2))
                pts = ortho
            pts = [q for i, q in enumerate(pts) if i == 0 or abs(q[0] - pts[i - 1][0]) + abs(q[1] - pts[i - 1][1]) > 0.5]
            d = 'M' + ' L'.join(f'{x:.1f},{y:.1f}' for x, y in pts)
            s = e['style']
            marker = '' if 'endArrow=none' in s else ('url(#t)' if 'endFill=0;endSize' in s else
                                                      ('url(#o)' if 'endArrow=open' in s else 'url(#a)'))
            dash = ' stroke-dasharray="6 4"' if 'dashed=1' in s else ''
            start = ' marker-start="url(#s)"' if 'startArrow=block' in s else ''
            parts.append(f'<path d="{d}" fill="none" stroke="#333"{dash}{start}' + (f' marker-end="{marker}"' if marker else '') + '/>')
            if e['label']:
                # Label at the middle of the longest segment, like draw.io's default.
                segs = list(zip(pts, pts[1:]))
                if e['label_pos'] is None:
                    (x1, y1), (x2, y2) = max(segs, key=lambda s: abs(s[0][0] - s[1][0]) + abs(s[0][1] - s[1][1]))
                    lx, ly = (x1 + x2) / 2, (y1 + y2) / 2
                else:
                    # draw.io: x runs from -1 (source) to 1 (target) along the path.
                    lengths = [((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** .5 for a, b in segs]
                    goal = sum(lengths) * (e['label_pos'] + 1) / 2
                    for (a, b), length in zip(segs, lengths):
                        if goal <= length or (a, b) == segs[-1]:
                            t = goal / length if length else 0
                            lx, ly = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                            break
                        goal -= length
                w = max(len(l) for l in e['label'].split('<br>')) * 6 + 8
                nl = e['label'].count('<br>') + 1
                parts.append(f'<rect x="{lx - w/2}" y="{ly - 8*nl}" width="{w}" height="{16*nl}" fill="#fff"/>')
                parts.append(text(lx, ly, e['label'], 10, italic='dashed=1' in s))
        parts.append('</svg>')
        return ''.join(parts)


# =========================================================================
# 1. Level 0 — Context DFD
# =========================================================================
def level0():
    p = Page('level-0', 'Level 0 — Context DFD', 1400, 940)
    p.node('title', 'FurnishAR — Level 0 Context Diagram', GROUP + 'fontSize=16;', 40, 10, 600, 30)
    p.node('SYS', '0<br>FurnishAR System', SYSTEM, 580, 330, 240, 240)
    p.node('B', 'Buyer / Guest', EXTERNAL, 40, 415, 180, 70)
    p.node('E', 'Email Service<br>(Gmail / Resend)', EXTERNAL, 140, 110, 200, 70)
    p.node('PP', 'PayPal<br>(shop\'s seller account)', EXTERNAL, 1100, 110, 200, 70)
    p.node('G', 'Google<br>(identity, via Supabase Auth)', EXTERNAL, 590, 110, 220, 64)
    p.node('X', 'Supabase<br>(Auth / Postgres / Storage)', EXTERNAL, 1140, 415, 220, 70)
    p.node('O', 'Store Owner', EXTERNAL, 140, 740, 200, 70)
    p.node('A', 'Platform Admin', EXTERNAL, 1100, 740, 200, 70)
    p.node('MY', 'Maya<br>(FurnishAR\'s merchant account)', EXTERNAL, 1150, 575, 210, 70)

    S = EDGE_STRAIGHT
    p.edge('B', 'SYS', 'browse, sign in, planner,<br>3D requests, orders', S, exit=(1, 0.3), entry=(0.02, 0.38))
    p.edge('SYS', 'B', 'catalogue, results, alerts,<br>3D access decisions', S, exit=(0.02, 0.62), entry=(1, 0.7))

    p.edge('O', 'SYS', 'application, inventory,<br>model upload, quotes', S, exit=(0.8, 0), entry=(0.12, 0.82),
           label_pos=-0.45)
    p.edge('SYS', 'O', 'application status,<br>incoming orders, fees owed', S, exit=(0.3, 0.96), entry=(1, 0.3),
           label_pos=-0.2)

    p.edge('A', 'SYS', 'approve / reject /<br>review / settle fees', S, exit=(0.2, 0), entry=(0.88, 0.82),
           label_pos=-0.45)
    p.edge('SYS', 'A', 'applications, stores, models,<br>audit, usage, fee overview', S, exit=(0.7, 0.96), entry=(0, 0.3),
           label_pos=-0.2)

    p.edge('SYS', 'X', 'auth, RLS queries,<br>signed asset requests', S, exit=(1, 0.4), entry=(0, 0.3))
    p.edge('X', 'SYS', 'sessions, rows,<br>authorization, signed URLs', S, exit=(0, 0.7), entry=(1, 0.6))

    p.edge('SYS', 'G', 'sign-in request<br>(identity scopes only)', S, exit=(0.3, 0.05), entry=(0.3, 1), label_pos=0.45)
    p.edge('G', 'SYS', 'identity', S, exit=(0.7, 1), entry=(0.7, 0.05), label_pos=0.35)
    p.edge('SYS', 'PP', 'seller onboarding; create / capture<br>(payee = shop merchant id)', S, exit=(0.8, 0.1), entry=(0, 0.6), label_pos=-0.35)
    p.edge('PP', 'SYS', 'capture result, seller status,<br>signed webhooks', S, exit=(0.2, 1), entry=(0.93, 0.25), label_pos=-0.3)
    p.edge('B', 'PP', 'approves & pays the shop directly', EDGE_ORTHO, exit=(0.1, 0), entry=(0.5, 0),
           points=[(58, 60), (1200, 60)])

    # 0015: Maya Checkout pays the owner of the keys (FurnishAR), and its webhooks are unsigned.
    p.edge('SYS', 'MY', 'create checkout (public key);<br>re-read payment (secret key)', S, exit=(0.97, 0.62), entry=(0, 0.2))
    p.edge('MY', 'SYS', 'redirect back, webhooks<br>(reference only)', S, exit=(0, 0.6), entry=(0.9, 0.78), label_pos=0.1)
    p.edge('B', 'MY', 'pays through Maya (received by FurnishAR, which pays the shop)', EDGE_ORTHO, exit=(0.5, 1), entry=(1, 0.5),
           points=[(130, 915), (1385, 915), (1385, 610)])

    p.edge('SYS', 'E', 'confirmation / order<br>email requests', S, exit=(0.15, 0.15), entry=(1, 0.6))
    p.edge('E', 'B', 'confirmation link, receipt,<br>quote, balance due', EDGE_ORTHO, exit=(0.31, 1), entry=(0.9, 0))
    p.edge('E', 'O', 'new order /<br>deposit paid', EDGE_ORTHO, exit=(0.9, 1), entry=(0.9, 0), label_pos=0.55)

    p.node('legend', '<b>Notation</b><br>Blue box = external entity<br>Circle = the whole system (process 0)<br>'
                     'Arrow = data flow, labelled with what moves',
           NOTE, 560, 800, 280, 90)
    return p


# =========================================================================
# 3. Level 2 — Protected 3D access
# =========================================================================
def access3d():
    p = Page('flow-3d', 'Flow — Protected 3D Access (step by step)', 1560, 820)
    p.node('title', 'Protected 3D Access — Authentication ≠ Authorization', GROUP + 'fontSize=16;', 40, 10, 700, 30)
    p.node('U', 'Guest / Buyer', EXTERNAL, 40, 205, 130, 70)
    p.node('P', 'Product Page<br>/furniture/[slug]', PAGE_ROUTE, 220, 205, 150, 70)
    p.node('G', 'Protected<br>action?', DECISION, 420, 190, 130, 100)
    p.node('L', 'Authentication Gate<br>/login?as=buyer&amp;next=…', PROCESS.replace('#e1d5e7', '#fff2cc').replace('#9673a6', '#d6b656'),
           400, 400, 170, 70)
    p.node('S', 'P1 Session Check<br>my_role()', PROCESS, 600, 205, 160, 70)
    p.node('R', 'P4 Planner<br>/plan', PROCESS, 810, 205, 150, 70)
    p.node('M', 'P5 GET /api/sb/model/<br>&lt;store&gt;/&lt;product&gt;/&lt;file&gt;', PROCESS, 1080, 205, 190, 70)
    p.node('Z', 'Authorized?<br>can_view_model<br>+ Storage RLS', DECISION, 1105, 360, 140, 120)
    p.node('D3', 'D3 Private 3D Asset<br>(furniture-models bucket)', STORE, 1340, 390, 190, 60)
    p.node('V', 'Signed URL<br>(expires in 5 min)', OK, 1350, 205, 170, 70)
    p.node('N', 'P9 Alert System — human-readable message<br>(sign-in failed · session expired · no permission · network)',
           ALERT, 380, 620, 560, 70)

    p.edge('U', 'P', 'opens piece')
    p.edge('P', 'G', 'View in 3D')
    p.edge('G', 'L', 'guest', exit=(0.5, 1), entry=(0.5, 0))
    p.edge('G', 'S', 'signed in')
    p.edge('L', 'S', 'success → restore<br>intended destination', exit=(1, 0.5), entry=(0.5, 1), points=[(680, 435)])
    p.edge('L', 'N', 'failure', exit=(0.3, 1), entry=(0.1, 0))
    p.edge('S', 'N', 'expired / invalid', exit=(0.8, 1), entry=(0.75, 0))
    p.edge('S', 'R', 'authenticated')
    p.edge('R', 'M', '3D request', exit=(1, 0.3), entry=(0, 0.3))
    p.edge('M', 'R', '200 + signed URL', exit=(0, 0.7), entry=(1, 0.7))
    p.edge('M', 'Z', 'who? which object?', exit=(0.5, 1), entry=(0.5, 0))
    p.edge('Z', 'D3', 'allowed')
    p.edge('D3', 'V', 'sign object', exit=(0.5, 0), entry=(0.5, 1))
    p.edge('V', 'M', 'signed URL')
    p.edge('Z', 'N', 'denied (403)', exit=(0.5, 1), entry=(1, 0.3), points=[(1175, 641)])
    p.edge('M', 'N', '401 / 5xx / network', exit=(0.05, 1), entry=(1, 0.8), points=[(1090, 676)])
    p.edge('R', 'U', '3D / AR view of the piece', exit=(0.5, 0), entry=(0.5, 0), points=[(885, 130), (105, 130)])
    p.edge('N', 'U', 'alert shown to the user', exit=(0, 0.5), entry=(0.5, 1), points=[(105, 655)])

    p.node('legend', '<b>Authentication</b> (P1) answers <i>who</i> is asking.<br>'
                     '<b>Authorization</b> (P5) answers whether that caller may open <i>this</i> file.<br>'
                     'A missing object and a denied one both answer 403, so a draft is never revealed.',
           NOTE, 40, 720, 520, 70)
    return p


# =========================================================================
# 4. Level 2 — Orders & payments
# =========================================================================
def payments():
    p = Page('flow-p10', 'Flow — Checkout & Custom-Build Stages', 1400, 1000)
    p.node('title', 'P10 Orders & Payments — stocked checkout', GROUP + 'fontSize=16;', 40, 10, 600, 30)
    p.node('U', 'Buyer', EXTERNAL, 40, 185, 120, 70)
    p.node('PG', 'Product Page<br>purchase panel', PAGE_ROUTE, 200, 185, 150, 70)
    p.node('A', 'Signed-in<br>buyer?', DECISION, 400, 170, 130, 100)
    p.node('L', 'Auth Gate<br>/login?as=buyer', PROCESS.replace('#e1d5e7', '#fff2cc').replace('#9673a6', '#d6b656'),
           390, 50, 150, 60)
    p.node('C', 'POST /api/sb/orders/<br>checkout', PROCESS, 590, 185, 170, 70)
    p.node('DB', 'D5 create_stock_order<br>price + 10% fee from D2<br>30-min stock hold', STORE, 810, 180, 200, 80)
    p.node('PPc', 'PayPal Order<br>payee = shop', EXTERNAL, 1080, 185, 170, 70)
    p.node('AP', 'Buyer approves<br>on PayPal', EXTERNAL, 1080, 385, 170, 70)
    p.node('R', 'Return to<br>/account?paypal=return', PAGE_ROUTE, 830, 385, 170, 70)
    p.node('CAP', 'POST /api/sb/orders/<br>capture', PROCESS, 590, 385, 170, 70)
    p.node('V', 'PayPal order<br>matches<br>begin_payment?', DECISION, 395, 365, 140, 110)
    p.node('K', 'PayPal Capture', EXTERNAL, 385, 560, 160, 60)
    p.node('RC', 'D5 record_capture<br>server secret + amount<br>+ payee check', STORE, 590, 550, 190, 80)
    p.node('N', 'P9 Alert + Email<br>receipt · ETA · shop notified', OK, 840, 555, 190, 70)
    p.node('X', 'P9 Alert<br>not charged / try again', ALERT, 180, 385, 150, 70)

    p.edge('U', 'PG', 'Buy')
    p.edge('PG', 'A', 'qty, delivery<br>or pickup')
    p.edge('A', 'L', 'guest /<br>store account', exit=(0.5, 0), entry=(0.5, 1))
    p.edge('L', 'PG', 'back to the piece', exit=(0, 0.5), entry=(0.5, 0), points=[(275, 80)])
    p.edge('A', 'C', 'buyer')
    p.edge('C', 'DB', 'order request')
    p.edge('DB', 'PPc', 'amount from DB,<br>never the browser')
    p.edge('PPc', 'AP', 'approval link', exit=(0.5, 1), entry=(0.5, 0))
    p.edge('AP', 'R', 'approved')
    p.edge('R', 'CAP', 'order id')
    p.edge('CAP', 'V', 'verify')
    p.edge('V', 'X', 'no')
    p.edge('V', 'K', 'yes', exit=(0.5, 1), entry=(0.5, 0))
    p.edge('K', 'RC', 'COMPLETED')
    p.edge('RC', 'N', 'recorded')

    # Custom-build lifecycle.
    p.node('ctitle', 'Custom builds (custom shops) — the same capture path, in stages', GROUP + 'fontSize=14;',
           40, 690, 700, 30)
    states = [('s1', 'requested'), ('s2', 'quoted'), ('s3', 'deposit_paid'), ('s4', 'ready'),
              ('s5', 'paid'), ('s6', 'fulfilled')]
    steps = ['shop quotes<br>price + lead time', 'buyer pays<br>50% deposit', 'shop marks<br>ready',
             'buyer pays<br>balance', 'delivered /<br>picked up']
    for i, (sid, label) in enumerate(states):
        p.node(sid, label, OK if sid == 's6' else PROCESS, 60 + i * 220, 750, 130, 50)
    for i in range(len(states) - 1):
        p.edge(states[i][0], states[i + 1][0], steps[i])
    p.node('s0', 'declined / cancelled', ALERT, 60, 880, 350, 50)
    p.edge('s1', 's0', 'shop declines', exit=(0.5, 1), entry=(0.2, 0))
    p.edge('s2', 's0', 'buyer cancels', exit=(0.5, 1), entry=(0.8, 0))
    p.node('note', 'Every payment goes to the <b>shop\'s</b> PayPal. The 10% fee accrues in D5 and is settled<br>'
                   'by the shop; an admin records it in /admin/billing (P8 → D5).',
           NOTE, 480, 870, 560, 60)
    return p


# =========================================================================
# 5. Use case diagram
# =========================================================================
def usecases():
    p = Page('use-case', 'Use Case Diagram', 1440, 1200)
    p.node('SYS', 'FurnishAR', BOUNDARY, 260, 40, 880, 1010)

    p.node('Guest', 'Guest', ACTOR, 110, 150, 40, 80)
    p.node('Buyer', 'Buyer', ACTOR, 110, 560, 40, 80)
    p.node('Owner', 'Store Owner', ACTOR, 1250, 250, 40, 80)
    p.node('Admin', 'Platform Admin', ACTOR, 1250, 780, 40, 80)
    p.node('PayPal', 'PayPal', ACTOR, 530, 1090, 40, 80)
    p.node('Email', 'Email Service', ACTOR, 795, 1090, 40, 80)

    # Shopper column.
    col1 = [('browse', 'Browse Catalogue'), ('details', 'View Product Details'), ('device', 'Run Device Check'),
            ('login', 'Sign Up / Log In'), ('view3d', 'View 3D Model'), ('ar', 'Place Furniture in AR'),
            ('measure', 'Measure Room &amp; Check Fit'), ('buy', 'Buy Stocked Item'),
            ('delivery', 'Choose Delivery or Pickup'), ('custom', 'Request Custom Build'),
            ('paystage', 'Pay Deposit / Balance'), ('receipt', 'View / Print Receipt'),
            ('profile', 'Manage Profile')]
    for i, (uid, label) in enumerate(col1):
        p.node(uid, label, USECASE, 300, 80 + i * 72, 210, 52)

    # Included use cases, shared.
    p.node('authn', 'Authenticate', USECASE_INC, 590, 296, 170, 52)
    p.node('authz', 'Authorize 3D Access', USECASE_INC, 590, 368, 170, 52)
    p.node('pay', 'Pay with PayPal', USECASE_INC, 590, 700, 170, 52)
    p.node('notify', 'Send Email Notification', USECASE_INC, 590, 872, 170, 52)
    p.node('audit', 'Write Audit Log', USECASE_INC, 590, 980, 170, 52)

    # Owner and admin column.
    owner = [('apply', 'Apply for a Store'), ('products', 'Manage Products'), ('upload', 'Upload 3D Model'),
             ('quote', 'Quote / Decline Request'), ('ship', 'Update Delivery Status'),
             ('billing', 'Set Billing &amp; Payout'), ('fees', 'View Fees Owed')]
    for i, (uid, label) in enumerate(owner):
        p.node(uid, label, USECASE, 870, 80 + i * 72, 230, 52)
    admin = [('review', 'Approve / Reject Application'), ('stores', 'View Stores &amp; 3D Files'),
             ('usage', 'View Storage Usage'), ('activity', 'View Activity'), ('settle', 'Record Fee Settlement')]
    for i, (uid, label) in enumerate(admin):
        p.node(uid, label, USECASE, 870, 656 + i * 72, 230, 52)

    p.edge('Buyer', 'Guest', '', GENERAL + 'edgeStyle=orthogonalEdgeStyle;', exit=(0, 0.4), entry=(0, 0.45),
           points=[(70, 592), (70, 186)])
    for uid in ('browse', 'details', 'device', 'login', 'view3d'):
        p.edge('Guest', uid, '', ASSOC, entry=(0, 0.5))
    for uid in ('ar', 'measure', 'buy', 'custom', 'paystage', 'delivery', 'receipt', 'profile'):
        p.edge('Buyer', uid, '', ASSOC, entry=(0, 0.5))
    for uid, _ in owner:
        p.edge('Owner', uid, '', ASSOC, entry=(1, 0.5))
    for uid, _ in admin:
        p.edge('Admin', uid, '', ASSOC, entry=(1, 0.5))
    p.edge('PayPal', 'pay', '', ASSOC + 'edgeStyle=orthogonalEdgeStyle;', exit=(0.5, 0), entry=(0, 0.5),
           points=[(550, 726)])
    p.edge('Email', 'notify', '', ASSOC + 'edgeStyle=orthogonalEdgeStyle;', exit=(0.5, 0), entry=(1, 0.5),
           points=[(815, 898)])

    inc = '«include»'
    p.edge('login', 'authn', inc, INCLUDE, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('view3d', 'authz', inc, INCLUDE, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('authz', 'authn', inc, INCLUDE, exit=(0.5, 0), entry=(0.5, 1))
    p.edge('buy', 'pay', inc, INCLUDE, exit=(1, 0.5), entry=(0.1, 0.2))
    p.edge('paystage', 'pay', inc, INCLUDE, exit=(1, 0.5), entry=(0.1, 0.8))
    p.edge('buy', 'delivery', inc, INCLUDE, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('paystage', 'custom', '«extend»', INCLUDE, exit=(0.5, 0), entry=(0.5, 1))
    p.edge('pay', 'notify', inc, INCLUDE, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('quote', 'notify', inc, INCLUDE, exit=(0, 0.8), entry=(0.75, 0))
    p.edge('ship', 'notify', inc, INCLUDE, exit=(0, 0.8), entry=(0.9, 0.1))
    p.edge('review', 'audit', inc, INCLUDE, exit=(0, 0.7), entry=(0.85, 0.05))
    p.edge('settle', 'audit', inc, INCLUDE, exit=(0, 0.5), entry=(1, 0.5))
    p.edge('upload', 'authn', inc, INCLUDE, exit=(0, 0.5), entry=(1, 0.3))

    p.node('legend', '<b>Buyer</b> is a Guest who has signed in (hollow arrow = generalization).<br>'
                     'Grey italic use cases are <b>included</b> by others (dashed «include»).<br>'
                     'Paying a deposit or balance <b>extends</b> a custom build once the shop quotes.',
           NOTE, 1040, 1080, 380, 80)
    return p


# =========================================================================
# Levelled DFDs (Gane–Sarson): Level 1, three Level 2s, two Level 3s.
# =========================================================================
def proc(p, nid, num, name, x, y, w=240, h=64):
    return p.node(nid, f'<b>{num}</b><br>{name}', DFD_PROCESS, x, y, w, h)


def ref(p, nid, num, name, x, y, w=220, h=56):
    """A process drawn on another diagram, shown here only as a source or sink."""
    return p.node(nid, f'<b>{num}</b><br>{name}', DFD_REF, x, y, w, h)


def store(p, nid, code, name, x, y, w=270, h=44):
    return p.node(nid, f'<b>{code}</b>&nbsp;&nbsp;|&nbsp;&nbsp;{name}', DFD_STORE, x, y, w, h)


def ext(p, nid, name, x, y, w=170, h=64):
    return p.node(nid, name, DFD_EXTERNAL, x, y, w, h)


O = EDGE_ORTHO + JUMP
S = EDGE_STRAIGHT
D = EDGE_STRAIGHT + DIALOG


def level1():
    p = Page('dfd-1', 'Level 1 — System DFD', 1720, 1330)
    p.node('title', 'Level 1 DFD — FurnishAR System (processes 1.0–10.0)', TITLE, 40, 10, 800, 30)
    ext(p, 'B', 'Buyer / Guest', 40, 250, 160, 200)
    ext(p, 'O', 'Store Owner', 40, 880, 160, 120)
    ext(p, 'A', 'Platform Admin', 40, 1075, 160, 70)
    ext(p, 'EM1', 'Email Service', 1480, 95, 170, 54)
    ext(p, 'PP', 'PayPal / Maya<br>(payment providers)', 1480, 690, 170, 64)
    ext(p, 'EM', 'Email Service', 1480, 830, 170, 64)

    proc(p, 'P1', '1.0', 'Authentication &amp; Session', 420, 60)
    proc(p, 'P2', '2.0', 'Browse Collection', 420, 175)
    proc(p, 'P3', '3.0', 'Product Details', 420, 290)
    proc(p, 'P4', '4.0', 'Planner / Device Check', 420, 405)
    proc(p, 'P6', '6.0', 'Profile / Account', 420, 545)
    proc(p, 'P10', '10.0', 'Orders &amp; Payments', 420, 715)
    proc(p, 'P7', '7.0', 'Store Portal', 420, 895)
    proc(p, 'P8', '8.0', 'Admin Console', 420, 1075)
    proc(p, 'P5', '5.0', '3D Access &amp; Authorization', 800, 405, 240, 110)
    proc(p, 'P9', '9.0', 'Notifications / Alerts', 420, 1215, 620, 64)

    store(p, 'D1', 'D1', 'Accounts &amp; Roles', 1120, 70)
    store(p, 'D2', 'D2', 'Catalogue / Products', 1120, 190, 270, 150)
    store(p, 'D3', 'D3', 'Private 3D Assets', 1120, 420, 270, 60)
    store(p, 'D1b', 'D1', 'Accounts &amp; Roles (copy)', 1120, 490)
    store(p, 'D6', 'D6', 'Catalogue Posters (public)', 1120, 600)
    store(p, 'D2b', 'D2', 'Catalogue / Products (copy)', 1120, 680)
    store(p, 'D5', 'D5', 'Orders / Payments / Fees', 1120, 745, 270, 80)
    store(p, 'D2c', 'D2', 'Catalogue / Products (copy)', 1120, 885)
    store(p, 'D3b', 'D3', 'Private 3D Assets (copy)', 1120, 940)
    store(p, 'D4', 'D4', 'Applications / Audit / Usage', 1120, 1050, 270, 60)
    store(p, 'D5b', 'D5', 'Orders / Payments / Fees (copy)', 1120, 1120)

    # Buyer, owner and admin dialogs (request and reply on one line).
    p.edge('B', 'P1', 'credentials / session, role', D, exit=(1, 0.08), entry=(0, 0.5))
    p.edge('B', 'P2', 'catalogue request / results', D, exit=(1, 0.22), entry=(0, 0.5))
    p.edge('B', 'P3', 'product request / details', D, exit=(1, 0.42), entry=(0, 0.5))
    p.edge('B', 'P4', 'planner request / placement, fit', D, exit=(1, 0.62), entry=(0, 0.5))
    p.edge('B', 'P6', 'profile changes / profile', D, exit=(1, 0.8), entry=(0, 0.5))
    p.edge('B', 'P10', 'buy, request, pay /<br>order status, approval link', D, exit=(1, 0.92), entry=(0, 0.4))
    p.edge('O', 'P10', 'quote, ready, delivery, billing /<br>incoming orders, fees owed', D, exit=(1, 0.1), entry=(0, 0.85))
    p.edge('O', 'P7', 'inventory, uploads, application /<br>store results', D, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('A', 'P8', 'review, settle / console data', D, exit=(1, 0.5), entry=(0, 0.5))

    # 1.0
    p.edge('P1', 'D1', 'new account', O, exit=(1, 0.3), entry=(0, 0.2))
    p.edge('D1', 'P1', 'identity, role', O, exit=(0, 0.8), entry=(1, 0.7))
    p.edge('P1', 'EM1', 'confirmation request', O, exit=(1, 0.95), entry=(0, 0.5))
    # 2.0, 3.0
    p.edge('D2', 'P2', 'published products', O, exit=(0, 0.15), entry=(1, 0.6))
    p.edge('D2', 'P3', 'product record', O, exit=(0, 0.75), entry=(1, 0.2))
    # 4.0 <-> 5.0, 4.0 -> 1.0
    p.edge('P4', 'P5', 'model request + token', O, exit=(1, 0.3), entry=(0, 0.175))
    p.edge('P5', 'P4', 'signed URL / refusal', O, exit=(0, 0.545), entry=(1, 0.93))
    p.edge('P4', 'P1', 'session check', O, exit=(1, 0.62), entry=(1, 0.95), points=[(685, 444.7), (685, 120.8)])
    # 5.0
    p.edge('D2', 'P5', 'product / store status', O, exit=(0, 0.95), entry=(0.8, 0), points=[(992, 332.5)])
    p.edge('P5', 'D3', 'sign object (as user); record last use', O, exit=(1, 0.2), entry=(0, 0.117))
    p.edge('D3', 'P5', 'signed URL / refusal', O, exit=(0, 0.85), entry=(1, 0.6))
    p.edge('D1b', 'P5', 'session, admin / member', O, exit=(0, 0.4), entry=(1, 0.93))
    # 6.0
    p.edge('P6', 'D1b', 'profile update', O, exit=(1, 0.2), entry=(0.1, 1), points=[(1147, 557.8)])
    p.edge('D1b', 'P6', 'own profile', O, exit=(0.25, 1), entry=(1, 0.7), points=[(1187.5, 589.8)])
    # 10.0
    p.edge('P10', 'D2b', 'stock hold', O, exit=(1, 0.1), entry=(0, 0.9))
    p.edge('D2b', 'P10', 'price, stock', O, exit=(0, 0.2), entry=(0.9, 0), points=[(636, 688.8)])
    p.edge('P10', 'PP', 'create / capture (PayPal: payee = shop); checkout, re-read (Maya)', O, exit=(1, 0.3), entry=(0, 0.69))
    p.edge('PP', 'P10', 'approval / capture result; Maya redirect, webhook (re-read)', O, exit=(0.3, 0), entry=(0.7, 0), points=[(1531, 650), (588, 650)])
    p.edge('P10', 'D5', 'orders, verified payments', O, exit=(1, 0.6), entry=(0, 0.1))
    p.edge('D5', 'P10', 'amount due, order state', O, exit=(0, 0.4), entry=(1, 0.95))
    p.edge('P10', 'EM', 'receipt / order emails', O, exit=(0.8, 1), entry=(0, 0.3), points=[(612, 849.2)])
    p.edge('P8', 'EM', 'model expiry notices (8.3, 0013)', O, exit=(1, 0.95), entry=(0.5, 1),
           points=[(1080, 1135.8), (1080, 1300), (1565, 1300)])
    # 7.0
    p.edge('P7', 'D2c', 'product CRUD', O, exit=(1, 0.2), entry=(0, 0.6))
    p.edge('P7', 'D3b', 'model upload (signed)', O, exit=(1, 0.85), entry=(0, 0.2))
    # 0012: the poster rendered from the model, and the only image a card loads.
    p.edge('P7', 'D6', 'poster (rendered from the model)', O, exit=(0.9, 0), entry=(1, 0.5), points=[(636, 872), (1430, 872), (1430, 622)])
    p.edge('D6', 'P2', 'poster images (public, cached)', O, exit=(1, 0.2), entry=(1, 0.85), points=[(1450, 608.8), (1450, 170), (700, 170), (700, 229.4)])
    p.edge('P7', 'D4', 'store application', O, exit=(0.95, 1), entry=(0, 0.13), points=[(648, 1010), (770, 1010), (770, 1057.8)])
    # 8.0
    p.edge('P8', 'D4', 'applications, audit, usage', O, exit=(1, 0.3), entry=(0, 0.73))
    p.edge('P8', 'D5b', 'fee overview, settlements; Maya setup, payouts', O, exit=(1, 0.9), entry=(0, 0.3))
    p.edge('P8', 'D3b', 'model review; delete a model unused 365 days', O, exit=(1, 0.05), entry=(0, 0.8), points=[(790, 1078.2), (790, 975.2)])
    # 9.0: every process reports its events on one bus; alerts go back to the three people.
    for pid in ('P1', 'P2', 'P3', 'P4', 'P6', 'P10', 'P7', 'P8'):
        n = p.nodes[pid]
        y = n['y'] + n['h'] * 0.97
        p.edge(pid, 'P9', 'events' if pid == 'P8' else '', O, exit=(1, 0.97), entry=(0.4597, 0), points=[(705, y), (705, 1215)])
    p.edge('P5', 'P9', '', O, exit=(0, 0.95), entry=(0.4597, 0), points=[(705, 509.5), (705, 1215)])
    for eid, entry in (('B', (1, 0.97)), ('O', (1, 0.95)), ('A', (1, 0.9))):
        n = p.nodes[eid]
        p.edge('P9', eid, 'alerts' if eid == 'A' else '', O, exit=(0, 0.5), entry=entry, points=[(300, 1247), (300, n['y'] + n['h'] * entry[1])])

    p.node('legend', '<b>Notation (Gane–Sarson)</b><br>Rounded box = process (numbered)<br>'
                     'Open box = data store (D1–D6); "(copy)" = the same store drawn again to avoid crossings<br>'
                     'Blue box = external entity · Two-headed arrow = a request and its reply',
           NOTE, 1120, 1190, 560, 90)
    return p


def level2_auth():
    p = Page('dfd-2-auth', 'Level 2 — 1.0 Authentication & Session', 1500, 900)
    p.node('title', 'Level 2 DFD — Process 1.0 Authentication &amp; Session', TITLE, 40, 10, 800, 30)
    ext(p, 'U', 'Buyer / Store Owner /<br>Platform Admin', 40, 300, 180, 260)
    ext(p, 'EM', 'Email Service', 1320, 60, 160, 64)
    ref(p, 'R4', '4.0 / 10.0', 'Planner · Orders', 40, 700, 180, 60)
    ref(p, 'R9', '9.0', 'Notifications / Alerts', 420, 820, 240, 56)

    proc(p, 'P11', '1.1', 'Register Account', 420, 60)
    proc(p, 'P12', '1.2', 'Log In', 420, 210)
    proc(p, 'P13', '1.3', 'Resolve Role (my_role)', 420, 360)
    proc(p, 'P14', '1.4', 'Renew Session', 420, 510)
    proc(p, 'P15', '1.5', 'Log Out', 420, 660)

    store(p, 'D11', 'D1.1', 'Auth Users &amp; Sessions (GoTrue)', 900, 190, 300, 560)
    store(p, 'D12', 'D1.2', 'Roles: buyers · store_members · platform_admins', 900, 40, 380, 110)
    store(p, 'D12b', 'D1.2', 'Roles (copy)', 690, 372, 170, 40)

    p.edge('U', 'P11', 'name, email, password, town /<br>created or "check your email"', D, exit=(1, 0.05), entry=(0, 0.5))
    p.edge('U', 'P12', 'email, password / session tokens', D, exit=(1, 0.25), entry=(0, 0.5))
    p.edge('P13', 'U', 'role → destination', S, exit=(0, 0.5), entry=(1, 0.5))
    p.edge('U', 'P14', 'refresh token / new session or expiry', D, exit=(1, 0.75), entry=(0, 0.5))
    p.edge('U', 'P15', 'sign-out / signed out', D, exit=(1, 0.97), entry=(0, 0.4))

    p.edge('P11', 'D12', 'buyer row (trigger)', O, exit=(1, 0.3), entry=(0, 0.388))
    p.edge('P11', 'D11', 'new user', O, exit=(1, 0.8), entry=(0, 0.02), points=[(860, 111.2), (860, 201.2)])
    p.edge('P11', 'EM', 'confirmation request', O, exit=(0.5, 0), entry=(0, 0.3), points=[(540, 30), (1300, 30), (1300, 79.2)])
    p.edge('P12', 'D11', 'password grant', O, exit=(1, 0.3), entry=(0, 0.06))
    p.edge('D11', 'P12', 'access + refresh token', O, exit=(0, 0.14), entry=(1, 0.8))
    p.edge('P12', 'P13', 'access token', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('D12b', 'P13', 'role rows', O, exit=(0, 0.5), entry=(1, 0.5))
    p.edge('R4', 'P13', 'session check', O, exit=(1, 0.3), entry=(0, 0.8), points=[(320, 718), (320, 411.2)])
    p.edge('P13', 'R4', 'role / guest', O, exit=(0, 0.95), entry=(1, 0.8), points=[(340, 420.8), (340, 748)])
    p.edge('P14', 'D11', 'rotate refresh token', O, exit=(1, 0.3), entry=(0, 0.6))
    p.edge('D11', 'P14', 'new tokens / refused', O, exit=(0, 0.66), entry=(1, 0.8))
    p.edge('P15', 'D11', 'revoke session', O, exit=(1, 0.4), entry=(0, 0.87))
    p.edge('P15', 'R9', 'auth events (from 1.1–1.5)', O, exit=(0.5, 1), entry=(0.5, 0))
    return p


def level2_google():
    p = Page('dfd-2-google', 'Level 2 — 1.0 Google Sign-in & Onboarding', 1500, 880)
    p.node('title', 'Level 2 DFD — 1.0 Google Sign-in &amp; Onboarding (authentication only)', TITLE, 40, 10, 900, 30)
    ext(p, 'U', 'Buyer / Store Owner', 40, 80, 180, 600)
    ext(p, 'G', 'Google<br>(through Supabase Auth)', 900, 80, 200, 64)
    ext(p, 'EM', 'Email Service', 1300, 740, 170, 64)
    proc(p, 'P16', '1.6', 'Start Google Sign-in (PKCE)', 420, 80)
    proc(p, 'P17', '1.7', 'Exchange Code<br>(drop provider tokens)', 420, 240)
    ref(p, 'R13', '1.3', 'Resolve Role (my_role)', 430, 420)
    proc(p, 'P18', '1.8', 'Onboard: Buyer or<br>Store Application', 420, 600)
    store(p, 'D11', 'D1.1', 'Auth Users &amp; Sessions (GoTrue)', 900, 330, 320, 50)
    store(p, 'D12', 'D1.2', 'Roles: buyers · store_members · platform_admins', 900, 430, 400, 50)
    store(p, 'D4', 'D4', 'Store Applications (applicant_user_id)', 900, 620, 340, 50)

    p.edge('U', 'P16', 'Continue with Google (safe next, intent)', D, exit=(1, 0.05), entry=(0, 0.5))
    p.edge('P16', 'G', 'authorize: PKCE challenge,<br>identity scopes', S, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('G', 'P17', 'one-time code (/auth/callback)', O, exit=(0.5, 1), entry=(1, 0.5), points=[(1000, 272)])
    p.edge('P17', 'D11', 'code + server-held verifier', O, exit=(1, 0.85), entry=(0, 0.3), points=[(780, 294.4), (780, 345)], label_pos=0.5)
    p.edge('P17', 'U', 'session (no Google tokens), safe next', S, exit=(0, 0.5), entry=(1, 0.32))
    p.edge('P17', 'R13', 'access token', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('D12', 'R13', 'role rows', S, exit=(0, 0.5), entry=(1, 0.55))
    p.edge('R13', 'U', 'destination; no role → /onboarding', S, exit=(0, 0.55), entry=(1, 0.62))
    p.edge('R13', 'P18', 'role = onboarding', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('U', 'P18', 'municipality / store application', D, exit=(1, 0.92), entry=(0, 0.5))
    p.edge('P18', 'D12', 'buyers row', O, exit=(1, 0.3), entry=(0.285, 1), points=[(1014, 619.2)])
    p.edge('P18', 'D4', 'application by account id', S, exit=(1, 0.7), entry=(0, 0.5))
    p.edge('P18', 'EM', 'welcome / application emails', O, exit=(0.5, 1), entry=(0, 0.5), points=[(540, 772)])
    p.node('note', '<b>Never here:</b> admin rights (only platform_admins), Google tokens, passwords.<br>'
                   'A Google account is identity only; PayPal is a separate account system (10.9).',
           NOTE, 1130, 160, 340, 90)
    return p


def level2_paypal():
    p = Page('dfd-2-paypal', 'Level 2 — 10.9–10.13 PayPal Seller, Webhooks & Reminders', 1620, 980)
    p.node('title', 'Level 2 DFD — PayPal seller connection, webhooks, reminders and fee mode', TITLE, 40, 10, 900, 30)
    ext(p, 'O', 'Store Owner', 40, 80, 170, 220)
    ext(p, 'A', 'Platform Admin', 40, 600, 170, 64)
    ext(p, 'SCH', 'Scheduler<br>(Vercel Cron)', 40, 800, 170, 64)
    ext(p, 'PP', 'PayPal', 1400, 240, 180, 330)
    ext(p, 'EM', 'Email Service', 1400, 800, 180, 64)
    proc(p, 'P109', '10.9', 'Link Seller (Merchant ID)<br>or Partner Onboarding', 420, 80)
    proc(p, 'P1010', '10.10', 'Verify Seller Status<br>(from PayPal only)', 420, 250)
    proc(p, 'P1011', '10.11', 'Process Webhook<br>(verified, once per event)', 420, 430)
    proc(p, 'P1012', '10.12', 'Report Fee Mode &amp; Config', 420, 600)
    proc(p, 'P1013', '10.13', 'Payment-Setup Reminders<br>(cooldown, cap)', 420, 800)
    store(p, 'D54', 'D5.4', 'store_payment_accounts', 880, 160, 320, 50)
    store(p, 'D55', 'D5.5', 'payment_webhook_events', 880, 385, 320, 44)
    store(p, 'D52', 'D5.2', 'payments · payment_attempts · payment_refunds', 880, 560, 400, 44)
    store(p, 'D53', 'D5.3', 'fee settlements / fee overview', 880, 640, 320, 44)

    p.edge('O', 'P109', 'Merchant ID / Connect PayPal', D, exit=(1, 0.14), entry=(0, 0.5))
    p.edge('P109', 'D54', 'member check + tracking id', O, exit=(1, 0.7), entry=(0, 0.3), points=[(740, 124.8), (740, 175)])
    p.edge('P109', 'PP', 'payee check (₱1 order, never captured) / partner referral', O, exit=(0.5, 0), entry=(0.5, 0), points=[(540, 40), (1490, 40)])
    p.edge('O', 'P1010', 'return from PayPal / Check status', D, exit=(1, 0.8), entry=(0, 0.5), points=[(300, 256), (300, 282)])
    p.edge('P1010', 'PP', 'merchant for OUR tracking id;<br>merchant integration', S, exit=(1, 0.3), entry=(0, 0.1))
    p.edge('P1010', 'D54', 'status: CONNECTED / PENDING / ERROR…', O, exit=(1, 0.1), entry=(0.1, 1), points=[(912, 256.4)])
    p.edge('PP', 'P1011', 'signed events: capture, refund,<br>seller, consent', S, exit=(0, 0.66), entry=(1, 0.5))
    p.edge('P1011', 'PP', 'verify signature; re-read order', S, exit=(1, 0.9), entry=(0, 0.83))
    p.edge('P1011', 'D55', 'claim / finish event', O, exit=(1, 0.1), entry=(0, 0.5), points=[(770, 436.4), (770, 407)])
    p.edge('P1011', 'D52', 'capture (vs attempt), refund portions', O, exit=(0.9, 1), entry=(0, 0.5), points=[(636, 582)])
    p.edge('P1011', 'D54', 'seller status changes', O, exit=(0.8, 0), entry=(0.3, 1), points=[(612, 350), (976, 350)])
    p.edge('A', 'P1012', 'open billing', D, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('D53', 'P1012', 'accrued / collected / settled', S, exit=(0, 0.5), entry=(1, 0.6))
    p.edge('SCH', 'P1013', 'daily, with CRON_SECRET', S, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('D54', 'P1013', 'not connected, due', O, exit=(1, 0.5), entry=(1, 0.5), points=[(1330, 185), (1330, 760), (700, 760), (700, 832)])
    p.edge('P1013', 'EM', 'paypal_connection_required', S, exit=(1, 0.7), entry=(0, 0.7))
    p.edge('P1011', 'EM', 'paid / refund / problem emails', O, exit=(0.3, 1), entry=(0, 0.3), points=[(492, 540), (360, 540), (360, 740), (1360, 740), (1360, 819.2)])
    p.node('note', '<b>Truthful fee mode:</b> accrual unless PAYPAL_FEE_MODE=platform_split, the partner ids are set and the seller granted '
                   'the partner fee; "collected" only when PayPal\'s capture reports it. Sandbox unless PAYPAL_ENV=live.',
           NOTE, 880, 880, 560, 70)
    return p


def level2_access():
    p = Page('dfd-2-3d', 'Level 2 — 5.0 3D Access & Authorization', 1500, 820)
    p.node('title', 'Level 2 DFD — Process 5.0 3D Access &amp; Authorization', TITLE, 40, 10, 800, 30)
    ref(p, 'R4', '4.0', 'Planner / 3D Viewer', 40, 330, 190, 70)
    ref(p, 'R9', '9.0', 'Notifications / Alerts', 560, 720, 240, 56)

    proc(p, 'P51', '5.1', 'Validate Model Request', 330, 190)
    proc(p, 'P52', '5.2', 'Verify Session', 330, 420)
    proc(p, 'P53', '5.3', 'Authorize &amp; Sign Object', 700, 420)
    proc(p, 'P54', '5.4', 'Deliver Signed URL', 700, 190)

    store(p, 'D11', 'D1.1', 'Auth Users &amp; Sessions (GoTrue)', 330, 600, 240, 44)
    store(p, 'D12', 'D1.2', 'Roles: platform_admins · store_members', 1080, 330, 380, 44)
    store(p, 'D2', 'D2', 'Products · Stores · Product Assets', 1080, 430, 380, 44)
    store(p, 'D3', 'D3', 'Private 3D Assets (furniture-models)', 1080, 540, 380, 60)

    p.edge('R4', 'P51', 'model request<br>(path, user token)', O, exit=(0.5, 0), entry=(0, 0.5), points=[(135, 222)])
    p.edge('P51', 'P52', 'token, path', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('P52', 'D11', 'is this session live?', O, exit=(0.3, 1), entry=(0.3, 0))
    p.edge('D11', 'P52', 'user / none', O, exit=(0.8, 0), entry=(0.8, 1))
    p.edge('P52', 'P53', 'user, token, path', O, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('D12', 'P53', 'admin / member rows', O, exit=(0, 0.5), entry=(1, 0.1), points=[(1000, 352), (1000, 426.4)])
    p.edge('D2', 'P53', 'published? active?', O, exit=(0, 0.5), entry=(1, 0.5))
    p.edge('P53', 'D3', 'sign object as user', O, exit=(1, 0.9), entry=(0, 0.2), points=[(1000, 477.6), (1000, 552)])
    p.edge('D3', 'P53', 'signed URL / refusal', O, exit=(0, 0.8), entry=(0.7, 1), points=[(868, 588)])
    p.edge('P53', 'P54', 'signed URL (300 s)', O, exit=(0.5, 0), entry=(0.5, 1))
    # 0012: the model lifecycle's one input — only after a URL was signed.
    proc(p, 'P55', '5.5', 'Record Model Use<br>(at most once a day)', 1080, 190)
    p.edge('P54', 'P55', 'granted: path, user token', O, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('P55', 'D2', 'product_assets.last_accessed_at', O, exit=(1, 0.5), entry=(1, 0.5), points=[(1480, 222), (1480, 452)])
    p.edge('P54', 'R4', '{url, expiresIn: 300}', O, exit=(0.5, 0), entry=(0.8, 0), points=[(820, 150), (192, 150)])
    p.edge('D3', 'R4', 'model file (via signed URL)', O, exit=(0.5, 1), entry=(0.5, 1), points=[(1270, 700), (135, 700)])
    p.edge('P51', 'R9', '400 bad path / 401 sign in', O, exit=(0, 0.9), entry=(0.1, 0), points=[(290, 247.6), (290, 560), (584, 560)])
    p.edge('P52', 'R9', '401 session expired', O, exit=(1, 0.9), entry=(0.3, 0), points=[(632, 477.6)])
    p.edge('P53', 'R9', '403 unavailable / 502', O, exit=(0.3, 1), entry=(0.6, 0), points=[(772, 560), (704, 560)])
    return p


def level2_lifecycle():
    p = Page('dfd-2-lifecycle', 'Level 2 — 7.0/8.0 Posters & Model Lifecycle', 1640, 980)
    p.node('title', 'Level 2 DFD — Catalogue posters and the 3D model lifecycle (0012, 0013)', TITLE, 40, 10, 900, 30)
    ext(p, 'O', 'Store Owner', 40, 90, 170, 64)
    ext(p, 'B', 'Buyer / Guest', 40, 400, 170, 64)
    ext(p, 'A', 'Platform Admin', 40, 690, 170, 64)
    ref(p, 'R5', '5.0', '3D Access &amp; Authorization', 330, 520, 240, 56)

    proc(p, 'P71', '7.1', 'Check Model &amp; Render Poster<br>(owner\'s browser)', 330, 90)
    proc(p, 'P72', '7.2', 'Upload Model &amp; Poster', 720, 90)
    proc(p, 'P21', '2.1', 'Show Catalogue Card<br>(poster only, no model)', 330, 390)
    proc(p, 'P81', '8.1', 'Review Model Lifecycle', 330, 680)
    proc(p, 'P82', '8.2', 'Delete Stale Model<br>(365 days unused + notified 30 days, manual)', 720, 810)
    proc(p, 'P83', '8.3', 'Notify Owner<br>(daily, 335 days unused)', 720, 600)
    ext(p, 'EM', 'Email Service', 1000, 628, 200, 50)
    ext(p, 'O2', 'Store Owner', 1250, 628, 170, 50)

    store(p, 'D3', 'D3', 'Private 3D Assets (furniture-models)', 1160, 60, 400, 44)
    store(p, 'D6', 'D6', 'Catalogue Posters (product-posters, public)', 1160, 160, 400, 44)
    store(p, 'D2', 'D2', 'product_assets: glb · poster · last_accessed_at · expiry_notice_at', 1160, 420, 400, 60)
    store(p, 'D4', 'D4', 'admin_audit', 1160, 880, 400, 44)

    p.edge('O', 'P71', '.glb + width × depth × height', D, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('P71', 'P72', 'checked model + poster (WebP)', O, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('P72', 'D3', 'model (signed upload)', O, exit=(1, 0.2), entry=(0, 0.5), points=[(1040, 102.8), (1040, 82)])
    p.edge('P72', 'D6', 'poster, named by its content', O, exit=(1, 0.8), entry=(0, 0.5), points=[(1040, 141.2), (1040, 182)])
    p.edge('P72', 'D2', 'asset rows (glb, poster)', O, exit=(1, 0.95), entry=(0, 0.3), points=[(1090, 150.8), (1090, 438)])
    p.edge('D2', 'P21', 'poster path (published only)', O, exit=(0, 0.6), entry=(1, 0.5), points=[(700, 456), (700, 422)])
    p.edge('D6', 'P21', 'poster image (cached a year)', O, exit=(0.3, 1), entry=(1, 0.2), points=[(1280, 360), (660, 360), (660, 402.8)])
    p.edge('P21', 'B', 'card: picture, price, 3D badge', O, exit=(0, 0.5), entry=(1, 0.5))
    p.edge('B', 'R5', 'View in 3D / AR', O, exit=(0.8, 1), entry=(0, 0.5), points=[(176, 548)])
    p.edge('R5', 'D2', 'last use (after a signed URL)', O, exit=(1, 0.5), entry=(0.2, 1), points=[(1240, 548)])
    p.edge('A', 'P81', 'open 3D Files', D, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('D2', 'P81', 'admin_model_lifecycle(): last used, idle days, notice, eligible', O, exit=(0.95, 1), entry=(1, 0.6),
           points=[(1540, 718.4)])
    p.edge('A', 'P82', 'Delete Model (typed DELETE)', D, exit=(0.8, 1), entry=(0, 0.5), points=[(176, 842)])
    p.edge('P82', 'D3', 'delete file (re-checked)', O, exit=(1, 0.1), entry=(1, 0.5), points=[(1600, 816.4), (1600, 82)])
    p.edge('P82', 'D6', 'delete its poster', O, exit=(1, 0.3), entry=(1, 0.8), points=[(1580, 829.2), (1580, 195.2)])
    p.edge('P82', 'D2', 'delete rows (re-checked; product kept)', O, exit=(0.8, 0), entry=(0.8, 1), points=[(912, 760), (1480, 760)])
    p.edge('P82', 'D4', 'model.deleted_stale', O, exit=(1, 0.9), entry=(0, 0.5))
    p.edge('D2', 'P83', 'models due a notice', O, exit=(0.25, 1), entry=(0.667, 0), points=[(1260, 575), (880, 575)])
    p.edge('P83', 'D2', 'expiry_notice_at (only if sent)', O, exit=(1, 0.25), entry=(0.325, 1), points=[(1290, 616)])
    p.edge('P83', 'EM', 'one email per shop', O, exit=(1, 0.75), entry=(0, 0.4))
    p.edge('EM', 'O2', 'keep it, or deletable from a date', O, exit=(1, 0.5), entry=(0, 0.5))
    p.node('note', '<b>Idle, not old:</b> last used = the later of upload and last access. Eligible at 365 days AND a notice '
                   'emailed to the shop 30+ days earlier (0013), decided by the database at the moment of deletion. The owner keeps a '
                   'model by opening it or pressing Keep 3D model (a use). Nothing is deleted automatically; the product, its '
                   'dimensions and orders are never deleted.',
           NOTE, 330, 870, 360, 100)
    return p


def level2_orders():
    p = Page('dfd-2-p10', 'Level 2 — 10.0 Orders & Payments', 1760, 1100)
    p.node('title', 'Level 2 DFD — Process 10.0 Orders &amp; Payments', TITLE, 40, 10, 800, 30)
    ext(p, 'B', 'Buyer', 40, 150, 160, 580)
    ext(p, 'O', 'Store Owner', 1560, 300, 160, 460)
    ext(p, 'PP', 'PayPal / Maya (detail: 10.9–10.13, 10.14–10.17)', 760, 20, 300, 60)
    ext(p, 'EM', 'Email Service', 1170, 910, 230, 64)
    ref(p, 'R1', '1.0', 'Authentication &amp; Session', 40, 60, 200, 56)

    proc(p, 'P101', '10.1', 'Place / Cancel Order', 300, 150, 230)
    proc(p, 'P103', '10.3', 'Start Payment', 300, 330, 230)
    proc(p, 'P104', '10.4', 'Capture &amp; Record Payment', 300, 510, 230)
    proc(p, 'P108', '10.8', 'View Orders &amp; Receipts', 300, 690, 230)
    proc(p, 'P102', '10.2', 'Quote / Decline Request', 1170, 330, 230)
    proc(p, 'P105', '10.5', 'Fulfil &amp; Deliver', 1170, 510, 230)
    proc(p, 'P107', '10.7', 'Manage Store Billing', 1170, 690, 230)
    proc(p, 'P106', '10.6', 'Notify Parties', 760, 900, 300, 64)

    store(p, 'D2', 'D2', 'Products (price, stock)', 760, 150, 300, 44)
    store(p, 'D53c', 'D5.4', 'Payment Accounts (copy)', 760, 230, 300, 44)
    store(p, 'D51', 'D5.1', 'Orders', 760, 300, 300, 420)
    store(p, 'D52', 'D5.2', 'Payments &amp; Fees', 300, 800, 230, 44)
    store(p, 'D52c', 'D5.2', 'Payments &amp; Fees (copy)', 1170, 790, 230, 44)
    store(p, 'D53', 'D5.3', 'Store Payout', 1170, 850, 230, 44)

    # Buyer and owner.
    p.edge('B', 'P101', 'product, qty, delivery /<br>custom request / cancel', D, exit=(1, 0.0552), entry=(0, 0.5))
    p.edge('B', 'P103', 'pay order / approval link', D, exit=(1, 0.3655), entry=(0, 0.5))
    p.edge('B', 'P104', 'PayPal / Maya return / payment result', D, exit=(1, 0.6759), entry=(0, 0.5))
    p.edge('P108', 'B', 'orders, receipt', O, exit=(0, 0.3), entry=(1, 0.9641))
    p.edge('O', 'P102', 'quote (price, lead days) /<br>decline reason', S, exit=(0, 0.1348), entry=(1, 0.5))
    p.edge('O', 'P105', 'ready / out for delivery /<br>ready for pickup / delivered', S, exit=(0, 0.5261), entry=(1, 0.5))
    p.edge('O', 'P107', 'store type, days /<br>fees owed, Maya sales owed to you', D, exit=(0, 0.9174), entry=(1, 0.5))
    p.edge('P108', 'O', 'incoming orders', O, exit=(0, 0.9), entry=(0.5, 1),
           points=[(280, 747.6), (280, 1060), (1640, 1060)])

    # 10.1
    p.edge('P101', 'R1', 'session check', O, exit=(0.3, 0), entry=(1, 0.5), points=[(369, 88)])
    p.edge('D2', 'P101', 'price, stock', O, exit=(0, 0.3), entry=(1, 0.36))
    p.edge('P101', 'D2', 'stock hold / release', O, exit=(1, 0.55), entry=(0, 0.8))
    p.edge('P101', 'D51', 'new order', O, exit=(0.9, 1), entry=(0, 0.024), points=[(507, 310)])
    # 10.3 and 10.4 with PayPal (four lanes between the processes and the stores)
    p.edge('P103', 'PP', 'create order or checkout (payee per provider) / link', O + DIALOG, exit=(1, 0.3), entry=(0, 0.3),
           points=[(575, 349.2), (575, 38)], label_pos=0.75)
    p.edge('P104', 'PP', 'capture (PayPal) or re-read (Maya) / payment facts', O + DIALOG, exit=(1, 0.25), entry=(0, 0.75),
           points=[(610, 526), (610, 65)], label_pos=0.8)
    p.edge('D53c', 'P103', 'payee per provider', O, exit=(0, 0.5), entry=(0.95, 0), points=[(518.5, 252)])
    p.edge('D51', 'P103', 'amount due, stage', O, exit=(0, 0.186), entry=(1, 0.75), label_pos=-0.5)
    p.edge('P104', 'D51', 'status, amount paid, ETA', O, exit=(1, 0.6), entry=(0, 0.591))
    p.edge('P104', 'D52', 'payment + fee', O, exit=(1, 0.85), entry=(1, 0.5), points=[(545, 564.4), (545, 822)], label_pos=0.6)
    # 10.8
    p.edge('D51', 'P108', 'orders', O, exit=(0, 0.95), entry=(1, 0.14))
    p.edge('D52', 'P108', 'payments', O, exit=(0.5, 0), entry=(0.5, 1))
    # 10.2, 10.5, 10.7
    p.edge('D51', 'P102', 'requested orders', O, exit=(1, 0.1), entry=(0, 0.2))
    p.edge('P102', 'D51', 'quoted / declined', O, exit=(0, 0.55), entry=(1, 0.155))
    p.edge('P105', 'D51', 'order / delivery status', O, exit=(0, 0.4), entry=(1, 0.561))
    p.edge('D52c', 'P107', 'fee summary', O, exit=(0.5, 0), entry=(0.5, 1))
    p.edge('P107', 'D53', 'payout settings', O, exit=(1, 0.8), entry=(1, 0.5), points=[(1430, 741.2), (1430, 872)])
    # 10.6: events arrive on two buses, contacts come from D5.1, emails go out.
    p.edge('P101', 'P106', 'requested / cancelled', O, exit=(1, 0.95), entry=(0, 0.3), points=[(650, 210.8), (650, 919.2)],
           label_pos=0.8)
    p.edge('P104', 'P106', 'paid / deposit paid / unapplied', O, exit=(0.9, 1), entry=(0, 0.3),
           points=[(507, 600), (650, 600), (650, 919.2)], label_pos=0.3)
    p.edge('P102', 'P106', 'quoted / declined', O, exit=(0, 0.9), entry=(1, 0.2), points=[(1130, 387.6), (1130, 912.8)],
           label_pos=-0.66)
    p.edge('P105', 'P106', 'balance due / delivery step', O, exit=(0, 0.9), entry=(1, 0.2),
           points=[(1130, 567.6), (1130, 912.8)], label_pos=-0.52)
    p.edge('D51', 'P106', 'order contacts', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('P106', 'EM', 'receipt / update emails', O, exit=(1, 0.5), entry=(0, 0.34375))
    return p


def level2_maya():
    p = Page('dfd-2-maya', 'Level 2 — 10.14–10.17 Maya Checkout, Webhook & Payouts', 1620, 1000)
    p.node('title', 'Level 2 DFD — Maya as a second payment provider (0015)', TITLE, 40, 10, 900, 30)
    ext(p, 'B', 'Buyer', 40, 80, 170, 400)
    ext(p, 'A', 'Platform Admin', 40, 760, 170, 64)
    ext(p, 'MY', 'Maya', 1400, 150, 180, 380)
    ext(p, 'EM', 'Email Service', 1400, 590, 180, 64)
    ref(p, 'R7', '7.0', 'Store Portal', 1400, 790, 180, 56)
    proc(p, 'P1014', '10.14', 'Offer Payment Methods', 420, 80)
    proc(p, 'P1015', '10.15', 'Start Maya Checkout', 420, 230)
    proc(p, 'P1016', '10.16', 'Verify Maya Payment<br>(return or webhook; re-read)', 420, 400)
    proc(p, 'P1017', '10.17', 'Maya Setup &amp; Payouts<br>(admin only)', 420, 760)
    store(p, 'D54', 'D5.4', 'store_payment_accounts (provider = maya)', 880, 80, 380, 44)
    store(p, 'D52', 'D5.2', 'payment_attempts · payments', 880, 300, 380, 44)
    store(p, 'D55', 'D5.5', 'payment_webhook_events', 880, 480, 320, 44)
    store(p, 'D54b', 'D5.4', 'store_payment_accounts (copy)', 880, 700, 320, 44)
    store(p, 'D56', 'D5.6', 'store_remittances', 880, 800, 320, 44)

    p.edge('B', 'P1014', 'product page / the methods this shop takes', D, exit=(1, 0.08), entry=(0, 0.5))
    p.edge('D54', 'P1014', 'set up for Maya? (this environment)', S, exit=(0, 0.5), entry=(1, 0.5))
    p.edge('B', 'P1015', 'pay with Maya / Maya\'s page', D, exit=(1, 0.455), entry=(0, 0.5))
    p.edge('P1015', 'MY', 'create checkout (PUBLIC key): amount, fee, reference', S, exit=(1, 0.3), entry=(0, 0.25))
    p.edge('P1015', 'D52', 'attempt: reference, payee, fee mode', O, exit=(1, 0.8), entry=(0, 0.3))
    p.edge('MY', 'P1016', 'redirect (reference) · unsigned webhook', S, exit=(0, 0.72), entry=(1, 0.37))
    p.edge('P1016', 'MY', 're-read payment (SECRET key)', S, exit=(1, 0.8), entry=(0, 0.79))
    p.edge('B', 'P1016', 'back from Maya / paid · pending · failed · cancelled', D, exit=(1, 0.86), entry=(0, 0.35))
    p.edge('P1016', 'D52', 'attempt by reference / payment recorded once', D, exit=(0.8, 0), entry=(0, 0.7), points=[(612, 330.8)])
    p.edge('P1016', 'D55', 'claim (payment, status) once', O, exit=(1, 0.95), entry=(0, 0.5), points=[(840, 460.8), (840, 502)])
    p.edge('P1016', 'EM', 'paid / not completed / refund-needed emails', O, exit=(0.5, 1), entry=(0, 0.5), points=[(540, 622)])
    p.edge('A', 'P1017', 'enable Maya, record a payout / result', D, exit=(1, 0.5), entry=(0, 0.5))
    p.edge('P1017', 'D54b', 'platform collect or PayFac (sub-merchant)', O, exit=(1, 0.3), entry=(0, 0.5))
    p.edge('P1017', 'D56', 'payout to the store', O, exit=(1, 0.8), entry=(0, 0.5))
    p.edge('D56', 'R7', 'owed to the store, payouts', S, exit=(1, 0.5), entry=(0, 0.6))
    p.node('note', '<b>Who receives the money.</b> Platform collect (default): FurnishAR\'s Maya account receives the whole payment; '
                   'the fee is collected and the store\'s share is OWED to the store until a payout is recorded (D5.6). '
                   'PayFac only when Maya enables it: settled to the store\'s sub-merchant, fee accrued or expected, never "collected". '
                   'Maya webhooks are unsigned: every one is re-read with the secret key before anything is recorded.',
           NOTE, 40, 880, 1300, 90)
    return p


def device_flow():
    p = Page('flow-p4', 'Flow — Device Check & Recommendation (P4)', 1560, 900)
    p.node('title', 'P4 Device Check — measured facts to one recommended mode (A–E)', GROUP + 'fontSize=16;', 40, 10, 800, 30)
    p.node('U', 'Person on<br>/diagnose', EXTERNAL, 40, 300, 150, 70)
    p.node('AR', 'Run the AR check<br>one WebXR session, hit-test only', PROCESS, 260, 100, 230, 70)
    p.node('SEN', 'Camera, motion sensors<br>and scene quality<br>(4 frames)', PROCESS, 260, 295, 230, 80)
    p.node('AIB', 'Check AI camera capability<br>(optional tap)', PROCESS, 260, 500, 230, 70)
    p.node('ST', 'FurnishAR static files<br>/ort/ runtime · /ai/ test model', PAGE_ROUTE, 260, 690, 230, 70)
    p.node('F', 'assessCapabilities()<br>measured facts, on the phone', PROCESS, 560, 290, 230, 80)
    p.node('GPU', 'WebGPU adapter<br>+ a real inference?', DECISION, 580, 480, 170, 110)
    p.node('WG', 'WebGPU benchmark<br>2 warm-up + 12 timed', PROCESS, 830, 420, 200, 64)
    p.node('WA', 'WASM benchmark<br>2 warm-up + 12 timed', PROCESS, 830, 560, 200, 64)
    p.node('LV', 'AI level (p95)<br>gpu · realtime · single-frame · none', PROCESS, 1090, 490, 240, 70)
    p.node('ERR', 'Plain-language failure (no ONNX text);<br>everything else still works', ALERT, 1090, 690, 240, 70)
    p.node('REC', 'recommendExperience()<br>A · B · C · D · E<br>+ reason + fallback', OK, 1090, 280, 240, 100)
    p.node('REP', 'Technical report<br>(only if copied)<br>no identifiers,<br>no frames', PAGE_ROUTE, 1390, 285, 150, 90)

    p.edge('U', 'AR', 'tap', exit=(1, 0.1), entry=(0, 0.5), points=[(225, 307), (225, 135)])
    p.edge('U', 'SEN', 'tap')
    p.edge('U', 'AIB', 'tap', exit=(1, 0.9), entry=(0, 0.5), points=[(225, 363), (225, 535)])
    p.edge('AIB', 'ST', 'fetch after the tap / runtime + model', EDGE_ORTHO + DIALOG, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('AIB', 'GPU', 'navigator.gpu?')
    p.edge('GPU', 'WG', 'yes', exit=(0.5, 0), entry=(0, 0.5), points=[(665, 452)])
    p.edge('GPU', 'WA', 'no / failed', exit=(0.5, 1), entry=(0, 0.5), points=[(665, 592)])
    p.edge('WG', 'WA', 'not real time: measure CPU too', exit=(0.5, 1), entry=(0.5, 0))
    p.edge('WG', 'LV', 'faster measured backend', exit=(1, 0.5), entry=(0, 0.2), points=[(1060, 452), (1060, 504)])
    p.edge('WA', 'LV', '', exit=(1, 0.5), entry=(0, 0.8), points=[(1060, 592), (1060, 546)])
    p.edge('WA', 'ERR', 'both failed', exit=(0.5, 1), entry=(0, 0.5), points=[(930, 725)])
    p.edge('AR', 'F', 'session, hit test, tracked frames', exit=(1, 0.5), entry=(0.5, 0), points=[(675, 135)])
    p.edge('SEN', 'F', 'sensors')
    p.edge('LV', 'F', 'AI level', exit=(0.5, 0), entry=(1, 0.8), points=[(1210, 400), (810, 400), (810, 354)])
    p.edge('F', 'REC', 'facts', exit=(1, 0.4), entry=(0, 0.46))
    p.edge('REC', 'U', 'recommended mode, reason, fallback', exit=(0.5, 0), entry=(0.5, 0), points=[(1210, 60), (115, 60)])
    p.edge('REC', 'REP', '', EDGE_ORTHO + 'dashed=1;', exit=(1, 0.5), entry=(0, 0.5))
    p.node('legend', '<b>AI never overrides WebXR</b>: tracked AR is proven only by a session that hits real surfaces. '
                     'AI never produces a measurement. Levels are measured on this phone, never inferred from its model. '
                     'Nothing is uploaded: the runtime and model are downloaded from FurnishAR\'s own origin, only after the tap.',
           NOTE, 40, 800, 1000, 70)
    return p


def level3_authz():
    p = Page('dfd-3-53', 'Level 3 — 5.3 Authorize & Sign Object', 1500, 860)
    p.node('title', 'Level 3 DFD — Process 5.3 Authorize &amp; Sign Object', TITLE, 40, 10, 800, 30)
    ref(p, 'R52', '5.2', 'Verify Session', 20, 94, 190, 56)
    ref(p, 'R54', '5.4', 'Deliver Signed URL', 1240, 254, 200, 56)
    ref(p, 'R9', '9.0', 'Notifications / Alerts', 1240, 744, 200, 56)

    proc(p, 'P1', '5.3.1', 'Request Signature as User', 320, 90)
    proc(p, 'P2', '5.3.2', 'Check Platform Admin', 320, 250)
    proc(p, 'P3', '5.3.3', 'Check Store Membership', 320, 410)
    proc(p, 'P4', '5.3.4', 'Check Published &amp; Active', 320, 570)
    proc(p, 'P5', '5.3.5', 'Issue Signed URL (5 min)', 820, 250)
    proc(p, 'P6', '5.3.6', 'Classify Refusal', 820, 740)

    store(p, 'Da', 'D1.2', 'platform_admins', 20, 262, 200, 40)
    store(p, 'Db', 'D1.2', 'store_members', 20, 422, 200, 40)
    store(p, 'Dc', 'D2', 'products · stores · assets', 20, 582, 200, 40)
    store(p, 'D3', 'D3', 'Private 3D Assets (bucket)', 820, 90, 240, 44)

    p.edge('R52', 'P1', 'user token, object path', O)
    p.edge('P1', 'P2', 'uid, path', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('Da', 'P2', 'admin row?', O)
    p.edge('P2', 'P5', 'allowed: platform admin', O)
    p.edge('P2', 'P3', 'not an admin', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('Db', 'P3', 'member?', O)
    p.edge('P3', 'P5', 'allowed: own store (drafts too)', O, exit=(1, 0.5), entry=(0.33, 1), points=[(899, 442)])
    p.edge('P3', 'P4', 'not a member', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('Dc', 'P4', 'published? active?', O)
    p.edge('P4', 'P5', 'allowed: published piece', O, exit=(1, 0.3), entry=(0.67, 1), points=[(980.8, 589.2)])
    p.edge('P4', 'P6', 'refused', O, exit=(0.5, 1), entry=(0, 0.5), points=[(440, 772)])
    p.edge('P5', 'D3', 'sign request', O, exit=(0.3, 0), entry=(0.3, 1))
    p.edge('D3', 'P5', 'signed URL', O, exit=(0.7, 1), entry=(0.7, 0))
    p.edge('P5', 'R54', 'signed URL, expires in 300 s', O)
    p.edge('P6', 'R9', '403 unavailable / 502', O)
    p.node('note', '5.3.2–5.3.4 are the three rules of the storage policy <b>can_view_model(path)</b> '
                   '(migration 0007). They run inside the database as the user, so no browser or server code can skip them. '
                   'A refused file and a missing file get the same answer, so a store\'s drafts are never revealed.',
           NOTE, 1100, 420, 360, 120)
    return p


def level3_capture():
    p = Page('dfd-3-104', 'Level 3 — 10.4 Capture & Record Payment', 1600, 1080)
    p.node('title', 'Level 3 DFD — Process 10.4 Capture &amp; Record Payment', TITLE, 40, 10, 800, 30)
    ext(p, 'B', 'Buyer', 40, 120, 160, 440)
    ext(p, 'PP', 'PayPal', 1380, 120, 180, 300)
    ref(p, 'R106', '10.6', 'Notify Parties', 1340, 860, 220, 56)

    proc(p, 'P1', '10.4.1', 'Fetch PayPal Order', 320, 120)
    proc(p, 'P2', '10.4.2', 'Re-check Amount Due', 320, 300)
    proc(p, 'P3', '10.4.3', 'Match &amp; Capture', 780, 300)
    proc(p, 'P4', '10.4.4', 'Verify Recorder Secret', 780, 520)
    proc(p, 'P5', '10.4.5', 'Record Payment &amp; Advance Order', 780, 720, 280, 70)
    proc(p, 'P6', '10.4.6', 'Report Outcome', 320, 860)

    store(p, 'D51', 'D5.1', 'Orders', 260, 450, 190, 44)
    store(p, 'D53', 'D5.3', 'Store Payout', 470, 450, 200, 44)
    store(p, 'D54', 'D5.4', 'Recorder Secret Hash', 1240, 520, 260, 44)
    store(p, 'D52', 'D5.2', 'Payments &amp; Fees', 1240, 722, 260, 44)
    store(p, 'D2', 'D2', 'Products (stock)', 1240, 770, 260, 44)
    store(p, 'D51b', 'D5.1', 'Orders (copy)', 780, 880, 280, 44)

    p.edge('B', 'P1', 'PayPal order id (return)', O, exit=(1, 0.05), entry=(0, 0.5))
    p.edge('P1', 'PP', 'get order', O, exit=(1, 0.3), entry=(0, 0.1))
    p.edge('PP', 'P1', 'status, stage, amount, payee', O, exit=(0, 0.2), entry=(1, 0.8))
    p.edge('P1', 'P2', 'order id, stage', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('P1', 'P3', 'PayPal facts', O, exit=(0.9, 1), entry=(0.3, 0), points=[(536, 230), (852, 230)])
    p.edge('D51', 'P2', 'order (buyer, status, totals)', O, exit=(0.5, 0), entry=(0.25, 1), label_pos=0.55)
    p.edge('D53', 'P2', 'shop PayPal email', O, exit=(0.25, 0), entry=(0.8333, 1), label_pos=0.55)
    p.edge('P2', 'P3', 'stage, amount due, payee', O)
    p.edge('P3', 'PP', 'capture', O, exit=(1, 0.3), entry=(0, 0.7))
    p.edge('PP', 'P3', 'capture id, capture status', O, exit=(0, 0.93), entry=(1, 0.8))
    p.edge('P3', 'B', 'mismatch / declined / pending', O, exit=(0.2, 1), entry=(1, 0.659), points=[(828, 410)],
           label_pos=-0.55)
    p.edge('P3', 'P4', 'capture facts + server secret', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('D54', 'P4', 'SHA-256 of secret', O, exit=(0, 0.5), entry=(1, 0.5))
    p.edge('P4', 'P5', 'verified capture', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('D52', 'P5', 'capture already recorded?', O, exit=(0, 0.2), entry=(1, 0.15))
    p.edge('P5', 'D52', 'payment + 10% fee share', O, exit=(1, 0.5), entry=(0, 0.75))
    p.edge('P5', 'D2', 'restock expired hold', O, exit=(1, 0.85), entry=(0, 0.216))
    p.edge('P5', 'D51b', 'status, amount paid, paid_at', O, exit=(0.5, 1), entry=(0.5, 0))
    p.edge('P5', 'P6', 'status, applied, duplicate', O, exit=(0, 0.5), entry=(0.5, 0), points=[(440, 755)])
    p.edge('P6', 'B', 'payment result', O, exit=(0, 0.5), entry=(0.5, 1), points=[(120, 892)])
    p.edge('P6', 'R106', 'paid / deposit paid / unapplied', O, exit=(0.5, 1), entry=(0.5, 1), points=[(440, 960), (1450, 960)])
    p.node('note', '10.4.2 runs <b>begin_payment</b> as the buyer, which also releases expired stock holds. '
                   '10.4.4–10.4.5 are <b>record_capture</b>: only the server knows the secret, the payee must be the shop, '
                   'and a repeated capture id is answered rather than recorded twice.',
           NOTE, 40, 990, 900, 60)
    return p


def main():
    pages = [level0(), level1(), level2_auth(), level2_google(), level2_access(), level2_lifecycle(), level2_orders(), level2_paypal(),
             level2_maya(), level3_authz(), level3_capture(), access3d(), payments(), device_flow(), usecases()]
    DRAWIO.write_text('<mxfile host="app.diagrams.net" modified="2026-09-24T00:00:00.000Z" '
                      f'agent="FurnishAR DFD v2" version="24.7.17" pages="{len(pages)}">\n'
                      + '\n'.join(page.xml() for page in pages) + '\n</mxfile>\n', encoding='utf-8')
    print(f'wrote {DRAWIO.relative_to(ROOT)} ({len(pages)} pages)')

    if '--preview' in sys.argv:
        out = Path(sys.argv[sys.argv.index('--preview') + 1])
        out.mkdir(parents=True, exist_ok=True)
        for page in pages:
            if page:
                (out / f'{page.pid}.svg').write_text(page.svg(), encoding='utf-8')
        print(f'previews in {out}')


if __name__ == '__main__':
    main()
