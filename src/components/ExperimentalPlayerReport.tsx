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
  add("Échec", input.error ?? "aucun message — le chargement n'aboutit pas");
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

export function ExperimentalPlayerReport({ input }: { input: ReportInput }) {
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

  const report = buildReport(input, capabilities);

  const copy = useCallback(() => {
    // Only over HTTPS, and not on every browser. The textarea below is the fallback that always
    // works: it is selectable, so the report can be taken by hand when this cannot give it.
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
        <p className="text-xs uppercase tracking-wide text-slate-500">Détails techniques</p>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs text-white hover:bg-white/20"
        >
          {copied ? <ClipboardCheck size={14} /> : <Copy size={14} />}
          {copied ? "Copié" : "Copier"}
        </button>
      </div>
      {/* Read-only rather than disabled: a disabled textarea cannot be selected, and selecting it
          by hand is the only way to get this off a browser with no clipboard permission. */}
      <textarea
        readOnly
        value={report}
        onFocus={(event) => event.currentTarget.select()}
        className="h-48 w-full resize-none rounded-lg border border-white/10 bg-black/50 p-3 font-mono text-[11px] leading-4 text-slate-300"
      />
    </div>
  );
}
