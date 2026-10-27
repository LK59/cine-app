import streamDeck, { action, SingletonAction, type KeyAction, type KeyDownEvent, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { Buffer } from "node:buffer";

/**
 * Laterna sur le Stream Deck : combien de lectures en ce moment, qui regarde quoi, et le détail
 * d'une lecture — lus sur `/api/streamdeck/plays` avec le jeton créé dans Configuration →
 * Administration.
 *
 * Trois actions :
 * - « Lectures » : le nombre en cours. Appuyer ouvre la page des lectures (profil « Laterna »,
 *   livré avec le plugin) ;
 * - « Case » : une touche de cette page. Sa place sur l'appareil dit ce qu'elle montre — en liste,
 *   une lecture par touche et la dernière pour revenir ; sur une lecture, une facette par touche ;
 * - « Bandeau » : l'Infobar du Stream Deck Neo, un résumé de ce que la page montre.
 *
 * Le lecteur serveur est un chemin comme un autre, jamais un souci : seuls une attente, une erreur
 * ou une reconstruction récentes passent la lecture en orange — c'est le serveur qui en décide.
 */

type PlayPath = "appareil" | "serveur" | "télé" | "jellyfin";
interface Play {
  id: string;
  user: string;
  device: string;
  client: string;
  itemId: string | null;
  imageItemId: string | null;
  title: string;
  series: string | null;
  code: string | null;
  positionS: number | null;
  durationS: number | null;
  paused: boolean;
  path: PlayPath;
  video: string | null;
  audio: string | null;
  subtitle: string | null;
  streamMbps: number | null;
  incidents: { waits: number; errors: number; rebuilds: number; last: string | null };
  state: "ok" | "pause" | "souci";
}
interface Plays {
  at: number;
  count: number;
  trouble: boolean;
  plays: Play[];
}
type Settings = { url?: string; token?: string };
type Problem = "réglages" | "jeton" | "hors ligne" | null;
type View = { kind: "list"; page: number } | { kind: "detail"; playId: string };

/**
 * Le profil livré avec le plugin (`profiles/Laterna.streamDeckProfile`) : la page « Lectures » et le
 * détail, sur les huit touches du Neo et son Infobar. Créé dans l'appli Stream Deck et exporté — son
 * format n'est pas documenté. Le nom est son chemin dans le dossier du plugin, sans l'extension.
 */
const PROFILE = "profiles/Laterna";
const HAS_PROFILE = true;
const POLL_MS = 5_000;
const COLORS = { bg: "#0b0b0f", text: "#ffffff", muted: "#a1a1aa", faint: "#52525b", trouble: "#ff9f0a", gold: "#d4a64a" };
const PATH_LABEL: Record<PlayPath, string> = { appareil: "Appareil", serveur: "Serveur", "télé": "Télé", jellyfin: "Jellyfin" };

let settings: Settings = {};
let data: Plays | null = null;
let problem: Problem = "réglages";
let view: View = { kind: "list", page: 0 };
const posters = new Map<string, string | null>();
let timer: ReturnType<typeof setInterval> | null = null;
let visible = 0;

// ─── Données ──────────────────────────────────────────────────────────────────

function base(): string | null {
  const url = settings.url?.trim().replace(/\/+$/, "");
  return url && /^https?:\/\//.test(url) ? url : null;
}

async function poll(): Promise<void> {
  const url = base();
  if (!url || !settings.token) {
    problem = "réglages";
    data = null;
    return renderAll();
  }
  try {
    const res = await fetch(`${url}/api/streamdeck/plays`, { headers: { Authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(4_000) });
    if (res.status === 401) {
      problem = "jeton";
      data = null;
    } else if (!res.ok) {
      problem = "hors ligne";
    } else {
      data = (await res.json()) as Plays;
      problem = null;
      await loadPosters(url, data);
    }
  } catch {
    problem = "hors ligne";
  }
  // Une lecture qui s'arrête pendant qu'on regarde son détail : retour à la liste.
  if (view.kind === "detail" && !data?.plays.some((p) => p.id === (view as { playId: string }).playId)) view = { kind: "list", page: 0 };
  if (view.kind === "list" && view.page > 0 && view.page >= pageCount()) view = { kind: "list", page: 0 };
  await renderAll();
}

/** Les affiches des titres en cours, gardées tant qu'elles servent. */
async function loadPosters(url: string, plays: Plays): Promise<void> {
  const wanted = new Set(plays.plays.map((p) => p.imageItemId).filter((id): id is string => !!id));
  for (const id of posters.keys()) if (!wanted.has(id)) posters.delete(id);
  await Promise.all(
    [...wanted]
      .filter((id) => !posters.has(id))
      .map(async (id) => {
        try {
          const res = await fetch(`${url}/api/streamdeck/image?itemId=${id}`, { headers: { Authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(6_000) });
          if (!res.ok) return posters.set(id, null);
          const type = res.headers.get("content-type") ?? "image/jpeg";
          posters.set(id, `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`);
        } catch {
          /* réessayé au prochain passage */
        }
      })
  );
}

function startPolling(): void {
  if (timer) return;
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
}

function stopPolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ─── Dessin ───────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const svg = (body: string, bg = COLORS.bg) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${bg}"/>${body}</svg>`).toString("base64")}`;
const text = (x: number, y: number, value: string, size: number, color = COLORS.text, weight = 600, anchor = "middle") =>
  `<text x="${x}" y="${y}" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(value)}</text>`;

/** Couper sans déborder : la largeur d'un caractère vaut à peu près 0,55 fois sa taille. */
function fit(value: string, size: number, width = 132): string {
  const max = Math.max(3, Math.floor(width / (size * 0.55)));
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function lines(value: string, size: number, count: number, width = 132): string[] {
  const max = Math.max(3, Math.floor(width / (size * 0.55)));
  const out: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/)) {
    if ((line ? `${line} ${word}` : word).length <= max) line = line ? `${line} ${word}` : word;
    else {
      if (line) out.push(line);
      line = word;
    }
    if (out.length === count) break;
  }
  if (out.length < count && line) out.push(line);
  if (out.length === count && out.join(" ").length < value.length) out[count - 1] = fit(`${out[count - 1]}…`, size, width);
  return out.slice(0, count).map((l) => fit(l, size, width));
}

function clock(seconds: number | null): string {
  if (seconds == null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const percent = (p: Play) => (p.positionS != null && p.durationS ? Math.min(100, Math.round((p.positionS / p.durationS) * 100)) : null);
const accent = (p: Play) => (p.state === "souci" ? COLORS.trouble : COLORS.text);

function poster(p: Play, dim = 0.55): string {
  const image = p.imageItemId ? posters.get(p.imageItemId) : null;
  if (!image) return "";
  return `<image href="${image}" x="0" y="0" width="144" height="144" preserveAspectRatio="xMidYMid slice"/><rect width="144" height="144" fill="#000" opacity="${dim}"/>`;
}

function progressBar(p: Play): string {
  const pc = percent(p);
  if (pc == null) return "";
  return `<rect x="0" y="138" width="144" height="6" fill="#ffffff" opacity="0.2"/><rect x="0" y="138" width="${(144 * pc) / 100}" height="6" fill="${accent(p)}"/>`;
}

function problemKey(): string {
  const label = problem === "réglages" ? "Réglages" : problem === "jeton" ? "Jeton refusé" : "Hors ligne";
  return svg(text(72, 66, "Laterna", 22, COLORS.muted) + text(72, 96, label, 18, COLORS.trouble));
}

/** Le « L-faisceau » de Laterna (tools/brand/icon-32.svg, sans son fond), à la taille d'un coin de touche. */
const LOGO =
  `<defs><linearGradient id="beam" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#fbbf24" stop-opacity="0.85"/><stop offset="100%" stop-color="#fbbf24" stop-opacity="0.18"/></linearGradient></defs>` +
  `<g transform="translate(52 6) scale(0.078)"><polygon points="168,290 412,214 412,410 168,346" fill="url(#beam)"/><rect x="128" y="96" width="76" height="250" rx="20" fill="#f5f5f4"/></g>`;

function countKey(): string {
  if (problem && !data) return problemKey();
  const n = data?.count ?? 0;
  const color = n === 0 ? COLORS.faint : data?.trouble ? COLORS.trouble : COLORS.text;
  const label = n === 0 ? "aucune lecture" : n === 1 ? "lecture" : "lectures";
  return svg(LOGO + text(72, 96, String(n), 60, color, 700) + text(72, 126, label, 17, COLORS.muted, 500) + (problem ? `<circle cx="128" cy="16" r="6" fill="${COLORS.trouble}"/>` : ""));
}

const PER_PAGE = 7;
const pageCount = () => Math.max(1, Math.ceil((data?.plays.length ?? 0) / PER_PAGE));

function listKey(index: number): string {
  if (problem && !data) return index === 0 ? problemKey() : index === 7 ? backKey() : svg("");
  if (index === 7) return pageCount() > 1 && view.kind === "list" && view.page < pageCount() - 1 ? nextKey() : backKey();
  const page = view.kind === "list" ? view.page : 0;
  const p = data?.plays[page * PER_PAGE + index];
  if (!p) return index === 0 && !data?.plays.length ? svg(text(72, 78, "Aucune lecture", 17, COLORS.faint, 500)) : svg("");
  const subtitle = p.code ? `${p.code} · ${p.series ?? p.title}` : p.title;
  const badge = p.state === "souci" ? `<circle cx="128" cy="16" r="8" fill="${COLORS.trouble}"/>` : p.paused ? `<rect x="118" y="8" width="5" height="16" fill="#fff"/><rect x="128" y="8" width="5" height="16" fill="#fff"/>` : "";
  return svg(poster(p) + text(72, 104, fit(p.user, 24), 24, COLORS.text, 700) + text(72, 126, fit(subtitle, 13), 13, COLORS.muted, 500) + badge + progressBar(p));
}

const backKey = () => svg(text(72, 82, "←", 54, COLORS.text, 400) + text(72, 116, "Retour", 17, COLORS.muted, 500));
const nextKey = () => svg(text(72, 82, "→", 54, COLORS.text, 400) + text(72, 116, `Suite ${(view.kind === "list" ? view.page : 0) + 2}/${pageCount()}`, 17, COLORS.muted, 500));

function detailKey(index: number, p: Play): string {
  switch (index) {
    case 0: {
      const [l1, l2] = lines(p.series ? `${p.code ?? ""} ${p.title}` : p.title, 15, 2);
      return svg(poster(p, 0.45) + text(72, 30, fit(p.series ?? "", 14), 14, COLORS.muted, 500) + text(72, 108, l1 ?? "", 15) + text(72, 128, l2 ?? "", 15));
    }
    case 1:
      return svg(text(72, 58, fit(p.user, 26), 26, COLORS.text, 700) + text(72, 90, fit(p.device, 15), 15, COLORS.muted, 500) + text(72, 112, fit(p.client, 13), 13, COLORS.faint, 500));
    case 2: {
      const pc = percent(p);
      return svg(text(72, 66, pc == null ? "—" : `${pc} %`, 40, accent(p), 700) + text(72, 100, `${clock(p.positionS)} / ${clock(p.durationS)}`, 15, COLORS.muted, 500) + (p.paused ? text(72, 124, "en pause", 14, COLORS.muted, 500) : "") + progressBar(p));
    }
    case 3:
      return svg(text(72, 62, PATH_LABEL[p.path], 26, COLORS.text, 700) + lines(p.video ?? "", 14, 2).map((l, i) => text(72, 92 + i * 20, l, 14, COLORS.muted, 500)).join(""));
    case 4:
      return svg(text(72, 70, p.streamMbps == null ? "—" : p.streamMbps.toLocaleString("fr-FR"), 40, COLORS.text, 700) + text(72, 102, "Mb/s", 17, COLORS.muted, 500));
    case 5: {
      const total = p.incidents.waits + p.incidents.errors + p.incidents.rebuilds;
      const color = p.state === "souci" ? COLORS.trouble : total ? COLORS.text : COLORS.faint;
      return svg(
        text(72, 62, String(total), 44, color, 700) +
          text(72, 92, total === 1 ? "incident" : "incidents", 15, COLORS.muted, 500) +
          text(72, 114, `att. ${p.incidents.waits} · err. ${p.incidents.errors} · rec. ${p.incidents.rebuilds}`, 12, COLORS.faint, 500)
      );
    }
    case 6:
      return svg(
        text(72, 26, "Son", 13, COLORS.faint, 500) +
          lines(p.audio ?? "—", 14, 2).map((l, i) => text(72, 46 + i * 18, l, 14)).join("") +
          text(72, 96, "Sous-titres", 13, COLORS.faint, 500) +
          lines(p.subtitle ?? "aucun", 14, 2).map((l, i) => text(72, 116 + i * 18, l, 14)).join("")
      );
    default:
      return backKey();
  }
}

function slotIndex(a: KeyAction<JsonObject>): number | null {
  const c = a.coordinates;
  if (!c) return null;
  return c.row * a.device.size.columns + c.column;
}

function slotImage(index: number): string {
  if (view.kind === "detail") {
    const p = data?.plays.find((x) => x.id === (view as { playId: string }).playId);
    if (p) return detailKey(index, p);
  }
  return listKey(index);
}

function infobarFeedback(): { left: string; right: string } {
  if (problem && !data) return { left: "Laterna", right: problem === "réglages" ? "Réglages à faire" : problem === "jeton" ? "Jeton refusé" : "Hors ligne" };
  if (view.kind === "detail") {
    const p = data?.plays.find((x) => x.id === (view as { playId: string }).playId);
    if (p) return { left: `${p.user} · ${p.device}`, right: `${percent(p) ?? "—"} %${p.state === "souci" ? " · souci" : ""}` };
  }
  const n = data?.count ?? 0;
  const pages = pageCount() > 1 ? ` · ${(view.kind === "list" ? view.page : 0) + 1}/${pageCount()}` : "";
  return { left: "Laterna", right: `${n} ${n > 1 ? "lectures" : "lecture"}${data?.trouble ? " · souci" : ""}${pages}` };
}

async function renderAll(): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const a of streamDeck.actions) {
    if (a.manifestId === "fr.laterna.streamdeck.count" && a.isKey()) jobs.push(a.setImage(countKey()));
    else if (a.manifestId === "fr.laterna.streamdeck.slot" && a.isKey()) {
      const index = slotIndex(a);
      if (index != null) jobs.push(a.setImage(slotImage(index)));
    } else if (a.manifestId === "fr.laterna.streamdeck.infobar" && a.isNeoInfobar()) jobs.push(a.setFeedback(infobarFeedback()));
  }
  await Promise.allSettled(jobs);
}

// ─── Actions ──────────────────────────────────────────────────────────────────

function appeared(): void {
  visible++;
  startPolling();
  void renderAll();
}

function disappeared(): void {
  visible = Math.max(0, visible - 1);
  if (visible === 0) stopPolling();
}

function openActivity(): void {
  const url = base();
  if (url) void streamDeck.system.openUrl(`${url}/#activite=1`);
}

@action({ UUID: "fr.laterna.streamdeck.count" })
class CountAction extends SingletonAction {
  override onWillAppear(_ev: WillAppearEvent): void {
    appeared();
  }
  override onWillDisappear(_ev: WillDisappearEvent): void {
    disappeared();
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    view = { kind: "list", page: 0 };
    // Page 0 : celle des huit cases, quelle que soit la page laissée la dernière fois.
    if (HAS_PROFILE) await streamDeck.profiles.switchToProfile(ev.action.device.id, PROFILE, 0);
    else openActivity();
    void poll();
  }
}

@action({ UUID: "fr.laterna.streamdeck.slot" })
class SlotAction extends SingletonAction {
  override onWillAppear(_ev: WillAppearEvent): void {
    appeared();
  }
  override onWillDisappear(_ev: WillDisappearEvent): void {
    disappeared();
  }
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const index = slotIndex(ev.action);
    if (index == null) return;
    if (view.kind === "detail") {
      if (index === 7) view = { kind: "list", page: 0 };
      else if (index === 0) openActivity();
    } else if (index === 7) {
      if (pageCount() > 1 && view.page < pageCount() - 1) view = { kind: "list", page: view.page + 1 };
      else {
        view = { kind: "list", page: 0 };
        if (HAS_PROFILE) await streamDeck.profiles.switchToProfile(ev.action.device.id);
      }
    } else {
      const p = data?.plays[view.page * PER_PAGE + index];
      if (p) view = { kind: "detail", playId: p.id };
    }
    await renderAll();
  }
}

@action({ UUID: "fr.laterna.streamdeck.infobar" })
class InfobarAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (ev.action.isNeoInfobar()) await ev.action.setFeedbackLayout("layouts/infobar.json");
    appeared();
  }
  override onWillDisappear(_ev: WillDisappearEvent): void {
    disappeared();
  }
}

streamDeck.settings.onDidReceiveGlobalSettings<Settings>((ev) => {
  settings = ev.settings;
  void poll();
});

streamDeck.actions.registerAction(new CountAction());
streamDeck.actions.registerAction(new SlotAction());
streamDeck.actions.registerAction(new InfobarAction());
await streamDeck.connect();
settings = await streamDeck.settings.getGlobalSettings<Settings>();
void poll();
