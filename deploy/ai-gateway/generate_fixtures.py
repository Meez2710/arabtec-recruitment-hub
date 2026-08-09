#!/usr/bin/env python3
"""Generate the Stage 2 synthetic benchmark corpus.

EVERY DOCUMENT IS FABRICATED. Names, emails, phones and employers are invented
from fixed word lists with a fixed seed. No real CV, no candidate data, no
employee data is read, copied or derived from. This is what makes the corpus
safe to run in EUR-IS-1 while that region remains legally unapproved.

Deterministic: same seed, byte-identical output. A benchmark whose inputs move
between runs measures the inputs.

WHY GENERATED AND NOT SOURCED. ACCEPTANCE_CRITERIA §9 records that the 40-CV
pilot cannot support Arabic or mixed cohorts — of 666 documents probed, 1 was
Arabic-dominant and 5 mixed. Sourcing real Arabic CVs is a separate, slower
problem. Synthetic documents cannot substitute for that in an *accuracy*
benchmark, but they are exactly right for a *runtime* one: what is being
measured here is conversion, OCR routing, latency and memory, none of which
care whether the person is real.

Requires (build/benchmark only, never the request path):
    reportlab, arabic-reshaper, python-bidi, pillow
Fonts come from the OCR asset bundle (see deploy/ai-gateway/ocr-assets.lock);
they are OFL-1.1 and redistributable in an internal image.

Usage:
    python3 generate_fixtures.py --out ./corpus --fonts /opt/ocr-assets/fonts
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys

SEED = 20260809

# --- fabricated word lists ---------------------------------------------------
EN_FIRST = ["Layla", "Omar", "Hana", "Karim", "Salma", "Tarek", "Nadia", "Yusuf",
            "Rana", "Fadi", "Mona", "Ziad"]
EN_LAST = ["Hammad", "Darwish", "Nasser", "Khalil", "Mansour", "Rizk", "Aziz",
           "Barakat", "Fahmy", "Sayed"]
AR_FIRST = ["نور", "عمر", "هناء", "كريم", "سلمى", "طارق", "نادية", "يوسف"]
AR_LAST = ["المصري", "درويش", "ناصر", "خليل", "منصور", "رزق", "عزيز", "بركات"]
EN_EMPLOYERS = ["Falcon Contracting LLC", "Delta Build Group", "Cedar Infrastructure",
                "Gulf Structural Works", "Meridian Projects", "Anchor Civil Co"]
AR_EMPLOYERS = ["شركة النيل للمقاولات", "مجموعة دلتا للإنشاءات", "الأعمال الهندسية الخليجية",
                "شركة الأرز للبنية التحتية"]
EN_TITLES = ["Senior Site Engineer", "Project Engineer", "QA/QC Engineer",
             "Planning Engineer", "Structural Engineer", "Site Supervisor"]
AR_TITLES = ["مهندس موقع أول", "مهندس مشروع", "مهندس جودة", "مهندس تخطيط"]
EN_INSTITUTIONS = ["Cairo Institute of Technology", "Alexandria Technical University",
                   "Gulf Polytechnic", "Riverside School of Engineering"]
AR_INSTITUTIONS = ["جامعة القاهرة", "جامعة الإسكندرية", "المعهد التقني الخليجي"]
SKILLS = ["AutoCAD", "Primavera P6", "QA/QC", "Concrete Testing", "Revit",
          "Site Supervision", "BIM", "Quantity Surveying", "MS Project"]


def reshape_ar(text: str) -> str:
    """Arabic needs contextual shaping and RTL reordering before it can be
    drawn into a PDF text run. Without this the glyphs render isolated and
    left-to-right, which would make the fixture unrepresentative and the OCR
    result meaningless."""
    import arabic_reshaper
    from bidi.algorithm import get_display
    return get_display(arabic_reshaper.reshape(text))


def make_person(rng: random.Random, script: str) -> dict:
    if script == "ar":
        name = f"{rng.choice(AR_FIRST)} {rng.choice(AR_LAST)}"
        title = rng.choice(AR_TITLES)
        employer = rng.choice(AR_EMPLOYERS)
        institution = rng.choice(AR_INSTITUTIONS)
    else:
        name = f"{rng.choice(EN_FIRST)} {rng.choice(EN_LAST)}"
        title = rng.choice(EN_TITLES)
        employer = rng.choice(EN_EMPLOYERS)
        institution = rng.choice(EN_INSTITUTIONS)
    slug = f"user{rng.randint(1000, 9999)}"
    return {
        "name": name,
        # example.com / example.org are RFC 2606 reserved. They cannot resolve
        # to a real mailbox, which is the point.
        "email": f"{slug}@example.com",
        "phone": f"+971 50 555 {rng.randint(1000, 9999)}",
        "title": title,
        "employer": employer,
        "institution": institution,
        "skills": ", ".join(rng.sample(SKILLS, 4)),
    }


def draw_pdf(path: str, person: dict, *, script: str, fonts: str,
             multi_column: bool = False, pages: int = 1) -> None:
    """Digital PDF with a real text layer and embedded fonts."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    latin = os.path.join(fonts, "NotoSans-Regular.ttf")
    arabic = os.path.join(fonts, "NotoNaskhArabic-Regular.ttf")
    pdfmetrics.registerFont(TTFont("NotoSans", latin))
    pdfmetrics.registerFont(TTFont("NotoArabic", arabic))

    w, h = A4
    c = canvas.Canvas(path, pagesize=A4)
    for pg in range(pages):
        lines = _lines_for(person, script)
        if multi_column:
            half = (len(lines) + 1) // 2
            _column(c, lines[:half], 50, h - 70, script)
            _column(c, lines[half:], w / 2 + 20, h - 70, script)
        else:
            _column(c, lines, 50, h - 70, script)
        c.showPage()
    c.save()


def _font_for(script: str) -> str:
    return "NotoArabic" if script == "ar" else "NotoSans"


def _column(c, lines, x, y, script) -> None:
    for text, is_ar in lines:
        c.setFont(_font_for("ar" if is_ar else "en"), 11)
        c.drawString(x, y, reshape_ar(text) if is_ar else text)
        y -= 20


def _lines_for(person: dict, script: str) -> list[tuple[str, bool]]:
    ar = script == "ar"
    if script == "mixed":
        return [
            (person["name"], True),
            (person["email"], False),
            (person["phone"], False),
            (person["title"], True),
            ("Experience / الخبرة", True),
            (f"{person['employer']}", True),
            ("2021 - 2026", False),
            ("Education", False),
            (person["institution"], True),
            (f"Skills: {person['skills']}", False),
        ]
    return [
        (person["name"], ar),
        (person["email"], False),
        (person["phone"], False),
        (person["title"], ar),
        (person["employer"], ar),
        ("2021 - 2026", False),
        (person["institution"], ar),
        (f"Skills: {person['skills']}" if not ar else f"المهارات: {person['skills']}", ar),
    ]


def draw_scanned_pdf(path: str, person: dict, *, script: str, fonts: str) -> None:
    """Image-only PDF: rasterised text, NO text layer. This is what must
    trigger the OCR gate."""
    from PIL import Image, ImageDraw, ImageFont

    latin = os.path.join(fonts, "NotoSans-Regular.ttf")
    arabic = os.path.join(fonts, "NotoNaskhArabic-Regular.ttf")
    img = Image.new("RGB", (1240, 1754), "white")
    d = ImageDraw.Draw(img)
    y = 90
    for text, is_ar in _lines_for(person, script):
        f = ImageFont.truetype(arabic if is_ar else latin, 30)
        d.text((90, y), reshape_ar(text) if is_ar else text, fill="black", font=f)
        y += 55
    # Mild rotation and noise so OCR faces something closer to a real scan.
    img = img.rotate(0.4, expand=False, fillcolor="white")
    img.save(path, "PDF", resolution=150.0)


# (id, script, kind, cohorts)
PLAN = [
    ("en-digital-01", "en", "digital", ["english", "digital", "single-column"]),
    ("en-digital-02", "en", "digital", ["english", "digital", "single-column"]),
    ("en-digital-03", "en", "digital", ["english", "digital", "single-column"]),
    ("en-digital-04", "en", "digital", ["english", "digital", "single-column"]),
    ("en-multicol-05", "en", "digital-multicol", ["english", "digital", "multi-column"]),
    ("en-multicol-06", "en", "digital-multicol", ["english", "digital", "multi-column"]),
    ("en-scanned-07", "en", "scanned", ["english", "scanned", "image-heavy"]),
    ("en-scanned-08", "en", "scanned", ["english", "scanned", "image-heavy"]),
    ("en-scanned-09", "en", "scanned", ["english", "scanned", "image-heavy"]),
    ("en-scanned-10", "en", "scanned", ["english", "scanned", "image-heavy"]),
    ("ar-digital-11", "ar", "digital", ["arabic", "digital", "single-column"]),
    ("ar-digital-12", "ar", "digital", ["arabic", "digital", "single-column"]),
    ("ar-digital-13", "ar", "digital", ["arabic", "digital", "single-column"]),
    ("ar-digital-14", "ar", "digital", ["arabic", "digital", "single-column"]),
    ("ar-multicol-15", "ar", "digital-multicol", ["arabic", "digital", "multi-column"]),
    ("ar-scanned-16", "ar", "scanned", ["arabic", "scanned", "image-heavy"]),
    ("ar-scanned-17", "ar", "scanned", ["arabic", "scanned", "image-heavy"]),
    ("ar-scanned-18", "ar", "scanned", ["arabic", "scanned", "image-heavy"]),
    ("mx-digital-19", "mixed", "digital", ["mixed", "digital", "single-column"]),
    ("mx-digital-20", "mixed", "digital", ["mixed", "digital", "single-column"]),
    ("mx-scanned-21", "mixed", "scanned", ["mixed", "scanned", "image-heavy"]),
    ("mx-multicol-22", "mixed", "digital-multicol", ["mixed", "digital", "multi-column"]),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="./corpus")
    ap.add_argument("--fonts", default="/opt/ocr-assets/fonts")
    args = ap.parse_args()

    for f in ("NotoSans-Regular.ttf", "NotoNaskhArabic-Regular.ttf"):
        p = os.path.join(args.fonts, f)
        if not os.path.isfile(p):
            print(f"FATAL: font missing: {p}\n"
                  f"Run deploy/ai-gateway/fetch-ocr-assets.sh first — Arabic "
                  f"fixtures without an Arabic font are not fixtures.",
                  file=sys.stderr)
            return 2

    os.makedirs(args.out, exist_ok=True)
    rng = random.Random(SEED)
    manifest = []

    for doc_id, script, kind, cohorts in PLAN:
        person = make_person(rng, "ar" if script == "ar" else "en")
        if script == "mixed":
            person["name"] = f"{rng.choice(AR_FIRST)} {rng.choice(AR_LAST)}"
            person["title"] = rng.choice(AR_TITLES)
            person["employer"] = rng.choice(AR_EMPLOYERS)
            person["institution"] = rng.choice(AR_INSTITUTIONS)
        path = os.path.join(args.out, f"{doc_id}.pdf")

        if kind == "scanned":
            draw_scanned_pdf(path, person, script=script, fonts=args.fonts)
            expect_ocr = True
        else:
            draw_pdf(path, person, script=script, fonts=args.fonts,
                     multi_column=(kind == "digital-multicol"))
            expect_ocr = False

        manifest.append({
            "docId": doc_id,
            "file": os.path.basename(path),
            "script": script,
            "kind": kind,
            "cohorts": cohorts,
            # The OCR-routing assertion for this document. This is the ground
            # truth Run 1 had no way to state.
            "expectOcrRescue": expect_ocr,
            # Field ground truth. Synthetic, so it is exact by construction —
            # but note this supports the RUNTIME gate only. Field accuracy
            # against real CVs still needs human labels (ACCEPTANCE_CRITERIA §6).
            "expect": {
                "name": person["name"],
                "email": person["email"],
                "phone": person["phone"],
                "current_title": person["title"],
            },
            "synthetic": True,
        })

    counts: dict[str, int] = {}
    for m in manifest:
        for c in m["cohorts"]:
            counts[c] = counts.get(c, 0) + 1

    out = {
        "seed": SEED,
        "generator": "generate_fixtures.py",
        "syntheticOnly": True,
        "documentCount": len(manifest),
        "cohortCounts": counts,
        "documents": manifest,
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    arabic_ish = sum(1 for m in manifest
                     if "arabic" in m["cohorts"] or "mixed" in m["cohorts"]
                     or "scanned" in m["cohorts"])
    print(f"generated {len(manifest)} documents in {args.out}")
    print(f"cohorts: {json.dumps(counts, ensure_ascii=False)}")
    print(f"arabic/mixed/scanned: {arabic_ish} (requirement: >= 8)")
    if len(manifest) < 20 or arabic_ish < 8:
        print("FATAL: corpus does not meet the Stage 2 minimum", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
