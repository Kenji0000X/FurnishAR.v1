#!/usr/bin/env python3
"""
Builds docs/FURNISHAR-DFD-V2.drawio: one draw.io file, five pages.

  1. Level 0 — Context DFD
  2. Level 1 — System DFD        (the hand-laid page already in the file, kept verbatim)
  3. Level 2 — Protected 3D Access
  4. Level 2 — Orders & Payments (P10)
  5. Use Case Diagram

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

    # ---------------------------------------------------------------- draw.io
    def xml(self):
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
        def text(x, y, label, size=12, weight='normal', anchor='middle', italic=False):
            lines = re.sub(r'<br\s*/?>', '\n', label).split('\n')
            lines = [unescape(re.sub('<[^>]+>', '', l)) for l in lines]
            y0 = y - (len(lines) - 1) * size * 0.6
            style = 'font-style:italic;' if italic else ''
            return ''.join(f'<text x="{x}" y="{y0 + i * size * 1.2 + size * 0.35}" font-size="{size}" '
                           f'font-weight="{weight}" text-anchor="{anchor}" style="{style}" '
                           f'font-family="Helvetica,Arial,sans-serif">{escape(l)}</text>' for i, l in enumerate(lines))

        def fill(style, key, default):
            m = re.search(key + r'=([^;]+)', style)
            return m.group(1) if m else default

        parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" '
                 f'viewBox="0 0 {self.width} {self.height}"><rect width="100%" height="100%" fill="#fff"/>',
                 '<defs><marker id="a" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">'
                 '<path d="M0,0 L10,4 L0,8 z" fill="#333"/></marker>'
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
                parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{f}" stroke="none"/>'
                             f'<path d="M{x},{y} H{x + w} M{x},{y + h} H{x + w}" stroke="{st}"/>')
            elif 'shape=note' in s:
                parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{f}" stroke="{st}"/>')
            elif s.startswith('text'):
                pass
            else:
                r = 10 if 'rounded=1' in s else 0
                parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{f}" stroke="{st}"{dash}/>')
            if s.startswith(('rounded=0;whiteSpace=wrap;html=1;fillColor=none', 'shape=note')) or 'verticalAlign=top;align=left' in s:
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
                for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
                    if x1 != x2 and y1 != y2:
                        horizontal_first = e['exit'] and e['exit'][1] in (0.5,) and e['exit'][0] in (0, 1) or \
                            (e['exit'] and 0 < e['exit'][1] < 1 and e['exit'][0] in (0, 1))
                        if (x1, y1) == pts[0] and not horizontal_first and e['exit'] is not None:
                            ortho.append((x1, y2))
                        else:
                            ortho.append((x2, y1))
                    ortho.append((x2, y2))
                pts = ortho
            d = 'M' + ' L'.join(f'{x:.1f},{y:.1f}' for x, y in pts)
            s = e['style']
            marker = '' if 'endArrow=none' in s else ('url(#t)' if 'endFill=0;endSize' in s else
                                                      ('url(#o)' if 'endArrow=open' in s else 'url(#a)'))
            dash = ' stroke-dasharray="6 4"' if 'dashed=1' in s else ''
            parts.append(f'<path d="{d}" fill="none" stroke="#333"{dash}' + (f' marker-end="{marker}"' if marker else '') + '/>')
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
    p.node('PP', 'PayPal<br>(shop\'s own account)', EXTERNAL, 1100, 110, 200, 70)
    p.node('X', 'Supabase<br>(Auth / Postgres / Storage)', EXTERNAL, 1140, 415, 220, 70)
    p.node('O', 'Store Owner', EXTERNAL, 140, 740, 200, 70)
    p.node('A', 'Platform Admin', EXTERNAL, 1100, 740, 200, 70)

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

    p.edge('SYS', 'PP', 'create / capture order<br>(payee = shop)', S, exit=(0.8, 0.1), entry=(0, 0.6), label_pos=-0.35)
    p.edge('PP', 'SYS', 'approval / capture result', S, exit=(0.2, 1), entry=(0.93, 0.25), label_pos=-0.3)
    p.edge('B', 'PP', 'approves & pays the shop directly', EDGE_ORTHO, exit=(0.1, 0), entry=(0.5, 0),
           points=[(58, 60), (1200, 60)])

    p.edge('SYS', 'E', 'confirmation / order<br>email requests', S, exit=(0.15, 0.15), entry=(1, 0.6))
    p.edge('E', 'B', 'confirmation link, receipt,<br>quote, balance due', EDGE_ORTHO, exit=(0.2, 1), entry=(0.9, 0))
    p.edge('E', 'O', 'new order /<br>deposit paid', EDGE_ORTHO, exit=(0.9, 1), entry=(0.9, 0), label_pos=0.55)

    p.node('legend', '<b>Notation</b><br>Blue box = external entity<br>Circle = the whole system (process 0)<br>'
                     'Arrow = data flow, labelled with what moves',
           NOTE, 560, 800, 280, 90)
    return p


# =========================================================================
# 3. Level 2 — Protected 3D access
# =========================================================================
def access3d():
    p = Page('level-2-3d', 'Level 2 — Protected 3D Access', 1560, 820)
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
    p = Page('level-2-p10', 'Level 2 — Orders & Payments (P10)', 1400, 1000)
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


def main():
    source = DRAWIO.read_text(encoding='utf-8')
    diagrams = re.findall(r'<diagram [^>]*>.*?</diagram>', source, flags=re.S)
    level1 = next(d for d in diagrams if 'id="furnishar-dfd-v2"' in d)
    level1 = re.sub(r'name="[^"]*"', 'name="Level 1 — System DFD"', level1, count=1)

    pages = [level0(), None, access3d(), payments(), usecases()]
    body = [level1 if page is None else page.xml() for page in pages]
    DRAWIO.write_text('<mxfile host="app.diagrams.net" modified="2026-09-24T00:00:00.000Z" '
                      'agent="FurnishAR DFD v2" version="24.7.17" pages="5">\n' + '\n'.join(body) + '\n</mxfile>\n',
                      encoding='utf-8')
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
