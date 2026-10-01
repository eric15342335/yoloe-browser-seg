from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "downloads" / "yoloe-browser-seg-source.zip"

EXCLUDED_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "models",
    "data",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".lighthouseci",
    "playwright-report",
    "test-results",
}


def excluded(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    parts = relative.parts
    if any(part in EXCLUDED_DIRS for part in parts):
        return True
    if ".venv" in parts:
        return True
    return path == OUTPUT


OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or excluded(path):
            continue
        archive.write(path, Path(ROOT.name) / path.relative_to(ROOT))

print(OUTPUT)
