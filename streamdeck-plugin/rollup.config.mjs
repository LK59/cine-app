import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

// Un seul fichier dans le dossier du plugin : l'appli Stream Deck lance `bin/plugin.js` avec son Node.
export default {
  input: "src/plugin.ts",
  output: { file: "fr.laterna.streamdeck.sdPlugin/bin/plugin.js", format: "esm", sourcemap: false },
  plugins: [typescript({ tsconfig: "./tsconfig.json" }), nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }), commonjs()],
  external: [/^node:/],
};
