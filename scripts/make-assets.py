"""Render original Tab Harbor icons and the Chrome Web Store promotional tile.

Development only: python -m pip install -r requirements-assets.txt
"""
from pathlib import Path
import shutil

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
INK = '#18343E'
TEAL = '#087E80'
PAPER = '#F7F6F1'
MINT = '#BDDCD3'


def make_icon(size):
    scale = 4
    image = Image.new('RGBA', (128 * scale, 128 * scale))
    draw = ImageDraw.Draw(image)

    def box(coords, radius, color):
        draw.rounded_rectangle(tuple(int(x * scale) for x in coords), radius=radius * scale, fill=color)

    box((0, 0, 127, 127), 29, INK)
    box((24, 23, 87, 88), 12, TEAL)
    box((35, 37, 102, 104), 12, PAPER)
    box((48, 51, 88, 59), 4, INK)
    box((48, 69, 80, 76), 3, TEAL)
    box((48, 86, 69, 92), 3, MINT)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def font(size, bold=False):
    candidates = [
        Path('C:/Windows/Fonts/segoeuib.ttf' if bold else 'C:/Windows/Fonts/segoeui.ttf'),
        Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
    ]
    for path in candidates:
        if path.is_file():
            return ImageFont.truetype(str(path), size)
    raise RuntimeError('A supported system font is required to render the promotional tile.')


icons = ROOT / 'extension' / 'icons'
assets = ROOT / 'docs' / 'store-assets'
icons.mkdir(parents=True, exist_ok=True)
assets.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 128):
    make_icon(size).save(icons / f'icon-{size}.png')
shutil.copyfile(icons / 'icon-128.png', assets / 'icon-128.png')

# Render at twice the required size and downsample for readable typography.
tile = Image.new('RGB', (880, 560), PAPER)
draw = ImageDraw.Draw(tile)
draw.rounded_rectangle((575, 40, 970, 520), radius=72, fill=MINT)
draw.rounded_rectangle((622, 105, 876, 475), radius=28, fill=TEAL)
draw.rounded_rectangle((584, 148, 838, 518), radius=28, fill=INK)
draw.rounded_rectangle((615, 199, 783, 214), radius=7, fill=PAPER)
draw.rounded_rectangle((615, 246, 746, 259), radius=6, fill=MINT)
draw.rounded_rectangle((615, 293, 769, 306), radius=6, fill=MINT)
logo = make_icon(104)
tile.paste(logo, (54, 56), logo)
draw.text((50, 201), 'Tab Harbor', font=font(64, True), fill=INK)
draw.text((54, 301), 'Save tabs.', font=font(35), fill=INK)
draw.text((54, 350), 'Come back ready.', font=font(35), fill=INK)
draw.text((54, 467), 'Your local tab collection', font=font(24), fill=TEAL)
tile.resize((440, 280), Image.Resampling.LANCZOS).save(assets / 'promo-440x280.png')
print(f'Created four extension icons and store assets in {assets}')
