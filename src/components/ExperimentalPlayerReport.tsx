"use client";

// The technical panel, for the two cases where the panel cannot be reached.
//
// The panel hangs off the controls, and the controls only exist once the file is playing. The
// failures worth reporting are precisely the ones where that never happens: an error screen with
// one sentence on it, or a spinner that never stops. On a phone there is no console behind either.
// So the same facts are gathered into one block of text here, with a way to get it off the device.

import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, Copy } from "lucide-react";
import { describeCapabilities, probeCapabilities } from "@/lib/webcodecs/capabilities";
import { traceText } from "@/lib/webcodecs/trace";
import { useT } from "@/components/TranslationProvider";

export interface ReportInput {
  /** What went wrong, or null when nothing has yet and the wait is simply long. */
  error: string | null;
  /** How long the file has been opening, in milliseconds. */
  elapsedMs: number | null;
  title: string;
  itemId: string;
  /** The server's description of the file, when it arrived. */
  file: Record<string, unknown> | null;
  pathReason: string | null;
  /** Whatever the running pipeline can say about itself, empty before there is one. */
  diagnostics: Record<string, string>;
  /** Playing normally: the same report, read from the panel rather than from a failure. */
  running?: boolean;
}

/**
 * Everything as one block of text.
 *
 * Text, not a formatted panel: the point is that it leaves the device — pasted into a message —
 * and a layout does not survive that trip while a list of lines does.
 */
export function buildReport(input: ReportInput, capabilities: Record<string, string> | null): string {
  const lines: string[] = [];
  const add = (label: string, value: unknown) => lines.push(`${label}: ${value ?? "—"}`);

  lines.push("=== Lecteur expérimental — rapport ===");
  add("Quand", new Date().toISOString());
  add("Titre", `${input.title} (${input.itemId})`);
  add("Navigateur", typeof navigator === "undefined" ? "?" : navigator.userAgent);
  add("Écran", typeof window === "undefined" ? "?" : `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}`);
  add("Échec", input.error ?? (input.running ? "aucun — lecture en cours" : "aucun message, et le chargement n'aboutit pas"));
  add("Temps écoulé", input.elapsedMs === null ? "—" : `${(input.elapsedMs / 1000).toFixed(1)} s`);
  add("Chemin", input.pathReason ?? "non encore décidé");

  if (input.file) {
    lines.push("", "--- Fichier (vu du serveur) ---");
    for (const [key, value] of Object.entries(input.file)) {
      // The stream URL carries a session token, and this text is meant to be pasted somewhere.
      if (key.toLowerCase().includes("url")) continue;
      add(key, typeof value === "object" ? JSON.stringify(value) : value);
    }
  }

  if (Object.keys(input.diagnostics).length > 0) {
    lines.push("", "--- Pipeline ---");
    for (const [key, value] of Object.entries(input.diagnostics)) add(key, value);
  }

  lines.push("", "--- Capacités de l'appareil ---");
  if (capabilities) for (const [key, value] of Object.entries(capabilities)) add(key, value);
  else lines.push("(sonde en cours)");

  lines.push("", "--- Déroulé ---", traceText());
  return lines.join("\n");
}

/**
 * @param flow dans un conteneur qui défile déjà (le panneau technique) : le texte suit ce défilement,
 *   sans zone défilante à lui. Ailleurs (l'écran d'erreur, l'attente), rien ne défile autour, et le
 *   texte a sa propre zone bornée.
 */
export function ExperimentalPlayerReport({ input, flow = false }: { input: ReportInput; flow?: boolean }) {
  const t = useT();
  const [capabilities, setCapabilities] = useState<Record<string, string> | null>(null);
  const [copied, setCopied] = useState(false);

  // Asked here rather than inherited from the panel: on this screen the panel never opened, and
  // what the device accepts is the single most useful thing to know about a refusal.
  useEffect(() => {
    let cancelled = false;
    void probeCapabilities()
      .then((found) => !cancelled && setCapabilities(describeCapabilities(found)))
      .catch(() => !cancelled && setCapabilities({ "Sonde des capacités": "échec" }));
    return () => {
      cancelled = true;
    };
  }, []);

  // En direct, à chaque rendu. Le 28/09/2026, défiler dans le rapport figeait le panneau sur
  // iPhone ; ce n'était pas cette mise à jour, mais la zone de saisie qui le portait (voir plus bas).
  const report = buildReport(input, capabilities);

  const copy = useCallback(() => {
    // Only over HTTPS, and not on every browser. The text below is the fallback that always works:
    // it is selectable, so the report can be taken by hand when this cannot give it.
    void navigator.clipboard
      ?.writeText(report)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }, [report]);

  return (
    <div className="mt-2 w-full max-w-lg text-left">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-slate-500">{t("player.report.details")}</p>
        <button
          type="button"
          onClick={copy}
          className="btn btn-ghost btn-sm"
        >
          {copied ? <ClipboardCheck size={14} /> : <Copy size={14} />}
          {copied ? t("player.report.copied") : t("player.report.copy")}
        </button>
      </div>
      {/* Un bloc de texte, plus une zone de saisie (28/09/2026). La zone de texte défilait dans le
          panneau qui défile, et sélectionnait tout dès qu'elle recevait le focus : sur iPhone, le
          toucher qui commençait un défilement la sélectionnait — des centaines de lignes —, iOS
          passait en mode sélection, et ni le rapport ni le panneau ne défilaient plus. Le texte
          reste sélectionnable à la main (appui long), pour un navigateur sans presse-papiers. */}
      <pre
        data-testid="player-report-text"
        className={
          "select-text whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/50 p-3 font-mono text-[11px] leading-4 text-slate-300" +
          (flow ? "" : " max-h-48 overflow-y-auto overscroll-contain")
        }
      >
        {report}
      </pre>
    </div>
  );
}
