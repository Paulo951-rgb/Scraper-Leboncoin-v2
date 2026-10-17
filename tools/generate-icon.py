#!/usr/bin/env python3
"""Génère build/icon.ico (multi-résolutions) et build/icon.png pour Vendra.

Identité : badge arrondi dégradé teal, trois barres de données ascendantes et un
chevron « V » (monogramme Vendra). Le rendu reproduit fidèlement build/logo.svg
afin que l'icône d'application, celle de l'installeur Windows et le logo de
l'interface partagent la même identité.

Rejouable : `python3 tools/generate-icon.py`.
Dépendance : Pillow (`pip install pillow`).
"""
import os
from PIL import Image, ImageDraw

SIZE = 256
RADIUS = 56

# Dégradé du badge : teal clair -> teal profond (cohérent avec logo.svg).
BG_TOP = (47, 143, 131)
BG_BOTTOM = (18, 63, 58)
ACCENT = (240, 180, 41)


def _chevron_points(cx, top_y, half_top, bottom_y, half_bottom, notch):
    """Points d'un chevron « V » épais (pointe vers le bas)."""
    return [
        (cx - half_top, top_y),
        (cx - half_top + notch, top_y),
        (cx, bottom_y),
        (cx + half_top - notch, top_y),
        (cx + half_top, top_y),
        (cx + half_bottom, bottom_y + (bottom_y - top_y) * 0.55),
        (cx, bottom_y + (bottom_y - top_y) * 0.95),
        (cx - half_bottom, bottom_y + (bottom_y - top_y) * 0.55),
    ]


def build_image(size=SIZE):
    # Supersampling x4 : lisse les bords du chevron et des barres (l'icône est
    # utilisée jusqu'à 16x16 dans la barre des tâches).
    ss = 4
    big = size * ss
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    for y in range(big):
        t = y / (big - 1)
        color = tuple(int(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t) for i in range(3))
        d.line([(0, y), (big, y)], fill=(*color, 255))

    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=RADIUS * ss, fill=255)
    img.putalpha(mask)

    d = ImageDraw.Draw(img)
    # Barres de données ascendantes.
    bars = [(60, 150, 20, 50, 0.45), (92, 122, 20, 78, 0.65), (124, 94, 20, 106, 0.85)]
    for (x, y, w, h, alpha) in bars:
        d.rounded_rectangle(
            [x * ss, y * ss, (x + w) * ss, (y + h) * ss],
            radius=6 * ss, fill=(255, 255, 255, int(255 * alpha)))

    # Chevron « V » (monogramme).
    d.polygon(
        [(px * ss, py * ss) for (px, py) in _chevron_points(135, 62, 51, 148, 26, 26)],
        fill=(255, 255, 255, 255))

    # Point d'accent.
    cx, cy, r = 196, 188, 16
    d.ellipse([(cx - r) * ss, (cy - r) * ss, (cx + r) * ss, (cy + r) * ss], fill=(*ACCENT, 255))

    return img.resize((size, size), Image.LANCZOS)


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'build')
    os.makedirs(out_dir, exist_ok=True)
    img = build_image()
    img.save(os.path.join(out_dir, 'icon.png'))
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_path = os.path.join(out_dir, 'icon.ico')
    img.save(ico_path, format='ICO', sizes=sizes)
    print(f'icon.ico written: {ico_path} ({os.path.getsize(ico_path)} bytes)')


if __name__ == '__main__':
    main()
