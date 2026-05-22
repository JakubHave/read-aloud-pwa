#!/usr/bin/env python3
"""Render the speaker glyph from icon.svg to PNGs for the PWA manifest.

ImageMagick's SVG renderer mishandles the elliptical arcs in the source glyph,
so we draw it directly with Pillow. Renders at 4x and downsamples for
antialiasing.

Outputs (in the same directory as this script):
  icon-192.png            - any-purpose, rounded square
  icon-512.png            - any-purpose, rounded square
  icon-maskable-512.png   - maskable, full-bleed background, glyph inside safe zone
"""
import math
import os
from PIL import Image, ImageDraw

BG = (47, 90, 143, 255)        # #2f5a8f - accent
FG = (251, 250, 246, 255)      # #fbfaf6 - cream

# Glyph extent (from the original 24x24 SVG):
#   speaker body: x in [4, 13], y in [5, 19]
#   wave 1 (r=5):  center (12.93, 12),  rightmost x = 17.93
#   wave 2 (r=8.5): center (12.98, 12), rightmost x = 21.48
GLYPH_LEFT, GLYPH_RIGHT = 4.0, 21.48
GLYPH_TOP, GLYPH_BOTTOM = 5.0, 19.0
GLYPH_W = GLYPH_RIGHT - GLYPH_LEFT
GLYPH_H = GLYPH_BOTTOM - GLYPH_TOP
GLYPH_CX = (GLYPH_LEFT + GLYPH_RIGHT) / 2
GLYPH_CY = (GLYPH_TOP + GLYPH_BOTTOM) / 2


def draw_rounded_rect(draw, box, radius, fill):
    """Filled rounded rectangle (Pillow 7 lacks rounded_rectangle)."""
    x0, y0, x1, y1 = box
    draw.rectangle([x0 + radius, y0, x1 - radius, y1], fill=fill)
    draw.rectangle([x0, y0 + radius, x1, y1 - radius], fill=fill)
    draw.pieslice([x0, y0, x0 + 2 * radius, y0 + 2 * radius], 180, 270, fill=fill)
    draw.pieslice([x1 - 2 * radius, y0, x1, y0 + 2 * radius], 270, 360, fill=fill)
    draw.pieslice([x0, y1 - 2 * radius, x0 + 2 * radius, y1], 90, 180, fill=fill)
    draw.pieslice([x1 - 2 * radius, y1 - 2 * radius, x1, y1], 0, 90, fill=fill)


def stroke_arc(draw, center, radius, start_deg, end_deg, stroke_w, color):
    """Stroke an arc with Pillow's native draw.arc (clean antialiasing),
    plus filled circles at the endpoints to mimic stroke-linecap=round."""
    cx, cy = center
    bbox = (cx - radius, cy - radius, cx + radius, cy + radius)
    w = max(1, int(round(stroke_w)))
    draw.arc(bbox, start_deg, end_deg, fill=color, width=w)
    half = w / 2
    for deg in (start_deg, end_deg):
        rad = math.radians(deg)
        x = cx + radius * math.cos(rad)
        y = cy + radius * math.sin(rad)
        draw.ellipse((x - half, y - half, x + half, y + half), fill=color)


def render(size, glyph_fraction=0.60, rounded=True, supersample=4):
    """Render at supersample*size then downsample with LANCZOS for clean edges."""
    s = size * supersample
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if rounded:
        draw_rounded_rect(draw, (0, 0, s - 1, s - 1), int(s * 0.1875), BG)
    else:
        draw.rectangle((0, 0, s, s), fill=BG)

    target_w = s * glyph_fraction
    scale = target_w / GLYPH_W
    cx, cy = s / 2, s / 2

    def gx(x): return cx + (x - GLYPH_CX) * scale
    def gy(y): return cy + (y - GLYPH_CY) * scale

    # Speaker body polygon: M4 9 V15 H8 L13 19 V5 L8 9 Z
    body = [
        (gx(4),  gy(9)),
        (gx(4),  gy(15)),
        (gx(8),  gy(15)),
        (gx(13), gy(19)),
        (gx(13), gy(5)),
        (gx(8),  gy(9)),
    ]
    draw.polygon(body, fill=FG)

    stroke_w = 1.8 * scale

    # Wave 1: arc r=5 around center (12.93, 12), spanning ~ -44.4 deg .. +44.4 deg
    stroke_arc(draw, (gx(12.93), gy(12)), 5 * scale, -44.4,  44.4,  stroke_w, FG)
    # Wave 2: arc r=8.5 around center (12.98, 12), spanning ~ -44.9 deg .. +44.9 deg
    stroke_arc(draw, (gx(12.98), gy(12)), 8.5 * scale, -44.9, 44.9, stroke_w, FG)

    return img.resize((size, size), Image.LANCZOS)


def main():
    out_dir = os.path.dirname(os.path.abspath(__file__))
    targets = [
        ('icon-192.png',           192, 0.60, True),
        ('icon-512.png',           512, 0.60, True),
        # Maskable: full-bleed bg, glyph shrunk into the safe zone (~70%).
        ('icon-maskable-512.png',  512, 0.42, False),
    ]
    for name, size, frac, rounded in targets:
        img = render(size, glyph_fraction=frac, rounded=rounded)
        img.save(os.path.join(out_dir, name), optimize=True)
        print('wrote', name)


if __name__ == '__main__':
    main()
