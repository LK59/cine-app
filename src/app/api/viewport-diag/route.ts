import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { logViewportDiag } from "@/lib/eventLogs";
import { viewportDiagAllowed } from "@/lib/writeLimits";

/**
 * Le relevé de hauteur de l'application installée sur iPhone et iPad — voir `viewportWatch.ts` —, et
 * depuis le 07/11/2026 la mesure d'un retour au premier plan (`kind: "retour"`, `returnDiag.ts`), et depuis
 * le 09/11/2026 le clavier du panneau « Poser une question » (`kind: "clavier"`, `ask/viewport.ts`), et depuis
 * 10.29.1 la rangée « À l'écran » et le panneau d'une personne (`kind: "xray-ui"`, `xrayUiDiag.ts`).
 * Et la mesure du mode Immersion (`kind: "immersion-bench"`, DECISIONS §144) : il n'a pas d'autre journal que
 * celui-ci, et ses chiffres — images par seconde par préréglage, carte graphique — décident de ses réglages.
 *
 * Le compte vient de la session, jamais du corps. Seuls les champs connus, bornés ; le reste tombe.
 * Rien n'est renvoyé.
 */
const SNAPSHOT_FIELDS = ["inner", "outer", "width", "vv", "vvTop", "client", "shell", "shellTop", "scrollY"] as const;
/** Les mesures en pixels d'une ligne `clavier`. */
const KEYBOARD_NUMBERS = ["inner", "outer", "innerW", "client", "vv", "vvTop", "vvPageTop", "baseline", "scrollY", "screenW", "screenH", "layerTop", "panelTop", "panelBottom", "inputTop", "inputBottom"] as const;
const DECISIONS = new Set(["rien", "coincée", "champ", "film"]);
const TRIGGERS = new Set(["retour", "pageshow", "redimensionné", "clavier fermé"]);

/** Le relevé « À l'écran » (`kind: "xray-ui"`, 10.29.1) : ses évènements, ses raisons de fermer, ses champs. */
const XRAY_UI_EVENTS = new Set(["row", "tap", "open", "close"]);
const XRAY_UI_REASONS = new Set(["fond", "croix", "glissé", "échap", "démonté"]);
const XRAY_UI_NUMBERS = ["seq", "sceneStart", "pills", "scrollLeft", "personId", "openMs"] as const;
const XRAY_UI_OPACITIES = ["rowOpacity", "firstOpacity", "panelOpacity", "layerOpacity", "rowEffOpacity", "firstEffOpacity", "panelEffOpacity"] as const;
/** Ce qui cache un élément plus haut que lui (10.29.2, `effectiveLookOf`). */
const XRAY_UI_HIDDEN = ["rowHiddenBy", "firstHiddenBy", "panelHiddenBy"] as const;
const XRAY_UI_BOOLEANS = ["overflow", "early"] as const;
const XRAY_UI_BOXES = ["row", "first", "pill", "panel"] as const;

/** Les préréglages qu'une mesure du mode Immersion peut nommer. */
const IMMERSION_PRESETS = new Set(["low", "medium", "high", "ultra"]);

const px = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 100_000 ? Math.round(value) : null;
const str = (value: unknown, max: number): string | null => (typeof value === "string" ? value.slice(0, max) : null);

/** Une boîte `{ x, y, w, h }` en pixels entiers, ou rien. */
function boxFrom(value: unknown): { x: number; y: number; w: number; h: number } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const x = px(raw.x);
  const y = px(raw.y);
  const w = px(raw.w);
  const h = px(raw.h);
  return x === null || y === null || w === null || h === null ? null : { x, y, w, h };
}

function snapshotOf(value: unknown): Record<string, number> {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of SNAPSHOT_FIELDS) {
    const n = px(raw[key]);
    if (n !== null) out[key] = n;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return new NextResponse(null, { status: 401 });
  if (!viewportDiagAllowed(session.u)) return new NextResponse(null, { status: 429 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Corps invalide" }, { status: 400 });
  // Le clavier du panneau « Poser une question » (09/11/2026, `keyboardSnapshot` dans `ask/viewport.ts`) :
  // ce que disent la fenêtre, la vue visuelle et l'écran champ actif, et quelle branche a placé le panneau.
  if (body.kind === "clavier") {
    const pick = (value: unknown, allowed: readonly string[]) => (typeof value === "string" && allowed.includes(value) ? value : null);
    const fields: Record<string, unknown> = {};
    for (const key of KEYBOARD_NUMBERS) fields[key] = px(body[key]);
    const events = (body.events && typeof body.events === "object" ? body.events : {}) as Record<string, unknown>;
    logViewportDiag(
      {
        user: session.jfUser ?? session.u,
        device: requestDeviceLabel(req),
        trigger: pick(body.trigger, ["focus", "600ms", "resize"]),
        branch: pick(body.branch, ["vue", "fenetre", "attente", "inconnu", "feuille", "colonne"]),
        mode: pick(body.mode, ["line", "full"]),
        where: pick(body.where, ["lecteur", "fiche"]),
        placement: pick(body.placement, ["player", "sheet"]),
        orientation: str(body.orientation, 30),
        focusedState: body.focusedState === true,
        active: body.active === true,
        standalone: body.standalone === true,
        touchPhone: body.touchPhone === true,
        vvScale: typeof body.vvScale === "number" && Number.isFinite(body.vvScale) ? Math.round(body.vvScale * 100) / 100 : null,
        ...fields,
        events: { vvResize: px(events.vvResize), vvScroll: px(events.vvScroll), winResize: px(events.winResize) },
        build: str(body.build, 40),
        version: str(body.version, 20),
      },
      "clavier",
    );
    return new NextResponse(null, { status: 204 });
  }
  // « À l'écran » (10.29.1, `xrayUiDiag.ts`) : la rangée montrée, un toucher, le panneau d'une personne et sa
  // fermeture — ce que l'écran calcule (boîtes, opacité, visibilité, ce qui est dessus au centre du panneau).
  if (body.kind === "xray-ui") {
    const event = typeof body.event === "string" && XRAY_UI_EVENTS.has(body.event) ? body.event : null;
    if (!event) return NextResponse.json({ error: "Corps invalide" }, { status: 400 });
    const fields: Record<string, unknown> = {};
    for (const key of XRAY_UI_NUMBERS) {
      const n = px(body[key]);
      if (n !== null) fields[key] = n;
    }
    for (const key of XRAY_UI_OPACITIES) {
      const v = body[key];
      if (typeof v === "number" && Number.isFinite(v)) fields[key] = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
    }
    for (const key of XRAY_UI_BOOLEANS) if (typeof body[key] === "boolean") fields[key] = body[key];
    for (const key of XRAY_UI_BOXES) {
      const b = boxFrom(body[key]);
      if (b) fields[key] = b;
    }
    const visibility = (v: unknown) => (typeof v === "string" && ["visible", "hidden", "collapse"].includes(v) ? v : null);
    logViewportDiag(
      {
        user: session.jfUser ?? session.u,
        device: requestDeviceLabel(req),
        event,
        itemId: str(body.itemId, 64),
        session: str(body.session, 12),
        trigger: typeof body.trigger === "string" && ["montée", "scène"].includes(body.trigger) ? body.trigger : undefined,
        reason: typeof body.reason === "string" && XRAY_UI_REASONS.has(body.reason) ? body.reason : undefined,
        mode: typeof body.mode === "string" && ["line", "sheet", "side"].includes(body.mode) ? body.mode : undefined,
        rowVisibility: visibility(body.rowVisibility) ?? undefined,
        firstVisibility: visibility(body.firstVisibility) ?? undefined,
        panelVisibility: visibility(body.panelVisibility) ?? undefined,
        top: str(body.top, 60) ?? undefined,
        rowTop: str(body.rowTop, 60) ?? undefined,
        firstTop: str(body.firstTop, 60) ?? undefined,
        ...Object.fromEntries(XRAY_UI_HIDDEN.flatMap((key) => (body[key] === "display" || body[key] === "visibility" ? [[key, body[key]]] : []))),
        ...fields,
        build: str(body.build, 40),
        version: str(body.version, 20),
      },
      "xray-ui",
    );
    return new NextResponse(null, { status: 204 });
  }
  // Le bouton « Mesurer » du mode Immersion (`immersion/src/bench/`) : un parcours fixe de caméra par
  // préréglage, avec et sans vidéo. Une ligne par passage : cadence moyenne, 1 % le plus lent, carte
  // graphique annoncée par le navigateur, définition réellement rendue.
  if (body.kind === "immersion-bench") {
    const preset = typeof body.preset === "string" && IMMERSION_PRESETS.has(body.preset) ? body.preset : null;
    if (!preset) return NextResponse.json({ error: "Corps invalide" }, { status: 400 });
    const rate = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1000 ? Math.round(value * 10) / 10 : null);
    logViewportDiag(
      {
        user: session.jfUser ?? session.u,
        device: requestDeviceLabel(req),
        run: str(body.run, 12),
        preset,
        video: body.video === true,
        // Avec vidéo : le film en cours (son décodage compte), ou une mire 1080p (un fichier, depuis 10.34.4).
        videoSource: body.videoSource === "film" || body.videoSource === "mire" ? body.videoSource : undefined,
        videoHeight: px(body.videoHeight) ?? undefined,
        fps: rate(body.fps),
        low1: rate(body.low1),
        frames: px(body.frames),
        seconds: rate(body.seconds),
        // Les à-coups (10.34.4) : la pire image, les images de plus de 33 et 50 ms, et où sur le parcours
        // tombent les cinq pires (« 0.42:61;… ») — un « 1 % le plus lent » bas ne disait pas pourquoi.
        maxMs: px(body.maxMs) ?? undefined,
        over33: px(body.over33) ?? undefined,
        over50: px(body.over50) ?? undefined,
        slowAt: typeof body.slowAt === "string" && /^[0-9.:;]{0,60}$/.test(body.slowAt) ? body.slowAt : undefined,
        renderer: str(body.renderer, 160),
        vendor: str(body.vendor, 80),
        width: px(body.width),
        height: px(body.height),
        cssWidth: px(body.cssWidth),
        cssHeight: px(body.cssHeight),
        dpr: rate(body.dpr),
        scale: rate(body.scale),
        supersampling: body.supersampling === true,
        baked: body.baked === true,
        hz: px(body.hz),
        build: str(body.build, 40),
        version: str(body.version, 20),
      },
      "immersion-bench",
    );
    return new NextResponse(null, { status: 204 });
  }
  if (body.kind === "retour") {
    const events = Array.isArray(body.events) ? body.events.filter((e): e is string => typeof e === "string").slice(0, 12).map((e) => e.slice(0, 60)) : [];
    logViewportDiag(
      {
        user: session.jfUser ?? session.u,
        device: requestDeviceLabel(req),
        // Caché des heures parfois : en secondes, borné à un jour.
        hiddenS: typeof body.hiddenMs === "number" && Number.isFinite(body.hiddenMs) ? Math.min(86_400, Math.max(0, Math.round(body.hiddenMs / 1000))) : null,
        firstFrameMs: px(body.firstFrameMs),
        frames: px(body.frames),
        maxGapMs: px(body.maxGapMs),
        maxGapAtMs: px(body.maxGapAtMs),
        janks: px(body.janks),
        longJanks: px(body.longJanks),
        events,
        film: body.film === true,
        standalone: body.standalone === true,
        cut: body.cut === "rechargement" || body.cut === "caché" ? body.cut : null,
        build: str(body.build, 40),
        version: str(body.version, 20),
      },
      "retour",
    );
    return new NextResponse(null, { status: 204 });
  }
  logViewportDiag({
    user: session.jfUser ?? session.u,
    device: requestDeviceLabel(req),
    trigger: typeof body.trigger === "string" && TRIGGERS.has(body.trigger) ? body.trigger : null,
    decision: typeof body.decision === "string" && DECISIONS.has(body.decision) ? body.decision : null,
    best: px(body.best),
    before: snapshotOf(body.before),
    screen: str(body.screen, 20),
    build: str(body.build, 40),
    version: str(body.version, 20),
  });
  return new NextResponse(null, { status: 204 });
}
