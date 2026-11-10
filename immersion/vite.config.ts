import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * L'adresse sous laquelle l'application sert ce build (`src/lib/immersionFiles.ts`). Sous `/api/`
 * pour que le service worker de l'application n'y touche pas — voir PROGRESS.md.
 */
const BASE = "/api/immersion/";

/**
 * Le transcodeur Basis de three, que `KTX2Loader` va chercher par adresse : pris dans
 * `node_modules` plutôt que recopié dans le dépôt, servi en développement et émis au build.
 */
function basisTranscoder(): Plugin {
  const dir = path.join(here, "node_modules/three/examples/jsm/libs/basis");
  const files = ["basis_transcoder.js", "basis_transcoder.wasm"];
  return {
    name: "immersion-basis",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = files.find((f) => req.url?.split("?")[0] === `${BASE}basis/${f}`);
        if (!name) return next();
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        fs.createReadStream(path.join(dir, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const name of files) this.emitFile({ type: "asset", fileName: `basis/${name}`, source: fs.readFileSync(path.join(dir, name)) });
    },
  };
}

/** `/immersion` — l'adresse de la page en production — mène à la page en développement et en aperçu aussi. */
function pageAddress(): Plugin {
  const redirect = (req: { url?: string }, res: { statusCode: number; setHeader(name: string, value: string): void; end(): void }, next: () => void) => {
    if (req.url?.split("?")[0] !== "/immersion") return next();
    res.statusCode = 302;
    res.setHeader("Location", BASE + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""));
    res.end();
  };
  return {
    name: "immersion-page-address",
    configureServer(server) {
      server.middlewares.use(redirect);
    },
    configurePreviewServer(server) {
      server.middlewares.use(redirect);
    },
  };
}

/**
 * La version des assets 3D : une empreinte de leurs noms et de leurs tailles. Elle voyage dans
 * leurs adresses (`?v=`), ce qui permet au serveur de les dire `immutable` — voir `assetUrl`.
 */
function assetsVersion(): string {
  const root = path.join(here, "public/assets");
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(`${path.relative(root, full)}:${fs.statSync(full).size}\n`);
    }
  };
  walk(root);
  return hash.digest("hex").slice(0, 10);
}

export default defineConfig(({ command }) => ({
  base: BASE,
  plugins: [react(), basisTranscoder(), pageAddress()],
  define: {
    __ASSETS_VERSION__: JSON.stringify(command === "build" ? assetsVersion() : "dev"),
  },
  resolve: {
    // `@/` désigne le code de l'application (lecture seule) : seuls quelques modules sans
    // dépendance y sont pris — voir PROGRESS.md, « Lecture ».
    alias: { "@": path.resolve(here, "../src") },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    // Le code du build à part des assets 3D de `public/assets/`.
    assetsDir: "app",
    chunkSizeWarningLimit: 4000,
  },
  server: {
    host: "0.0.0.0",
    port: 5199,
    strictPort: true,
    fs: { allow: [path.resolve(here, "..")] },
    // En développement, les routes de l'application viennent d'une instance jetable.
    proxy: process.env.LATERNA_URL
      ? {
          "^/api/(?!immersion/)": { target: process.env.LATERNA_URL, changeOrigin: false },
          "^/(_next|favicon|login)": { target: process.env.LATERNA_URL, changeOrigin: false },
        }
      : undefined,
  },
}));
