// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sanitizeCss, sanitizeResource, staysInBook } from "@/lib/books/sanitize";

/**
 * La première des trois barrières contre le contenu d'un EPUB (DECISIONS.md §127) : chaque chapitre
 * et chaque feuille de style est réécrit avant d'exister comme page. Le chapitre d'essai rassemble ce
 * qu'un livre piégé peut tenter — script en ligne, script externe, attributs `on…`, lien `javascript:`,
 * image et feuille de style chez un tiers, `@import`, `url()` vers ailleurs, rafraîchissement vers un
 * autre site, cadre, objet, animation SVG qui réécrit un lien. Les deux autres barrières (cadre sans
 * `allow-scripts`, politique de sécurité de la page) sont éprouvées dans un vrai navigateur : voir
 * `tools/livres-securite/` et DECISIONS.md §127.
 */

const ORIGIN = "https://laterna.example";
const FIXTURE = fs.readFileSync(path.join(process.cwd(), "src/__tests__/fixtures/books/piege.xhtml"), "utf8");

describe("un chapitre piégé", () => {
  const out = sanitizeResource(FIXTURE, "application/xhtml+xml", ORIGIN);
  const doc = new DOMParser().parseFromString(out, "application/xhtml+xml");

  it("reste un XHTML lisible, texte compris", () => {
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.body?.textContent).toContain("Chapitre piégé");
    expect(doc.body?.textContent).toContain("Un lien interne");
  });
  it("n'a plus aucun script, cadre, objet ni rafraîchissement", () => {
    expect(doc.querySelectorAll("script, iframe, frame, object, embed, base, meta[http-equiv]")).toHaveLength(0);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/http-equiv/i);
  });
  it("n'a plus aucun attribut on…", () => {
    const withHandler = [...doc.querySelectorAll("*")].filter((el) => [...el.attributes].some((a) => a.name.toLowerCase().startsWith("on")));
    expect(withHandler).toHaveLength(0);
  });
  it("n'a plus aucune adresse `javascript:` ni aucune adresse hors du livre", () => {
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/evil\.example/);
    expect(out).not.toMatch(/\/\/cdn\.example/);
  });
  it("garde ce qui est au livre : les ressources `blob:` de cette origine, les ancres, les chemins relatifs, une image incrustée", () => {
    expect(doc.querySelector("img#cover")?.getAttribute("src")).toBe(`blob:${ORIGIN}/0000-1111`);
    expect(doc.querySelector("a#interne")?.getAttribute("href")).toBe("#note1");
    expect(doc.querySelector("a#relatif")?.getAttribute("href")).toBe("chapitre2.xhtml#debut");
    expect(doc.querySelector("img#incrustee")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(doc.querySelector("link[rel=stylesheet]")?.getAttribute("href")).toBe(`blob:${ORIGIN}/2222-3333`);
  });
  it("un `blob:` d'une autre origine sort du livre", () => {
    expect(doc.querySelector("img#autre-origine")?.hasAttribute("src")).toBe(false);
  });
});

describe("les feuilles de style", () => {
  it("retire `@import` et `url()` vers ailleurs, garde ceux du livre", () => {
    const css = `@import url("https://evil.example/a.css"); @import 'blob:${ORIGIN}/ok';
      body { background: url(https://evil.example/x.png) } h1 { background: url('blob:${ORIGIN}/img') }
      p { width: expression(alert(1)); -moz-binding: url(x.xml#b); behavior: url(x.htc) }`;
    const out = sanitizeCss(css, ORIGIN);
    expect(out).not.toMatch(/evil\.example/);
    expect(out).toContain(`@import 'blob:${ORIGIN}/ok'`);
    expect(out).toContain(`url('blob:${ORIGIN}/img')`);
    expect(out).not.toMatch(/expression\(/);
    expect(out).not.toMatch(/-moz-binding\s*:/);
    expect(out).not.toMatch(/(^|[\s;{])behavior\s*:/);
  });
  it("un SVG du livre perd ses scripts et ses gestionnaires", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)"><text>x</text></a><image href="https://evil.example/t.png"/></svg>`;
    const out = sanitizeResource(svg, "image/svg+xml", ORIGIN);
    expect(out).not.toMatch(/alert|evil\.example|onload/);
  });
  it("un XHTML mal formé est relu en HTML puis nettoyé de même", () => {
    const broken = `<html><body><p>texte<br></p><img src=x onerror="alert(1)"><script>alert(2)</script></body></html>`;
    const out = sanitizeResource(broken, "application/xhtml+xml", ORIGIN);
    expect(out).toContain("texte");
    expect(out).not.toMatch(/alert|onerror/);
  });
});

describe("staysInBook", () => {
  it.each([
    ["#note", true],
    ["chapitre.xhtml", true],
    ["", true],
    [`blob:${ORIGIN}/abc`, true],
    ["blob:https://ailleurs.example/abc", false],
    ["https://evil.example/x", false],
    ["//evil.example/x", false],
    ["  java\tscript:alert(1)", false],
    ["JAVASCRIPT:alert(1)", false],
    ["vbscript:x", false],
    ["data:text/html,<script>alert(1)</script>", false],
    ["data:image/svg+xml,<svg onload=alert(1)>", false],
    ["data:image/png;base64,AAAA", true],
    ["mailto:x@example.com", false],
    ["file:///etc/passwd", false],
  ])("%s → %s", (url, expected) => {
    expect(staysInBook(url, ORIGIN)).toBe(expected);
  });
});
