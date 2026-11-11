import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * L'adresse sous laquelle l'application sert ce build (`src/lib/immersionFiles.ts`). Sous `/api/`
 * pour que le service worker de l'application n'y touche pas — voir PROGRESS.md.
 */
const BASE = "/api/immersion/";

/**
 * Le transcodeur Basis **sans fabrication de code**.
 *
 * Tel que three le distribue, le fichier (la colle JavaScript d'emscripten, « embind ») fabrique ses
 * fonctions d'appel avec `new Function(...)` — à l'initialisation, pour chaque fonction exportée, et à
 * chaque appel d'une méthode JavaScript depuis le module. La politique de sécurité de l'application
 * (`script-src` sans `'unsafe-eval'`, `next.config.js`) l'interdit, y compris dans le travailleur que
 * `KTX2Loader` crée : aucune texture ne se décodait, et le chargement restait à 86 % — vu en production
 * le 11/11/2026, jamais ici : le serveur d'aperçu n'appliquait pas cette politique (il l'applique
 * depuis, voir `pageAddress`).
 *
 * Emscripten a une variante sans `new Function` (son option `DYNAMIC_EXECUTION=0`) : les deux fonctions
 * concernées sont remplacées ici par cette variante, écrite à la main d'après la sienne. Mêmes arguments,
 * mêmes conversions, mêmes destructeurs — une fonction fermée au lieu d'un texte évalué.
 *
 * Si three change ce fichier, les repères ne se trouvent plus et **le build échoue** : mieux qu'un
 * chargement qui ne finit pas.
 */
function withoutEval(source: string): string {
  const swap = (text: string, from: string, to: string, replacement: string) => {
    const start = text.indexOf(from);
    const end = text.indexOf(to, start);
    if (start < 0 || end < 0 || text.indexOf(from, start + 1) >= 0) throw new Error(`transcodeur Basis : repère introuvable ou ambigu (« ${from.slice(0, 40)}… ») — three a changé ce fichier, relire withoutEval`);
    return text.slice(0, start) + replacement + text.slice(end + to.length);
  };
  let out = swap(
    source,
    "function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){",
    "return createNamedFunction(humanName,invokerFn)}",
    `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc,isAsync){
      var argCount=argTypes.length;
      if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!")}
      var isClassMethodFunc=argTypes[1]!==null&&classType!==null;
      var needsDestructorStack=usesDestructorStack(argTypes);
      var returns=argTypes[0].name!=="void";
      var expected=argCount-2;
      var invokerFn=function(){
        if(arguments.length!==expected){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expected)}
        var destructors=needsDestructorStack?[]:null;
        var wired=new Array(expected);
        var callArgs=[cppTargetFunc];
        var thisWired;
        if(isClassMethodFunc){thisWired=argTypes[1]["toWireType"](destructors,this);callArgs.push(thisWired)}
        for(var i=0;i<expected;++i){wired[i]=argTypes[i+2]["toWireType"](destructors,arguments[i]);callArgs.push(wired[i])}
        var rv=cppInvokerFunc.apply(null,callArgs);
        if(needsDestructorStack){runDestructors(destructors)}
        else{for(var j=isClassMethodFunc?1:2;j<argTypes.length;++j){var param=j===1?thisWired:wired[j-2];if(argTypes[j].destructorFunction!==null){argTypes[j].destructorFunction(param)}}}
        if(returns){return argTypes[0]["fromWireType"](rv)}
      };
      return createNamedFunction(humanName,invokerFn)}`
  );
  out = swap(
    out,
    "var __emval_get_method_caller=(argCount,argTypes,kind)=>{",
    "return emval_addMethodCaller(createNamedFunction(functionName,invokerFunction))};",
    `var __emval_get_method_caller=(argCount,argTypes,kind)=>{
      var types=emval_lookupTypes(argCount,argTypes);
      var retType=types.shift();
      argCount--;
      var invokerFunction=function(obj,func,destructorsRef,args){
        var list=kind===0?[obj]:[];
        var offset=0;
        for(var i=0;i<argCount;++i){list.push(types[i].readValueFromPointer(args+offset));offset+=types[i]["argPackAdvance"]}
        var rv=kind===1?Reflect.construct(func,list):Function.prototype.call.apply(func,list);
        if(!retType.isVoid){return emval_returnValue(retType,destructorsRef,rv)}
      };
      var functionName=\`methodCaller<(\${types.map(t=>t.name).join(", ")}) => \${retType.name}>\`;
      return emval_addMethodCaller(createNamedFunction(functionName,invokerFunction))};`
  );
  if (out.includes("newFunc(Function")) throw new Error("transcodeur Basis : il reste une fabrication de code (newFunc(Function…)) — relire withoutEval");
  return out;
}

/**
 * Le transcodeur Basis de three, que `KTX2Loader` va chercher par adresse : pris dans
 * `node_modules` plutôt que recopié dans le dépôt, servi en développement et émis au build.
 */
const BASIS_DIR = path.join(here, "node_modules/three/examples/jsm/libs/basis");
const BASIS_FILES = ["basis_transcoder.js", "basis_transcoder.wasm"];
const readBasis = (name: string) => (name.endsWith(".js") ? Buffer.from(withoutEval(fs.readFileSync(path.join(BASIS_DIR, name), "utf8"))) : fs.readFileSync(path.join(BASIS_DIR, name)));

function basisTranscoder(): Plugin {
  const files = BASIS_FILES;
  const read = readBasis;
  return {
    name: "immersion-basis",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = files.find((f) => req.url?.split("?")[0] === `${BASE}basis/${f}`);
        if (!name) return next();
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        res.end(read(name));
      });
    },
    generateBundle() {
      for (const name of files) this.emitFile({ type: "asset", fileName: `basis/${name}`, source: read(name) });
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
      // L'aperçu sert le build **sous la politique de sécurité de l'application** : c'est sous elle que la
      // page tourne en production, et tout ce qu'elle interdit doit échouer ici aussi (le 11/11/2026, le
      // transcodeur de textures ne passait pas — voir `withoutEval` — et aucun test ne l'avait vu).
      loadApplicationPolicy();
      server.middlewares.use((_req, res, next) => {
        if (policy.value) res.setHeader("Content-Security-Policy", policy.value);
        next();
      });
      server.middlewares.use(redirect);
    },
  };
}

/**
 * La politique de sécurité que l'application pose sur toutes ses pages, lue à sa source
 * (`next.config.js`, à la racine du dépôt) — jamais recopiée ici, elle changerait sans nous. Elle arrive
 * un instant après le démarrage de l'aperçu (la fonction de Next est asynchrone), bien avant le premier
 * navigateur : l'en-tête lit la valeur courante.
 */
const policy = { value: null as string | null };
function loadApplicationPolicy(): void {
  try {
    const config = createRequire(import.meta.url)(path.join(here, "../next.config.js")) as { headers?: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    void config.headers?.().then((rules) => {
      policy.value = rules.find((rule) => rule.source === "/(.*)")?.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? null;
      console.log(policy.value ? "aperçu : politique de sécurité de l'application appliquée" : "aperçu : politique de sécurité introuvable dans next.config.js");
    });
  } catch (error) {
    console.warn(`aperçu : next.config.js illisible, pas de politique de sécurité (${error instanceof Error ? error.message : error})`);
  }
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

/**
 * Les paquets d'assets : les décors en **trois fichiers** au lieu de deux cents.
 *
 * Le pare-feu du serveur (CrowdSec, `http-crawl-non_statics`) bannit pour des heures, et de tout le serveur,
 * une adresse qui demande plus de ~40 noms de fichiers distincts « non statiques » en rafale — et `.ktx2`,
 * `.bin`, `.gltf`, `.json`, `.wasm` en sont tous. Le 11/11/2026 au matin, ouvrir le chalet (≈ 180 fichiers) a
 * banni un iPhone pour 4 h. Les fichiers sont donc regroupés ici, et la page les reprend dans ces paquets
 * (`src/lib/packs.ts`) : `THREE.Cache` les rend aux chargeurs de three sans une requête. Le garde-fou est le
 * scénario `15-requetes` (noms distincts et réponses 4xx d'un chargement, puis d'un second).
 *
 * Format : « LTPK », la longueur de l'en-tête (u32, petit-boutiste), l'en-tête en JSON
 * (`{ files: { "<chemin sous la base>": [début, longueur] } }`, positions comptées après l'en-tête), puis
 * les fichiers bout à bout. `postbuild.mjs` retire ensuite du build les fichiers empaquetés : l'image ne
 * grossit pas.
 */
const PACKS: { name: string; from: string[] }[] = [
  { name: "textures", from: ["assets/textures", "basis"] },
  { name: "modeles", from: ["assets/models"] },
  { name: "lumiere", from: ["assets/lightmaps", "assets/panorama"] },
];

/** Les fichiers d'un dossier empaqueté : `[chemin sous la base, contenu]`, dans un ordre stable. */
function packSources(dir: string): [string, Buffer][] {
  if (dir === "basis") return BASIS_FILES.map((name) => [`basis/${name}`, readBasis(name)]);
  const root = path.join(here, "public");
  const out: [string, Buffer][] = [];
  const walk = (full: string) => {
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(full, entry.name);
      if (entry.isDirectory()) walk(next);
      else out.push([path.relative(root, next).split(path.sep).join("/"), fs.readFileSync(next)]);
    }
  };
  walk(path.join(root, dir));
  return out;
}

let builtPacks: { name: string; data: Buffer }[] | null = null;
function buildPacks(): { name: string; data: Buffer }[] {
  if (builtPacks) return builtPacks;
  builtPacks = PACKS.map(({ name, from }) => {
    const sources = from.flatMap(packSources);
    const files: Record<string, [number, number]> = {};
    let offset = 0;
    for (const [file, bytes] of sources) {
      files[file] = [offset, bytes.length];
      offset += bytes.length;
    }
    const header = Buffer.from(JSON.stringify({ files }));
    const prefix = Buffer.alloc(8);
    prefix.write("LTPK", 0, "ascii");
    prefix.writeUInt32LE(header.length, 4);
    return { name, data: Buffer.concat([prefix, header, ...sources.map(([, bytes]) => bytes)]) };
  });
  return builtPacks;
}

function assetPacks(): Plugin {
  return {
    name: "immersion-packs",
    apply: "build",
    generateBundle() {
      for (const pack of buildPacks()) this.emitFile({ type: "asset", fileName: `packs/${pack.name}.bin`, source: pack.data });
    },
  };
}

export default defineConfig(({ command }) => ({
  base: BASE,
  plugins: [react(), basisTranscoder(), pageAddress(), assetPacks()],
  define: {
    __ASSETS_VERSION__: JSON.stringify(command === "build" ? assetsVersion() : "dev"),
    // Le nom et la taille de chaque paquet : la barre de chargement compte les octets reçus. En développement, aucun
    // paquet — les fichiers sont servis un à un par Vite.
    __PACKS__: JSON.stringify(command === "build" ? buildPacks().map((pack) => ({ name: pack.name, bytes: pack.data.length })) : []),
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
    // En développement, les routes de l'application viennent d'une instance jetable ; et la WebSocket des salons
    // (`SALONS_DEV_URL`, un conteneur `laterna-salons` de test) est relayée comme l'application la relaie en production
    // (`server-boot/salonsRelay.mjs` : `/api/salons/ws` → `/ws` du service). L'aperçu reprend ces relais.
    proxy:
      process.env.LATERNA_URL || process.env.SALONS_DEV_URL
        ? {
            ...(process.env.SALONS_DEV_URL
              ? { "^/api/salons/ws": { target: process.env.SALONS_DEV_URL, ws: true, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/salons\/ws/, "/ws") } }
              : {}),
            ...(process.env.LATERNA_URL
              ? {
                  "^/api/(?!immersion/|salons/ws)": { target: process.env.LATERNA_URL, changeOrigin: false },
                  "^/(_next|favicon|login)": { target: process.env.LATERNA_URL, changeOrigin: false },
                }
              : {}),
          }
        : undefined,
  },
}));
