"use client";

import { useState } from "react";
import { CircleCheck, CircleAlert, Loader2, RotateCcw } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { SETTINGS, TESTABLE_GROUPS, type SettingGroup, type SettingView, type TestableGroup } from "@/lib/settings/schema";

/**
 * Une carte de réglages par service — l'assistant de premier lancement et la page « Connexions »
 * de la gestion la partagent (DECISIONS.md §48) : une seule façon d'afficher une valeur, d'où elle
 * vient (application, .env, défaut), de la remplacer et de revenir à celle du .env.
 *
 * Les champs sont *contrôlés par l'appelant* (`draft`) : l'assistant enregistre à « Suivant », la
 * page à « Enregistrer ». Un secret ne s'affiche jamais : son champ est vide, avec « Renseignée
 * (…1234) » à côté, et l'enregistrer vide le laisse tel quel.
 */

export type Draft = Record<string, string>;

const NEED_TONE = {
  required: "bg-danger/15 text-danger",
  library: "bg-warning/15 text-warning",
  optional: "bg-white/8 text-subtle",
} as const;

export function SettingsGroupCard({
  group,
  views,
  draft,
  onDraft,
  onReset,
  errors,
  footer,
}: {
  group: SettingGroup;
  views: Map<string, SettingView>;
  draft: Draft;
  onDraft: (key: string, value: string) => void;
  /** « Revenir à la valeur du .env » d'une clé. */
  onReset: (key: string) => void;
  errors?: Record<string, string>;
  footer?: React.ReactNode;
}) {
  const t = useT();
  const defs = SETTINGS.filter((s) => s.group === group);
  const need = defs.some((d) => d.need === "required") ? "required" : defs.some((d) => d.need === "library") ? "library" : "optional";
  const testable = (TESTABLE_GROUPS as readonly string[]).includes(group);
  // Une aide (où trouver la clé) seulement pour les services : un texte absent revient sous la
  // forme de sa clé, qu'il ne faut pas afficher.
  const helpKey = `setup.groups.${group}.help`;
  const help = t(helpKey) === helpKey ? "" : t(helpKey);

  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-white">{t(`setup.groups.${group}.title`)}</h3>
        {group !== "app" && group !== "deployment" && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${NEED_TONE[need]}`}>{t(`setup.need.${need}`)}</span>
        )}
      </header>
      <p className="mb-1 text-sm text-muted">{t(`setup.groups.${group}.why`)}</p>
      {help && <p className="mb-4 text-xs text-subtle">{help}</p>}

      <div className="space-y-4">
        {defs.filter((d) => d.inApp).map((def) => {
          const view = views.get(def.key);
          const value = draft[def.key] ?? (def.kind === "secret" ? "" : view?.value ?? "");
          const overridesEnv = view?.source === "app" && view.envPresent;
          const error = errors?.[def.key];
          return (
            <div key={def.key}>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={`setting-${def.key}`} className="text-sm font-medium text-white">
                  {t(`setup.fields.${def.key}`)}
                </label>
                {view && <SourceBadge source={view.source} />}
              </div>
              {def.kind === "boolean" ? (
                <BooleanChoice id={`setting-${def.key}`} value={value} onChange={(v) => onDraft(def.key, v)} />
              ) : def.kind === "select" ? (
                <select id={`setting-${def.key}`} className="select w-full" value={value} onChange={(e) => onDraft(def.key, e.target.value)}>
                  {def.options?.map((o) => (
                    <option key={o} value={o}>
                      {o.toUpperCase()}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`setting-${def.key}`}
                  className="input"
                  type={def.kind === "secret" ? "password" : "text"}
                  inputMode={def.kind === "url" ? "url" : undefined}
                  autoComplete={def.kind === "secret" ? "new-password" : "off"}
                  spellCheck={false}
                  value={value}
                  placeholder={def.kind === "secret" && view?.set ? t("setup.secretKeep") : def.placeholder ?? ""}
                  onChange={(e) => onDraft(def.key, e.target.value)}
                />
              )}
              {def.kind === "secret" && view?.set && !draft[def.key] && (
                <p className="mt-1 text-xs text-subtle">{view.hint ? t("setup.secretSet", { hint: view.hint }) : t("setup.secretSetNoHint")}</p>
              )}
              {error && <p className="mt-1 text-xs text-danger">{t(`setup.errors.${error}`)}</p>}
              {overridesEnv && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="text-xs text-warning">{t("setup.envOverride")}</p>
                  <button type="button" onClick={() => onReset(def.key)} className="inline-flex items-center gap-1 text-xs font-medium text-accent-400 hover:underline">
                    <RotateCcw size={12} />
                    {t("setup.resetEnv")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {testable && <ConnectionTest group={group as TestableGroup} draft={draft} />}
      {footer}
    </section>
  );
}

function SourceBadge({ source }: { source: SettingView["source"] }) {
  const t = useT();
  const tone = source === "app" ? "text-accent-400" : source === "env" ? "text-success" : "text-subtle";
  return <span className={`text-[11px] font-medium ${tone}`}>{t(`setup.source.${source}`)}</span>;
}

function BooleanChoice({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const t = useT();
  return (
    <div id={id} role="radiogroup" className="flex gap-1.5">
      {(["true", "false"] as const).map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={`chip ${value === v ? "chip-on" : ""}`}>
          {t(v === "true" ? "setup.on" : "setup.off")}
        </button>
      ))}
    </div>
  );
}

/** « Tester la connexion » avec les valeurs en cours de saisie — un secret vide reprend celui enregistré. */
function ConnectionTest({ group, draft }: { group: TestableGroup; draft: Draft }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "running" | { ok: boolean; detail: string }>("idle");
  async function run() {
    setState("running");
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group, values: draft }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; detail?: string } | null;
      setState({ ok: !!body?.ok, detail: body?.detail ?? `http-${res.status}` });
    } catch {
      setState({ ok: false, detail: "unreachable" });
    }
  }
  const failure = (detail: string) =>
    detail === "unauthorized" || detail === "unreachable" || detail === "timeout" ? t(`setup.testFail.${detail}`) : t("setup.testFail.other", { detail });
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" onClick={run} disabled={state === "running"} className="btn btn-ghost text-sm">
        {state === "running" ? <Loader2 size={15} className="animate-spin" /> : null}
        {state === "running" ? t("setup.testing") : t("setup.test")}
      </button>
      {typeof state === "object" &&
        (state.ok ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-success">
            <CircleCheck size={15} /> {t("setup.testOk", { detail: state.detail })}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-danger">
            <CircleAlert size={15} /> {failure(state.detail)}
          </span>
        ))}
    </div>
  );
}

/** Les options de déploiement : la ligne à ajouter, à copier. */
export function DeploymentGuide() {
  const t = useT();
  const [copied, setCopied] = useState<string | null>(null);
  const snippets: Record<string, string> = {
    TZ: "    environment:\n      - TZ=Europe/Paris",
    MEDIA_ROOT: "    volumes:\n      - /chemin/vers/medias:/mnt/media/video:ro\n    environment:\n      - MEDIA_ROOT=/mnt/media/video",
    APP_ADMIN_USER: "APP_ADMIN_USER=admin\nAPP_ADMIN_PASSWORD=…",
  };
  function copy(key: string) {
    void navigator.clipboard?.writeText(snippets[key]).then(() => {
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  }
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <h3 className="mb-2 text-base font-semibold text-white">{t("setup.groups.deployment.title")}</h3>
      <p className="mb-4 text-sm text-muted">{t("setup.groups.deployment.why")}</p>
      <div className="space-y-4">
        {Object.keys(snippets).map((key) => (
          <div key={key}>
            <p className="mb-1 text-sm font-medium text-white">{t(`setup.fields.${key}`)}</p>
            <p className="mb-1.5 text-xs text-subtle">{t(`setup.deployHint.${key}`)}</p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-lg bg-black/40 p-3 pr-20 text-xs text-white">{snippets[key]}</pre>
              <button type="button" onClick={() => copy(key)} className="chip absolute right-2 top-2 text-xs">
                {copied === key ? t("setup.copied") : t("setup.copy")}
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-subtle">{t("setup.secretsNote")}</p>
    </section>
  );
}
