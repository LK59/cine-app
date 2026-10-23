/**
 * L'enregistreur de l'empreinte de comportement du lecteur (voir README.md de ce dossier).
 *
 * Il relève, dans l'ordre où ils arrivent, tout ce qu'un lecteur produit et qu'un spectateur ou le
 * serveur verrait : les lignes du journal (par `fetch` ou par balise), les autres requêtes, les
 * écritures de stockage, les ordres donnés à l'élément `<video>` — et, aux étapes que le scénario
 * nomme, un résumé du DOM des commandes. Le tout est rendu déterministe (minuteries et horloge
 * simulées, identifiants tirés d'une suite fixe) plutôt que masqué : un délai ou une durée qui
 * change est justement ce qu'on veut voir.
 *
 * Ce module ne simule rien de propre au lecteur : chaque scénario donne ses réponses réseau et ses
 * doubles. Il ne fait que noter et normaliser.
 */
import fs from "fs";
import { act } from "@testing-library/react";
import { expect, vi } from "vitest";

export type Entry = unknown[];

/** Ce que le scénario répond à une requête qui n'est pas une ligne du journal. */
export type Responder = (url: string, init?: RequestInit) => unknown;

/** Les champs qui changent avec le code livré ou le moteur de test, pas avec le comportement. */
const VOLATILE_FIELDS = new Set(["build", "version", "lineId"]);

/** L'horloge de départ de chaque scénario : un mardi soir, fixe. */
export const T0 = Date.UTC(2026, 9, 20, 19, 0, 0);

/** Une suite pseudo-aléatoire fixe (mulberry32), pour `Math.random` et `crypto.randomUUID`. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseMaybe(text: unknown): unknown {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Retire les champs volatils (à toute profondeur : le bilan gardé dans `localStorage` les porte
 * aussi), et le nom du moteur de test de `agent`.
 */
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (VOLATILE_FIELDS.has(key)) continue;
    out[key] = key === "agent" && typeof inner === "string" ? "<agent>" : clean(inner);
  }
  return out;
}
const cleanFields = (fields: Record<string, unknown>) => clean(fields) as Record<string, unknown>;

/** Les propriétés de l'élément qu'on simule, gardées hors de l'élément pour noter les écritures. */
type MediaState = { currentTime: number; paused: boolean; src: string; duration: number; readyState: number; seeking: boolean; ended: boolean };
export type MediaFacts = Partial<Omit<MediaState, "src">>;
const MEDIA_FACTS = ["duration", "readyState", "seeking", "ended"] as const;
const mediaState = new WeakMap<HTMLMediaElement, MediaState>();
function stateOf(el: HTMLMediaElement): MediaState {
  let s = mediaState.get(el);
  if (!s) {
    s = { currentTime: 0, paused: true, src: "", duration: NaN, readyState: 0, seeking: false, ended: false };
    mediaState.set(el, s);
  }
  return s;
}

/** Le nom court d'un élément média dans le relevé : `video`, `video#2`… dans l'ordre d'apparition. */
const mediaNames = new WeakMap<HTMLMediaElement, string>();

export type Recorder = {
  entries: Entry[];
  /** Note un repère du scénario dans le fil. */
  step: (label: string) => void;
  /** Note un résumé du DOM des commandes (rôles, noms, états ARIA) sous un nom d'étape. */
  dom: (label: string, root?: ParentNode) => void;
  /** Pose l'état de l'élément sans le noter (ce que le navigateur ferait de lui-même). */
  media: (el: HTMLMediaElement, state: MediaFacts) => void;
  /** Avance les minuteries simulées, React compris. */
  advance: (ms: number) => Promise<void>;
  /** Laisse passer les promesses en attente, sans avancer l'horloge. */
  flush: (turns?: number) => Promise<void>;
  /** Le fil, prêt à comparer (les balises dont le corps est un Blob sont lues ici). */
  snapshot: () => Promise<Entry[]>;
  respond: (responder: Responder) => void;
  /** Mise au point : `EMPREINTE_DEBUG=<dossier>` y écrit le fil brut du scénario, même en échec. */
  debug: (name: string) => void;
  /**
   * Compare le fil à l'empreinte enregistrée du scénario en cours : un fichier texte par scénario,
   * une ligne par entrée, sous `__empreintes__/<famille>/`.
   */
  fingerprint: (family: string) => Promise<void>;
  uninstall: () => void;
};

const STORAGE_KEY_FILTER = /^cine/;

/**
 * Installe l'enregistreur : minuteries simulées, identifiants fixes, `fetch`, balise, stockage et
 * élément média relevés. À appeler dans `beforeEach`, `uninstall` dans `afterEach`.
 */
export function installRecorder(options: { seed?: number; storageKeys?: RegExp } = {}): Recorder {
  const entries: Entry[] = [];
  const pendingBlobs: { index: number; blob: Blob }[] = [];
  let responder: Responder = () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  const keys = options.storageKeys ?? STORAGE_KEY_FILTER;

  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"],
    now: T0,
  });

  const random = seeded(options.seed ?? 1);
  vi.spyOn(Math, "random").mockImplementation(random);
  let uuid = 0;
  const randomUUID = () => {
    uuid += 1;
    const hex = uuid.toString(16).padStart(8, "0");
    return `${hex}-0000-4000-8000-000000000000` as `${string}-${string}-${string}-${string}-${string}`;
  };
  if (typeof crypto !== "undefined") vi.spyOn(crypto, "randomUUID").mockImplementation(randomUUID);
  // Le nombre de cœurs entre dans `diag.cores` du bilan : 12 sur la machine où les empreintes ont été
  // enregistrées, 4 sur celle de la CI — toutes les empreintes natives y différaient. Fixé ici.
  if (typeof navigator !== "undefined" && "hardwareConcurrency" in navigator) {
    vi.spyOn(Object.getPrototypeOf(navigator), "hardwareConcurrency", "get").mockReturnValue(12);
  }

  // --- réseau ---------------------------------------------------------------------------------
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (url === "/api/player/log" && method === "POST") {
      const body = parseMaybe(init?.body) as { kind: string; fields: Record<string, unknown> };
      entries.push(["log", body.kind, cleanFields(body.fields ?? {})]);
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }
    const entry: Entry = ["fetch", method, url];
    if (init?.body !== undefined) entry.push(parseMaybe(init.body));
    entries.push(entry);
    // Une requête abandonnée (sous-titre quitté en vol, fermeture) : l'abandon est un comportement.
    // `AbortSignal.timeout` n'en est pas un tant qu'il ne tombe pas — noté seulement s'il tombe.
    init?.signal?.addEventListener("abort", () => void entries.push(["abort", method, url]), { once: true });
    return responder(url, init);
  });
  vi.stubGlobal("fetch", fetchStub);
  const beacon = vi.fn((url: string, data?: BodyInit | null) => {
    const entry: Entry = ["beacon", url];
    entries.push(entry);
    if (data instanceof Blob) pendingBlobs.push({ index: entries.length - 1, blob: data });
    else if (data !== undefined) entry.push(parseMaybe(data));
    return true;
  });
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
  Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });

  // --- stockage -------------------------------------------------------------------------------
  const realSet = Storage.prototype.setItem;
  const realRemove = Storage.prototype.removeItem;
  const areaOf = (s: Storage) => (s === window.sessionStorage ? "session" : "local");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
    if (keys.test(key)) entries.push(["storage", areaOf(this), "set", key, clean(parseMaybe(value))]);
    return realSet.call(this, key, value);
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key: string) {
    if (keys.test(key) && this.getItem(key) !== null) entries.push(["storage", areaOf(this), "remove", key]);
    return realRemove.call(this, key);
  });

  // --- élément média --------------------------------------------------------------------------
  let mediaCount = 0;
  const nameOf = (el: HTMLMediaElement) => {
    let name = mediaNames.get(el);
    if (!name) {
      mediaCount += 1;
      name = mediaCount === 1 ? el.localName : `${el.localName}#${mediaCount}`;
      mediaNames.set(el, name);
    }
    return name;
  };
  const proto = HTMLMediaElement.prototype;
  const saved = {
    play: Object.getOwnPropertyDescriptor(proto, "play"),
    pause: Object.getOwnPropertyDescriptor(proto, "pause"),
    load: Object.getOwnPropertyDescriptor(proto, "load"),
    currentTime: Object.getOwnPropertyDescriptor(proto, "currentTime"),
    paused: Object.getOwnPropertyDescriptor(proto, "paused"),
    src: Object.getOwnPropertyDescriptor(proto, "src"),
    duration: Object.getOwnPropertyDescriptor(proto, "duration"),
    readyState: Object.getOwnPropertyDescriptor(proto, "readyState"),
    seeking: Object.getOwnPropertyDescriptor(proto, "seeking"),
    ended: Object.getOwnPropertyDescriptor(proto, "ended"),
  };
  for (const fact of MEDIA_FACTS) {
    Object.defineProperty(proto, fact, {
      configurable: true,
      get(this: HTMLMediaElement) {
        return stateOf(this)[fact];
      },
    });
  }
  Object.defineProperty(proto, "play", {
    configurable: true,
    writable: true,
    value: function (this: HTMLMediaElement) {
      entries.push(["media", nameOf(this), "play"]);
      // Comme un navigateur : `play` est annoncé quand l'élément quittait la pause (`playing`
      // reste au scénario, qui dit quand l'image arrive).
      const was = stateOf(this).paused;
      stateOf(this).paused = false;
      if (was) queueMicrotask(() => void this.dispatchEvent(new Event("play")));
      return Promise.resolve();
    },
  });
  Object.defineProperty(proto, "pause", {
    configurable: true,
    writable: true,
    value: function (this: HTMLMediaElement) {
      entries.push(["media", nameOf(this), "pause"]);
      const was = stateOf(this).paused;
      stateOf(this).paused = true;
      if (!was) queueMicrotask(() => void this.dispatchEvent(new Event("pause")));
    },
  });
  Object.defineProperty(proto, "load", {
    configurable: true,
    writable: true,
    value: function (this: HTMLMediaElement) {
      entries.push(["media", nameOf(this), "load"]);
    },
  });
  Object.defineProperty(proto, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).currentTime;
    },
    set(this: HTMLMediaElement, value: number) {
      entries.push(["media", nameOf(this), "currentTime=", value]);
      stateOf(this).currentTime = value;
    },
  });
  Object.defineProperty(proto, "paused", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).paused;
    },
  });
  Object.defineProperty(proto, "src", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return stateOf(this).src;
    },
    set(this: HTMLMediaElement, value: string) {
      entries.push(["media", nameOf(this), "src=", value]);
      stateOf(this).src = value;
    },
  });

  const flush = async (turns = 12) => {
    for (let i = 0; i < turns; i++) await act(async () => void (await Promise.resolve()));
  };

  /** Le fil brut, écrit dans le dossier `EMPREINTE_DEBUG` s'il est donné (mise au point seulement). */
  const dump = (name: string) => {
    const dir = process.env.EMPREINTE_DEBUG;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/${name}.txt`, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };

  const snapshot = async () => {
    for (const { index, blob } of pendingBlobs) {
      const body = parseMaybe(await blob.text()) as { kind?: string; fields?: Record<string, unknown> };
      const entry = entries[index];
      if (body && typeof body === "object" && "kind" in body) entry.push(body.kind, cleanFields(body.fields ?? {}));
      else entry.push(body);
    }
    pendingBlobs.length = 0;
    return entries;
  };

  return {
    entries,
    step: (label) => {
      entries.push(["step", label]);
      dump("en-cours");
    },
    dom: (label, root = document.body) => void entries.push(["dom", label, summarizeDom(root)]),
    media: (el, state) => {
      Object.assign(stateOf(el), state);
    },
    advance: async (ms) => {
      await act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
      await flush(4);
    },
    flush,
    respond: (r) => void (responder = r),
    debug: (name) => dump(name),
    snapshot,
    fingerprint: async (family) => {
      const text = formatEntries(await snapshot());
      // Le dossier dit déjà la famille : le préfixe commun des `describe` (« empreinte — lecteur
      // natif : ») est retiré du nom.
      const name = slug((expect.getState().currentTestName ?? "scenario").replace(/^empreinte\s*—[^:>]*[:>]\s*/, ""));
      // Une empreinte absente ferait réécrire le fichier en silence et passer le test : un scénario
      // renommé ou un fichier effacé pendant un découpage ne prouverait plus rien. Elle n'est créée
      // que sur demande (`EMPREINTE_UPDATE=1`), dans un commit qui dit pourquoi.
      const file = `${process.cwd()}/src/__tests__/empreinte/__empreintes__/${family}/${name}.txt`;
      if (!fs.existsSync(file) && process.env.EMPREINTE_UPDATE !== "1") {
        throw new Error(`empreinte absente : ${family}/${name}.txt — EMPREINTE_UPDATE=1 pour la créer`);
      }
      await expect(text).toMatchFileSnapshot(`./__empreintes__/${family}/${name}.txt`);
    },
    uninstall: () => {
      for (const [name, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(proto, name, descriptor);
        else delete (proto as unknown as Record<string, unknown>)[name];
      }
      delete (navigator as { sendBeacon?: unknown }).sendBeacon;
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}

// --- le texte de l'empreinte --------------------------------------------------------------------

/**
 * Une ligne par entrée : le genre, puis ses champs (une chaîne telle quelle, le reste en JSON aux
 * clés dans l'ordre où le code les a écrites — un champ déplacé dans une ligne du journal est un
 * changement). Un résumé du DOM s'étale sur ses lignes, en retrait, pour que le diff les montre une
 * à une.
 */
export function formatEntries(entries: Entry[]): string {
  const out: string[] = [];
  for (const entry of entries) {
    const [kind, ...rest] = entry;
    if (kind === "dom") {
      out.push(`dom ${String(rest[0])}`);
      for (const line of rest[1] as string[]) out.push(`    ${line}`);
      continue;
    }
    out.push([String(kind), ...rest.map((v) => (typeof v === "string" ? v : JSON.stringify(v) ?? "undefined"))].join(" "));
  }
  return out.join("\n") + "\n";
}

/** Le nom de fichier d'un scénario : son nom complet, sans accents ni ponctuation. */
export function slug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

// --- le résumé du DOM -------------------------------------------------------------------------

const ARIA_STATES = ["aria-pressed", "aria-checked", "aria-selected", "aria-expanded", "aria-hidden", "aria-disabled", "aria-valuetext", "aria-current"];

/** Le nom qu'un spectateur (ou un lecteur d'écran) lirait : `aria-label`, sinon le texte, réduit. */
function nameOf(el: Element): string {
  const label = el.getAttribute("aria-label");
  if (label) return label;
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/**
 * Une ligne par élément interactif ou annoncé : boutons, champs, rôles explicites, régions vivantes,
 * dans l'ordre du document. Ce qui est caché par `hidden`/`inert` est noté comme tel plutôt
 * qu'omis : une commande qui disparaît est un changement.
 */
export function summarizeDom(root: ParentNode): string[] {
  const lines: string[] = [];
  const nodes = root.querySelectorAll("button, input, select, a[href], [role], [aria-live], video, track, img[alt], p, h1, h2, h3");
  for (const el of Array.from(nodes)) {
    const tag = el.localName;
    const role = el.getAttribute("role");
    const parts: string[] = [role ? `${tag}[role=${role}]` : tag];
    if (tag === "video" || tag === "track") {
      for (const attr of ["kind", "srclang", "label", "src", "data-src"]) {
        const v = el.getAttribute(attr);
        if (v !== null) parts.push(`${attr}=${v}`);
      }
      if (tag === "track") parts.push(`default=${(el as HTMLTrackElement).default}`);
      lines.push(parts.join(" "));
      continue;
    }
    // Un texte affiché : seulement hors d'un bouton (le bouton le porte déjà comme nom).
    if (tag === "p" || /^h[1-3]$/.test(tag)) {
      if (el.closest("button")) continue;
      const text = nameOf(el);
      if (text) lines.push(`${tag} ${JSON.stringify(text)}${el.closest("[hidden]") ? " hidden" : ""}`);
      continue;
    }
    const name = nameOf(el);
    if (name) parts.push(JSON.stringify(name));
    if (el instanceof HTMLInputElement) parts.push(`type=${el.type}`, `value=${el.value}`);
    for (const attr of ARIA_STATES) {
      const v = el.getAttribute(attr);
      if (v !== null) parts.push(`${attr.slice(5)}=${v}`);
    }
    if ((el as HTMLButtonElement).disabled) parts.push("disabled");
    if (el.closest("[inert]")) parts.push("inert");
    if (el.closest("[hidden]")) parts.push("hidden");
    lines.push(parts.join(" "));
  }
  return lines;
}
