#!/usr/bin/env python3
"""
extract_attachments.py — DT-009
Extrae adjuntos PDF embebidos usando PyMuPDF (fitz).

Cubre dos mecanismos que pdfdetach + mutool pierden:
  1. EmbeddedFiles estándar (/EmbeddedFile)
  2. FileAttachment annotations (/Annot type 17) — el caso problemático

Uso:   python3 extract_attachments.py <input.pdf> <output_dir>
Output: JSON { "files": ["nombre1.pdf", ...], "error": null }
"""

import sys
import os
import json

import fitz  # pymupdf


def extract(pdf_path, out_dir):
    result = {"files": [], "error": None}
    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        result["error"] = str(e)
        print(json.dumps(result))
        return

    # ── Método 1: EmbeddedFiles estándar ──────────────────────────────────────
    try:
        for i in range(doc.embfile_count()):
            info = doc.embfile_info(i)
            name = info.get("filename") or info.get("name") or f"embed_{i}.pdf"
            if not name.lower().endswith(".pdf"):
                continue
            try:
                data = doc.embfile_get(i)
                dest = os.path.join(out_dir, name)
                with open(dest, "wb") as f:
                    f.write(data)
                result["files"].append(name)
            except Exception:
                pass
    except Exception:
        pass

    # ── Método 2: FileAttachment annotations (annot type 17) ─────────────────
    # Este es el mecanismo que pdfdetach y mutool NO detectan en todos los PDFs.
    try:
        for page in doc:
            for annot in page.annots():
                if annot.type[0] != 17:  # PDF_ANNOT_FILE_ATTACHMENT = 17
                    continue
                try:
                    fs = annot.file_info()
                    name = fs.get("filename") or fs.get("name") or "attachment.pdf"
                    if not name.lower().endswith(".pdf"):
                        continue
                    data = annot.get_file()
                    # Evitar sobrescribir archivo ya extraído por método 1
                    dest = os.path.join(out_dir, name)
                    if not os.path.exists(dest):
                        with open(dest, "wb") as f:
                            f.write(data)
                        result["files"].append(name)
                except Exception:
                    pass
    except Exception:
        pass

    doc.close()
    print(json.dumps(result))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"files": [], "error": "usage: extract_attachments.py <pdf> <outdir>"}))
        sys.exit(1)
    extract(sys.argv[1], sys.argv[2])
