// Empaquette le fil de calcul de Lumen serveur (`src/lib/lumenServer/worker.ts`) en un seul module ESM
// autonome, que `new Worker(chemin)` charge tel quel dans Node.
//
//   node tools/lumen-worker/build.mjs [sortie]        # défaut : server-boot/lumen-worker.mjs
//
// Pourquoi à part : le code du moteur est du TypeScript aux imports sans extension et aux alias `@/…`,
// que Node ne résout pas seul, et Next (Turbopack) n'émet pas d'entrée pour un `worker_threads` côté
// serveur — il compile les routes, pas un fichier qu'un `new Worker()` ouvrira par son chemin. rolldown
// est déjà là (vite, donc vitest, en dépend) : l'image le trouve à l'étape où elle passe les tests.
// L'étape 3 l'appellera dans le Dockerfile, après `npm run build`, et copiera la sortie dans l'image.
import { rolldown } from "rolldown";
import { resolve } from "node:path";
import { statSync } from "node:fs";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(root, process.argv[2] ?? "server-boot/lumen-worker.mjs");
const bundle = await rolldown({
  input: resolve(root, "src/lib/lumenServer/worker.ts"),
  platform: "node",
  resolve: { alias: { "@": resolve(root, "src") } },
  // Les modules de Node restent des imports ; tout le reste est embarqué.
  external: [/^node:/],
  // « use client » en tête de modules React que le graphe touche sans les garder (le tri les retire) :
  // sans objet dans un fil de calcul.
  onLog(level, log, handler) {
    if (log.code === "MODULE_LEVEL_DIRECTIVE") return;
    handler(level, log);
  },
});
await bundle.write({ file: output, format: "esm", codeSplitting: false });
await bundle.close();
console.log(`${output} : ${(statSync(output).size / 1024).toFixed(0)} Ko`);
