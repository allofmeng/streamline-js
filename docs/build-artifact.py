#!/usr/bin/env python3
"""Build a self-contained copy of the manual (README.md) for publishing as an Artifact.

The repo copy uses relative image paths (docs/media/foo.jpg) so it renders on
GitHub. A published Artifact has no origin to resolve those against, and its CSP
blocks external hosts anyway, so images must be inlined as data URIs.

Usage: python3 docs/build-artifact.py  ->  writes docs/.build/USER_MANUAL.md
"""
import base64
import pathlib
import re

DOCS = pathlib.Path(__file__).parent
ROOT = DOCS.parent
SRC = ROOT / "README.md"
OUT = DOCS / ".build" / "USER_MANUAL.md"

MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif"}


def inline(match):
    alt, path = match.group(1), match.group(2)
    src = ROOT / path
    if not src.exists():
        raise SystemExit(f"missing image: {src}")
    mime = MIME[src.suffix.lower()]
    b64 = base64.b64encode(src.read_bytes()).decode()
    return f"![{alt}](data:{mime};base64,{b64})"


def main():
    text = SRC.read_text(encoding="utf-8")
    text, n = re.subn(r"!\[([^\]]*)\]\((docs/media/[^)]+)\)", inline, text)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(text, encoding="utf-8")
    print(f"inlined {n} images -> {OUT} ({OUT.stat().st_size / 1_000_000:.1f} MB)")


if __name__ == "__main__":
    main()
