"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Stethoscope } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { Panel, Poster, ago, type T } from "@/components/activity/parts";
import { ActivityLink } from "@/components/activity/nav";
import type { TitleDiagnosis, Verdict } from "@/lib/activity/diagnosis";

const VERDICT_TONE: Record<Verdict["kind"], string> = {
  file: "bg-rose-500/15 text-rose-300",
  platform: "bg-amber-500/15 text-amber-300",
  device: "bg-sky-500/15 text-sky-300",
  mixed: "bg-white/10 text-slate-300",
  alone: "bg-white/10 text-slate-400",
};

function sentence(d: TitleDiagnosis, t: T): string {
  const failing = d.viewers.filter((v) => v.failed > 0);
  const clean = d.viewers.length - failing.length;
  const v = d.verdict;
  switch (v.kind) {
    case "file":
      return t("activity.diagnosis.why.file", { n: failing.length });
    case "platform":
      return t("activity.diagnosis.why.platform", { device: v.device, n: failing.length, clean });
    case "device": {
      const viewer = failing[0];
      const base = t("activity.diagnosis.why.device", { who: v.user, device: v.device, clean });
      if (!viewer.elsewhere.seances) return base;
      const share = Math.round((viewer.elsewhere.failed / viewer.elsewhere.seances) * 100);
      return `${base} ${v.everywhere ? t("activity.diagnosis.why.everywhere", { p: share }) : t("activity.diagnosis.why.onlyHere", { n: viewer.elsewhere.seances })}`;
    }
    case "mixed":
      return t("activity.diagnosis.why.mixed", { n: failing.length, clean });
    case "alone":
      return t("activity.diagnosis.why.alone", { who: v.user });
  }
}

/**
 * Combien de titres le panneau montre replié. Sur trente jours la liste s'allongeait jusqu'à
 * repousser la semaine en chiffres hors de l'écran ; les deux premiers suffisent à dire s'il se
 * passe quelque chose, le reste se déroule à la demande.
 */
const FOLDED = 2;

/**
 * Le fichier ou l'appareil ? Pour chaque titre qui a échoué, le verdict tiré du croisement des
 * séances, la phrase qui le justifie, et les témoins — chacun avec sa séance en échec à ouvrir.
 */
export function DiagnosisPanel({ items, now, days }: { items: TitleDiagnosis[]; now: number; days: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, FOLDED);
  const toggle =
    items.length > FOLDED ? (
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-slate-400 hover:bg-white/5 hover:text-white"
      >
        {open ? t("activity.diagnosis.collapse") : t("activity.diagnosis.showAll", { n: items.length })}
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
    ) : null;
  return (
    <Panel title={t("activity.diagnosis.title", { n: days })} icon={Stethoscope}>
      {items.length ? (
        <ul className="divide-y divide-white/5">
          {shown.map((d) => (
            <li key={d.key} className="flex gap-3 px-4 py-3">
              <Poster itemId={d.itemId} className="h-16 w-11" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate font-medium text-white">{d.title}</span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT_TONE[d.verdict.kind]}`}>
                    {t(`activity.diagnosis.verdict.${d.verdict.kind}`)}
                  </span>
                </div>
                <p className="text-sm text-slate-300">{sentence(d, t)}</p>
                <p className="text-xs text-slate-500">
                  {t("activity.diagnosis.counts", { f: d.failed, n: d.seances, when: ago(d.lastFailure, now, t) })}
                </p>
                {d.reasons.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {d.reasons.map((r) => (
                      <span key={r.reason} className="max-w-full truncate rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                        {r.count > 1 ? `${r.count}× ` : ""}
                        {r.reason}
                      </span>
                    ))}
                  </div>
                )}
                {/* Les témoins : qui, sur quoi, et avec quel succès. Le rouge mène à la séance en échec. */}
                <ul className="flex flex-wrap gap-1.5 pt-0.5">
                  {d.viewers.map((v) => {
                    const label = `${v.user} · ${v.device}`;
                    const count = `${v.seances - v.failed}✓${v.failed ? ` ${v.failed}✗` : ""}`;
                    return (
                      <li key={label}>
                        {v.failed ? (
                          <ActivityLink
                            to={{ kind: "seance", id: v.failedSeances[0] }}
                            className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-200 hover:bg-rose-500/20"
                          >
                            {label}
                            <span className="tabular-nums text-rose-300/80">{count}</span>
                          </ActivityLink>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2 py-0.5 text-[11px] text-emerald-200/80">
                            {label}
                            <span className="tabular-nums">{count}</span>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </li>
          ))}
          {toggle && <li className="flex justify-center px-4 py-2">{toggle}</li>}
        </ul>
      ) : (
        <p className="px-4 py-6 text-sm text-slate-500">{t("activity.diagnosis.none")}</p>
      )}
    </Panel>
  );
}
