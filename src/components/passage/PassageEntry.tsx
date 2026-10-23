"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useT } from "@/components/TranslationProvider";
import { hardNavigate } from "@/lib/signOut";
import { touchHintHeaders } from "@/lib/deviceLabel";
import { useLiquidDelegation } from "@/lib/liquidGlass/useLiquidDelegation";
import { passageFlags } from "@/lib/passage/client";
import { isInstalledApp } from "@/lib/iosInstall";
import { APP_NAME } from "@/lib/appBuild";
import { PassageInstallHelp } from "./PassageInstallHelp";

type Phase = "starting" | "working" | "refused" | "code" | "signed";

/** Le jeton du fragment (`#t=…`), effacé de l'adresse aussitôt lu : il ne doit rester ni dans l'historique ni dans une copie de l'adresse. */
function takeFragmentToken(): string | null {
  const match = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  return match?.[1] ?? null;
}

/** Échange un secret ; rend `"ok"`, ou la raison du refus à afficher. */
async function redeem(body: { token: string } | { code: string }): Promise<"ok" | "invalid" | "rateLimited" | "network"> {
  try {
    const res = await fetch("/api/passage/redeem", {
      method: "POST",
      // L'indice tactile : l'appareil de la session se nomme comme à une connexion (`deviceLabel.ts`).
      headers: { "Content-Type": "application/json", ...touchHintHeaders() },
      body: JSON.stringify(body),
    });
    if (res.ok) return "ok";
    return res.status === 429 ? "rateLimited" : res.status >= 500 ? "network" : "invalid";
  } catch {
    return "network";
  }
}

/** Arrivé : l'accueil, avec l'aide d'installation tout de suite (hors application installée). */
function arrive(): void {
  if (!isInstalledApp()) passageFlags.wantInstallHelp();
  hardNavigate("/");
}

/**
 * La page `/passage` (DECISIONS.md §119) : l'échange du jeton, sinon le code de passage, et l'aide
 * pour poser l'application sur l'écran d'accueil. Même habillage que la connexion et les liens de
 * partage : c'est la première page qu'on voit de la nouvelle adresse.
 */
export function PassageEntry({ signedIn }: { signedIn: boolean }) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("starting");
  const [code, setCode] = useState("");
  const [error, setError] = useState<"invalid" | "rateLimited" | "network" | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      const token = takeFragmentToken();
      if (!token) {
        setPhase(signedIn ? "signed" : "code");
        return;
      }
      setPhase("working");
      const result = await redeem({ token });
      if (result === "ok") return arrive();
      setPhase("refused");
      if (result !== "invalid") setError(result);
    })();
  }, [signedIn]);

  async function submitCode() {
    setLoading(true);
    setError(null);
    const result = await redeem({ code });
    if (result === "ok") return arrive();
    setLoading(false);
    setError(result);
  }

  const rootRef = useRef<HTMLElement>(null);
  useLiquidDelegation(rootRef);

  const showCode = phase === "code" || phase === "refused";

  return (
    <main
      ref={rootRef}
      data-passage-phase={phase}
      className="setup-liquid relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-ink px-5 py-10"
      style={{ paddingBottom: "max(2.5rem, calc(env(safe-area-inset-bottom, 0px) + 1rem))" }}
    >
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- l’icône de l’application, servie sans session (ACTIFS_PUBLICS), comme sur la page de connexion */}
          <img src="/icon-512.png" alt="" width={64} height={64} className="mb-4 h-16 w-16 rounded-2xl" />
          <h1 className="font-display text-3xl font-bold tracking-tight text-white">{APP_NAME}</h1>
          <p className="mt-2 text-sm text-slate-400">{t("passage.page.title")}</p>
        </div>

        <div className="card settings-card space-y-5 p-6 sm:p-7">
          {(phase === "starting" || phase === "working") && (
            <p role="status" className="text-center text-sm text-slate-300">
              {t("passage.page.working")}
            </p>
          )}

          {phase === "signed" && (
            <>
              <p className="text-center text-sm text-slate-200">{t("passage.page.signedIn")}</p>
              <button
                type="button"
                onClick={() => hardNavigate("/")}
                data-liquid-pan="wide"
                className="flex w-full items-center justify-center rounded-full bg-white py-3 text-base font-semibold text-black hover:bg-white/90"
              >
                {t("passage.page.toApp")}
              </button>
            </>
          )}

          {showCode && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitCode();
              }}
              className="space-y-4"
            >
              <p className="text-[13px] leading-snug text-slate-300">{phase === "refused" ? t("passage.page.refused") : t("passage.page.codeIntro")}</p>
              <div>
                <label htmlFor="passage-code" className="mb-1.5 block text-xs font-medium text-slate-300">
                  {t("passage.page.codeLabel")}
                </label>
                <input
                  id="passage-code"
                  data-passage-code-input=""
                  className="input py-2.5 text-center font-mono text-lg uppercase tracking-[0.2em] focus:border-white/40! focus:ring-white/25!"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 12))}
                  placeholder="XXXX-XXXX"
                  maxLength={12}
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                />
              </div>
              {error && (
                <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {t(`passage.page.${error}`)}
                </p>
              )}
              <button
                type="submit"
                disabled={loading}
                data-liquid-pan="wide"
                className="flex w-full items-center justify-center rounded-full bg-white py-3 text-base font-semibold text-black transition-opacity hover:bg-white/90 disabled:opacity-60"
              >
                {loading ? t("passage.page.submitting") : t("passage.page.submit")}
              </button>
            </form>
          )}

          {phase !== "starting" && phase !== "working" && <PassageInstallHelp />}
        </div>

        {showCode && (
          <Link
            href="/login"
            data-liquid-pan="wide"
            className="settings-glass-btn mx-auto mt-8 flex w-fit items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs text-slate-400 transition-colors hover:text-slate-200"
          >
            {t("passage.page.toLogin")}
          </Link>
        )}
      </div>
    </main>
  );
}
