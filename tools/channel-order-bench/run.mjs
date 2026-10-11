// Banc de l'ordre des canaux — voir run.sh. Sert les fichiers de /w et décode chaque fichier dans Chromium puis Firefox.
import http from "node:http"; import { readFileSync } from "node:fs"; import { chromium, firefox } from "playwright";
const types = { ".html": "text/html", ".mjs": "text/javascript", ".mkv": "video/x-matroska" };
const srv = http.createServer((q, r) => { const f = "/w" + (q.url === "/" ? "/index.html" : q.url); let d; try { d = readFileSync(f); } catch { r.writeHead(404); r.end(); return; } r.writeHead(200, { "content-type": types[f.slice(f.lastIndexOf("."))] ?? "application/octet-stream" }); r.end(d); }).listen(8099);
for (const [name, type] of [["chromium", chromium], ["firefox", firefox]]) {
  const b = await type.launch(); const p = await b.newPage(); await p.goto("http://127.0.0.1:8099/");
  const res = await p.evaluate(() => window.results); console.log(name, (await b.version()), JSON.stringify(res)); await b.close();
}
srv.close();
