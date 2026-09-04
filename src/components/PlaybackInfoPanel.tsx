"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { describeCapabilities, probeCapabilities } from "@/lib/webcodecs/capabilities";
import { ExperimentalPlayerReport, type ReportInput } from "@/components/ExperimentalPlayerReport";

export interface PanelRow {
  label: string;
  value: string;
}

export interface PanelSection {
  title: string;
  rows: PanelRow[];
}

/**
 * Ce que le lecteur a à dire de lui-même, quel que soit le lecteur.
 *
 * Les deux chemins de lecture tenaient chacun leur panneau : celui-ci en haut à gauche avec des
 * définitions traduites, celui du lecteur natif en haut à droite avec ses propres intitulés, sa
 * propre mise en page et le rapport copiable que l'autre n'avait pas. La même question posée à
 * deux lecteurs recevait donc deux réponses de forme différente, et l'une des deux ne pouvait
 * pas quitter l'appareil. Le panneau est maintenant unique : chaque hôte décrit ce qu'il sait
 * dans ce modèle, et la présentation, la sonde des capacités et le rapport sont communs.
 */
export interface PlaybackPanelData {
  /** La ligne à lire avant toutes les autres : comment ce fichier est lu. */
  headline: { name: string; detail: string; tone: "good" | "warn" | "neutral" };
  /** Pourquoi, quand il y a un pourquoi : raisons de transcodage, chemin retenu, repli. */
  notes: string[];
  sections: PanelSection[];
  /** Le rapport copiable — les faits du démarrage, sous une forme qui survit à un copier-coller. */
  report: ReportInput | null;
}

const TONES: Record<PlaybackPanelData["headline"]["tone"], string> = {
  good: "bg-emerald-500/10 text-emerald-300 ring-emerald-400/20",
  warn: "bg-amber-500/10 text-amber-200 ring-amber-400/20",
  neutral: "bg-slate-500/10 text-slate-300 ring-slate-400/20",
};

function Row({ label, value }: PanelRow) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      {/* Des points de conduite, pour qu'un œil aille d'un intitulé à sa valeur vingt lignes plus
          bas sans perdre la ligne — la même raison qu'un sommaire en porte. */}
      <span aria-hidden className="mx-1 min-w-3 flex-1 translate-y-[-3px] border-b border-dotted border-white/10" />
      <dd className="text-right font-mono text-[11px] leading-4 text-slate-200">{value}</dd>
    </div>
  );
}

/** Vingt lignes d'affilée, c'est une liste ; en cinq groupes, c'est une réponse. */
function Section({ title, rows }: PanelSection) {
  if (rows.length === 0) return null;
  return (
    <section className="border-t border-white/5 pt-2.5 first:border-0 first:pt-0">
      <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">{title}</h3>
      <dl>
        {rows.map((row) => (
          <Row key={row.label} {...row} />
        ))}
      </dl>
    </section>
  );
}

export function PlaybackInfoPanel({
  data,
  open,
  onClose,
}: {
  data: PlaybackPanelData | null;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [capabilities, setCapabilities] = useState<Record<string, string> | null>(null);

  // Demandé par le panneau plutôt que par chaque lecteur : ce que l'appareil accepte ne dépend
  // pas du chemin de lecture, et les deux hôtes en avaient besoin.
  useEffect(() => {
    if (!open || capabilities) return;
    let cancelled = false;
    void probeCapabilities()
      .then((found) => !cancelled && setCapabilities(describeCapabilities(found)))
      .catch(() => !cancelled && setCapabilities({ "Sonde des capacités": "échec" }));
    return () => {
      cancelled = true;
    };
  }, [open, capabilities]);

  if (!open || !data) return null;

  const capabilityRows = capabilities
    ? Object.entries(capabilities).map(([label, value]) => ({ label, value }))
    : [];

  return (
    <div
      // z-20 : au-dessus de la nappe transparente que PlayerControls étend sur tout l'écran pour
      // capter les pointeurs (z-10). Sans cela le panneau se peint par-dessus mais aucun clic ne
      // l'atteint — ni la fermeture, ni le défilement.
      className="player-panel pointer-events-auto absolute z-20 max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] origin-top-right animate-fade-in-scale overflow-y-auto rounded-2xl p-4 text-xs text-slate-300"
      style={{
        top: "max(4rem, calc(env(safe-area-inset-top) + 5rem))",
        right: "max(1rem, env(safe-area-inset-right))",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-white">{t("player.info.title")}</p>
        {/* Le panneau couvre les commandes : sans ce bouton, le seul moyen d'en sortir était de
            fermer le lecteur. */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="-mr-1 -mt-1 rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
        >
          <X size={16} />
        </button>
      </div>

      <div className={`rounded-lg px-3 py-2 ring-1 ring-inset ${TONES[data.headline.tone]}`}>
        <p className="text-[13px] font-medium leading-tight">{data.headline.name}</p>
        <p className="mt-0.5 text-[11px] opacity-70">{data.headline.detail}</p>
      </div>

      {data.notes.map((note) => (
        <p key={note} className="mt-2 text-[11px] leading-4 text-slate-400">
          {note}
        </p>
      ))}

      <div className="mt-3 space-y-2.5">
        {data.sections.map((section) => (
          <Section key={section.title} {...section} />
        ))}
        <Section title={t("player.info.sections.device")} rows={capabilityRows} />
      </div>

      {/* Gardé là où on peut l'atteindre pendant la lecture : les fautes qui restent à traquer
          sont justement celles qui arrivent *après* un démarrage réussi. */}
      {data.report && <ExperimentalPlayerReport input={data.report} />}
    </div>
  );
}
