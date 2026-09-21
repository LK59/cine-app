import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * Un dossier de données jetable pour chaque exécution de la suite.
 *
 * `DATA_DIR` vaut par défaut `<cwd>/data`, et la commande de vérification monte le dépôt entier
 * dans le conteneur : sans ceci, tout test qui passait par `logError` écrivait dans le vrai
 * `data/logs/server.log`. Le 19/09, un quart de ce journal était des erreurs de doubles Vitest
 * (« No "tmdb" export is defined on the mock ») qu'on aurait lues comme des pannes du serveur.
 * Les tests qui ont besoin de leur propre dossier (`db`, `session`, `dbBackup`…) le posent
 * toujours eux-mêmes et l'emportent sur celui-ci.
 */
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cine-test-data-"));

export default defineConfig({
  // tsconfig.json sets "jsx": "preserve" (correct for Next.js's own SWC compiler, which does the
  // actual JSX transform) — Vite's default esbuild-based transform reads that same tsconfig and,
  // left on "preserve", fails to strip JSX at all in .tsx test files (an `esbuild.jsx` override
  // alone doesn't take precedence over the detected tsconfig). @vitejs/plugin-react handles JSX
  // transformation itself, independent of tsconfig's own jsx setting.
  plugins: [react()],
  test: {
    // Default to "node" (fast, no fake DOM) for the API/lib tests that make up most of the
    // suite. Component tests opt into jsdom individually via a
    // `// @vitest-environment jsdom` docblock at the top of the file, rather than paying the
    // jsdom setup cost across every test file.
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    /**
     * L'ancien défaut, écrit noir sur blanc plutôt que subi.
     *
     * Vitest 5 a retourné ce réglage : l'historique d'un double — qui l'a appelé, avec quoi — est
     * désormais effacé avant **chaque** test. C'est probablement le meilleur défaut, mais ce n'est
     * pas celui sous lequel ces 1 958 tests ont été écrits, et un test qui compte les appels
     * accumulés par un `beforeAll` changerait de résultat sans que rien ne le dise.
     *
     * La migration du 20/09/2026 avait une consigne : aucune régression. On fige donc le
     * comportement d'avant. Passer à `true` est une décision séparée, qui se prend en lisant les
     * tests qui en dépendent, pas en montant de version.
     */
    clearMocks: false,
    env: { DATA_DIR: TEST_DATA_DIR },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
