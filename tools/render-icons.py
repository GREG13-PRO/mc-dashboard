#!/usr/bin/env python3
"""Renders the app mark to every icon file the four platforms want.

The mark is defined once, in frontend/src/lib/logo.ts, as three gradient-filled
polygons. This is the same three polygons, kept in step by hand: the browser
draws the SVG version, and everywhere an SVG cannot go - a PWA manifest, an
apple-touch-icon, an Android launcher, a Windows installer - needs a PNG at a
specific size.

Written rather than reached for: this machine has no Node, no ImageMagick and no
Pillow, and adding a toolchain to draw three quadrilaterals is a worse trade
than a hundred lines of zlib and a point-in-polygon test. Rendering is 4x4
supersampled, which is what keeps the diagonals from stair-stepping at 32px.

Usage: python3 tools/render-icons.py
"""

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --------------------------------------------------------------- the mark

# Each face: polygon on the 32-grid, then the gradient's start point, end point,
# start colour and end colour. Drawn in this order, so the lifted top face lands
# last and overlaps nothing.
FACES = [
    ([(4, 11), (16, 18), (16, 30), (4, 23)], (4, 11), (16, 30), (0x8B, 0x3D, 0xFF), (0x4F, 0x18, 0xA6)),
    ([(28, 11), (16, 18), (16, 30), (28, 23)], (16, 11), (28, 30), (0xA8, 0x55, 0xF7), (0x73, 0x26, 0xD8)),
    ([(16, 2), (28, 9), (16, 16), (4, 9)], (4, 2), (28, 16), (0xE2, 0xD2, 0xFF), (0xA8, 0x55, 0xF7)),
]

GRID = 32.0
SS = 4  # supersampling factor per axis


def inside(polygon, x, y):
    """Even-odd crossing test. The faces are convex, but this costs nothing."""
    hit = False
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) / (y2 - y1) * (x2 - x1):
            hit = not hit
    return hit


def gradient(p1, p2, c1, c2, x, y):
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else ((x - p1[0]) * dx + (y - p1[1]) * dy) / length
    t = min(1.0, max(0.0, t))
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(c1, c2))


def render(size, scale=1.0, background=None):
    """RGBA pixels. `scale` shrinks the mark inside the canvas, which is what a
    maskable icon needs: Android crops to a circle, and a mark drawn edge to
    edge loses its corners."""
    pixels = bytearray()
    inset = size * (1.0 - scale) / 2.0
    span = size * scale
    for py in range(size):
        pixels.append(0)  # PNG filter byte: none
        for px in range(size):
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    # Sample centre, mapped from canvas pixels onto the 32-grid.
                    cx = (px + (sx + 0.5) / SS - inset) / span * GRID
                    cy = (py + (sy + 0.5) / SS - inset) / span * GRID
                    hit = None
                    for polygon, p1, p2, c1, c2 in FACES:
                        if inside(polygon, cx, cy):
                            hit = gradient(p1, p2, c1, c2, cx, cy)
                    if hit:
                        acc_r += hit[0]
                        acc_g += hit[1]
                        acc_b += hit[2]
                        acc_a += 255
            n = SS * SS
            alpha = acc_a / n
            if alpha > 0:
                # The colour average has to be over the covered samples only,
                # or an edge pixel darkens towards black as coverage drops.
                covered = acc_a / 255.0
                r, g, b = acc_r / covered, acc_g / covered, acc_b / covered
            else:
                r = g = b = 0.0
            if background is not None:
                # Composite onto an opaque field: iOS and Windows both put an
                # icon with holes in it on a background of their choosing.
                a = alpha / 255.0
                r = r * a + background[0] * (1 - a)
                g = g * a + background[1] * (1 - a)
                b = b * a + background[2] * (1 - a)
                alpha = 255
            pixels += bytes((int(round(r)), int(round(g)), int(round(b)), int(round(alpha))))
    return bytes(pixels)


# ---------------------------------------------------------------- PNG out


def chunk(tag, payload):
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def write_png(path, size, raw):
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    data = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)
    print(f"  {os.path.relpath(path, ROOT)}  {size}x{size}  {len(data)} B")


# The dark violet the app itself uses, so an opaque icon matches the app it
# opens rather than sitting on a colour chosen at random.
FIELD = (0x14, 0x10, 0x1B)

TARGETS = [
    # (path, size, scale, background)
    ("frontend/public/icon-192.png", 192, 1.0, None),
    ("frontend/public/icon-512.png", 512, 1.0, None),
    # 60% keeps the whole mark inside the circle Android may crop to.
    ("frontend/public/icon-maskable-512.png", 512, 0.6, FIELD),
    ("frontend/public/apple-touch-icon.png", 180, 0.82, FIELD),
    # electron-builder derives the .icns and .ico from this one.
    ("desktop/build/icon.png", 512, 0.82, FIELD),
    ("android/app/src/main/res/mipmap-mdpi/ic_launcher.png", 48, 0.82, FIELD),
    ("android/app/src/main/res/mipmap-hdpi/ic_launcher.png", 72, 0.82, FIELD),
    ("android/app/src/main/res/mipmap-xhdpi/ic_launcher.png", 96, 0.82, FIELD),
    ("android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png", 144, 0.82, FIELD),
    ("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png", 192, 0.82, FIELD),
]

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <defs>
    <linearGradient id="t" x1="4" y1="2" x2="28" y2="16" gradientUnits="userSpaceOnUse">
      <stop stop-color="#e2d2ff"/><stop offset="1" stop-color="#a855f7"/>
    </linearGradient>
    <linearGradient id="r" x1="16" y1="11" x2="28" y2="30" gradientUnits="userSpaceOnUse">
      <stop stop-color="#a855f7"/><stop offset="1" stop-color="#7326d8"/>
    </linearGradient>
    <linearGradient id="l" x1="4" y1="11" x2="16" y2="30" gradientUnits="userSpaceOnUse">
      <stop stop-color="#8b3dff"/><stop offset="1" stop-color="#4f18a6"/>
    </linearGradient>
  </defs>
  <path d="M4 11L16 18v12L4 23z" fill="url(#l)"/>
  <path d="M28 11L16 18v12l12-7z" fill="url(#r)"/>
  <path d="M16 2l12 7-12 7L4 9z" fill="url(#t)"/>
</svg>
"""

if __name__ == "__main__":
    print("mark ->")
    svg_path = os.path.join(ROOT, "frontend/public/logo.svg")
    with open(svg_path, "w", encoding="utf-8") as handle:
        handle.write(SVG)
    print(f"  {os.path.relpath(svg_path, ROOT)}  vector")
    for rel, size, scale, background in TARGETS:
        write_png(os.path.join(ROOT, rel), size, render(size, scale, background))
