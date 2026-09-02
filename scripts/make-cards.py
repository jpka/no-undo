#!/usr/bin/env python3
"""Render the demo segments that aren't terminal output.

Three of the four non-terminal segments can be generated: the title card, the
close card, and Beat 1's look at the document. The fourth — the approval card
in the browser — has to be captured by hand, because the approval server binds
an ephemeral port and the card is a live page.

    .demo/tools/venv/bin/python scripts/make-cards.py

Writes .demo/recordings/{title,beat1,close}.mp4 at 1080p30, styled to match the
terminal takes (dracula palette, JetBrains Mono) so the cut doesn't jump.

Needs pypdfium2 + pillow in the venv that scripts/record-demo.sh creates:
    .demo/tools/venv/bin/pip install pypdfium2 pillow
"""
import os
import subprocess
import sys
import tempfile

try:
    import pypdfium2 as pdfium
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("missing deps: .demo/tools/venv/bin/pip install pypdfium2 pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, ".demo/recordings")
FONTS = os.path.join(ROOT, ".demo/tools/fonts")
TMP = tempfile.mkdtemp(prefix="no-undo-cards-")

BG = (40, 42, 54)          # dracula background — same ground as the terminal
FG = (248, 248, 242)
DIM = (98, 114, 164)
CYAN = (139, 233, 253)
W, H = 1920, 1080

os.makedirs(OUT, exist_ok=True)
if not os.path.exists(os.path.join(FONTS, "JetBrainsMono-Regular.ttf")):
    sys.exit("fonts missing — run scripts/record-demo.sh once to fetch them")


def font(weight, size):
    return ImageFont.truetype(os.path.join(FONTS, f"JetBrainsMono-{weight}.ttf"), size)


def render_pdf(path, scale=2.5):
    return pdfium.PdfDocument(path)[0].render(scale=scale).to_pil()


def canvas():
    return Image.new("RGB", (W, H), BG)


def place(img, doc, max_w, max_h):
    """Fit a document onto the dark ground, centred, with a white page edge."""
    r = min(max_w / doc.width, max_h / doc.height)
    d = doc.resize((int(doc.width * r), int(doc.height * r)), Image.LANCZOS)
    x, y = (W - d.width) // 2, (H - d.height) // 2
    pad = 12
    ImageDraw.Draw(img).rectangle(
        [x - pad, y - pad, x + d.width + pad, y + d.height + pad], fill=(255, 255, 255))
    img.paste(d, (x, y))
    return img


def caption(img, text, sub=None):
    d = ImageDraw.Draw(img)
    d.text((60, H - 96), text, font=font("Bold", 30), fill=FG)
    if sub:
        d.text((60, H - 52), sub, font=font("Regular", 22), fill=DIM)
    return img


def card(lines, out):
    img = canvas()
    d = ImageDraw.Draw(img)
    y = (H - sum(size + gap for _, size, _, gap in lines)) // 2
    for text, size, colour, gap in lines:
        fnt = font("Bold" if size >= 54 else "Regular", size)
        w = d.textbbox((0, 0), text, font=fnt)[2]
        d.text(((W - w) // 2, y), text, font=fnt, fill=colour)
        y += size + gap
    img.save(out)


def encode(args, out, seconds):
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", *args, "-t", str(seconds), "-r", "30",
         "-c:v", "libx264", "-preset", "slow", "-crf", "18",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
        check=True)
    print(f"  -> {out}  ({seconds}s)")


# --- Beat 1 ----------------------------------------------------------------
# The messy source is generated, not committed; the assembled and redacted
# documents are the committed redaction probe artifacts, so this beat shows
# the same bytes the README's evidence table is drawn from.
messy_pdf = os.path.join(TMP, "messy.pdf")
subprocess.run(
    ["node", "-e",
     "import('./mcp/nutrient/messy-pdf.mjs').then(m=>"
     f"require('fs').writeFileSync({messy_pdf!r}, m.messyPdf(), 'latin1'))"],
    cwd=ROOT, check=True)

messy = render_pdf(messy_pdf)
orig = render_pdf(os.path.join(ROOT, "docs/fixtures/probe-original.pdf"))
appl = render_pdf(os.path.join(ROOT, "docs/fixtures/probe-applied.pdf"))

f1 = caption(place(canvas(), messy, 780, 940), "The source document",
             "Skewed baselines · OCR-hostile glyphs · no PO number on the page")
f1.save(f"{TMP}/b1-01.png")

BOX = (65, 380, 1420, 625)   # the shipment-contacts block
caption(place(canvas(), orig.crop(BOX), 1680, 700), "What the signers would have received",
        "Driver's mobile · driver's email · tractor VIN · AP contact").save(f"{TMP}/b1-02.png")
caption(place(canvas(), appl.crop(BOX), 1680, 700), "What actually goes out",
        "Redacted via Nutrient /build — then read back and verified absent").save(f"{TMP}/b1-03.png")

# Cuts land on the narration: the contacts block as the VO names what signers
# would see, the redacted block on "prove you removed it".
with open(f"{TMP}/b1.txt", "w") as f:
    f.write(f"file '{TMP}/b1-01.png'\nduration 8.7\n"
            f"file '{TMP}/b1-02.png'\nduration 17.4\n"
            f"file '{TMP}/b1-03.png'\nduration 5.0\n"
            f"file '{TMP}/b1-03.png'\n")
encode(["-f", "concat", "-safe", "0", "-i", f"{TMP}/b1.txt"], f"{OUT}/beat1.mp4", 31)

# --- Title and close -------------------------------------------------------
card([("No Undo", 96, FG, 34),
      ("An approval gate for the one step an agent can't take back", 38, DIM, 70),
      ("DevNetwork [API + Cloud + AI] Hackathon 2026", 28, CYAN, 0)], f"{TMP}/title.png")
encode(["-loop", "1", "-i", f"{TMP}/title.png"], f"{OUT}/title.mp4", 11)

card([("No Undo", 88, FG, 40),
      ("github.com/jpka/no-undo", 40, CYAN, 46),
      ("255 tests  ·  Foxit PDF Services + eSign  ·  Nutrient DWS", 30, DIM, 0)], f"{TMP}/close.png")
encode(["-loop", "1", "-i", f"{TMP}/close.png"], f"{OUT}/close.mp4", 41)
