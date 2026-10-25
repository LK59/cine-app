"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Compass, Share, SquarePlus } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { BrandMark } from "@/components/BrandMark";
import { collectPassageInput, formatPassageCode } from "@/lib/passage/client";
import { isAppleTouchDevice } from "@/lib/iosInstall";
import { touchHintHeaders } from "@/lib/deviceLabel";

/** Où l'ancienne application tourne : les gestes pour installer la nouvelle ne sont pas les mêmes. */
export type ScreenPlatform = "ios" | "android" | "desktop";

export function screenPlatform(): ScreenPlatform {
  if (isAppleTouchDevice()) return "ios";
  if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent)) return "android";
  return "desktop";
}

interface Prepared {
  url: string;
  code: string;
}

type Failure = "relogin" | "rateLimited" | "error";

/** Le passage demandé au serveur : un lien qui connecte, et un code pour l'application installée. */
async function preparePassage(): Promise<{ passage: Prepared; carried: boolean } | { failure: Failure; carried: boolean }> {
  let carried = false;
  try {
    const input = await collectPassageInput();
    carried = input.downloads.length > 0;
    const res = await fetch("/api/passage", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...touchHintHeaders() },
      body: JSON.stringify(input),
    });
    const data = (await res.json().catch(() => ({}))) as Partial<Prepared> & { code?: string };
    if (!res.ok || typeof data.url !== "string" || typeof data.code !== "string") {
      return { failure: data.code === "passage-relogin" ? "relogin" : res.status === 429 ? "rateLimited" : "error", carried };
    }
    return { passage: { url: data.url, code: data.code }, carried };
  } catch {
    return { failure: "error", carried };
  }
}

/**
 * L'écran du passage sur l'ancienne adresse (DECISIONS.md §119), plein et sans croix (souhait du
 * propriétaire, 25/10/2026 : « un truc simple »). Le bandeau d'avant laissait des comptes rouvrir
 * l'ancienne icône chaque jour, passage fait ou non.
 *
 * - **Un onglet de navigateur** : un seul gros bouton. Il demande le passage et ouvre la nouvelle
 *   adresse dans le même onglet, connecté, réglages et notifications compris — rien à installer.
 * - **L'application installée** : une application de l'écran d'accueil est liée à son adresse pour
 *   toujours, il faut en installer une autre ; l'écran le dit en étapes numérotées, pour l'appareil
 *   qu'on tient. Le passage est demandé dès l'affichage, parce que le bouton doit copier le code et
 *   ouvrir l'autre adresse *dans* l'appui (une ouverture ou une copie après une attente réseau est
 *   refusée). Sur iPhone et iPad, la nouvelle application a son propre stockage : le code est le
 *   chemin, et l'écran le montre.
 *
 * L'adresse ouverte vient du serveur, construite depuis le réglage du déploiement : jamais d'ici.
 */
export function PassageScreen({ target, installed }: { target: string; installed: boolean }) {
  const t = useT();
  const host = new URL(target).host;
  const [platform] = useState(screenPlatform);
  const [passage, setPassage] = useState<Prepared | null>(null);
  const [carried, setCarried] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!installed) return;
    let cancelled = false;
    void preparePassage().then((result) => {
      if (cancelled) return;
      setCarried(result.carried);
      if ("failure" in result) setFailure(result.failure);
      else setPassage(result.passage);
    });
    return () => {
      cancelled = true;
    };
  }, [installed]);

  async function continueHere() {
    setBusy(true);
    setFailure(null);
    const result = await preparePassage();
    if ("failure" in result) {
      setFailure(result.failure);
      setBusy(false);
      return;
    }
    window.location.assign(result.passage.url);
  }

  function openNew(prepared: Prepared) {
    // Dans l'appui : la copie d'abord (sans l'attendre), l'ouverture ensuite.
    if (platform === "ios") {
      void navigator.clipboard?.writeText(formatPassageCode(prepared.code)).then(
        () => setCopied(true),
        () => setCopied(false)
      );
    }
    window.open(prepared.url, "_blank", "noopener");
  }

  const failureLine = failure && (
    <p role="alert" className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
      {t(`passage.screen.${failure}`)}
    </p>
  );
  const bigButton = "flex w-full items-center justify-center gap-2 rounded-full bg-white px-5 py-4 text-base font-semibold text-black transition-opacity hover:bg-white/90 disabled:opacity-60";

  return createPortal(
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={t(installed ? "passage.screen.appTitle" : "passage.screen.tabTitle")}
      data-passage-screen={installed ? "app" : "tab"}
      className="fixed inset-0 z-[75] overflow-y-auto bg-ink"
    >
      <div
        className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-5 py-10"
        style={{ paddingTop: "max(env(safe-area-inset-top), 2.5rem)", paddingBottom: "max(env(safe-area-inset-bottom), 2.5rem)" }}
      >
        <div className="flex flex-col items-center text-center">
          <BrandMark size={64} />
          <h1 className="mt-5 font-display text-[26px] font-semibold leading-tight text-white">
            {t(installed ? "passage.screen.appTitle" : "passage.screen.tabTitle")}
          </h1>
          <p className="mt-2 text-[15px] leading-snug text-white/75">{t(installed ? "passage.screen.appBody" : "passage.screen.tabBody")}</p>
        </div>

        {!installed && (
          <div className="mt-8">
            <button type="button" onClick={() => void continueHere()} disabled={busy} data-passage-continue="" className={bigButton}>
              {busy ? t("passage.screen.busy") : t("passage.screen.continue")}
              {!busy && <ArrowRight size={18} />}
            </button>
            <p className="mt-3 text-center text-[13px] text-subtle">{host}</p>
            {failureLine}
          </div>
        )}

        {installed && (
          <>
            <ol className="mt-8 space-y-3" data-passage-steps={platform}>
              <Step n={1}>
                <p>{t(platform === "ios" ? "passage.screen.step.openIos" : "passage.screen.step.open")}</p>
              </Step>
              {platform === "ios" && (
                <>
                  <Step n={2}>
                    <p>
                      {t("passage.screen.step.iosSafari")} <Compass size={16} className="mb-0.5 inline text-white" aria-hidden="true" />
                    </p>
                  </Step>
                  <Step n={3}>
                    <p>
                      {t("passage.screen.step.iosShare")} <Share size={16} className="mb-0.5 inline text-white" aria-hidden="true" />
                      {", "}
                      {t("passage.screen.step.iosAdd")} <SquarePlus size={16} className="mb-0.5 inline text-white" aria-hidden="true" />
                      {", "}
                      {t("passage.screen.step.iosConfirm")}
                    </p>
                  </Step>
                  <Step n={4}>
                    <p>{t("passage.screen.step.iosOpen")}</p>
                    {passage && (
                      <p data-passage-code="" className="mt-2 select-all font-mono text-2xl font-semibold tracking-[0.18em] text-white">
                        {formatPassageCode(passage.code)}
                      </p>
                    )}
                  </Step>
                </>
              )}
              {platform === "android" && (
                <>
                  <Step n={2}>
                    <p>{t("passage.screen.step.androidInstall")}</p>
                  </Step>
                  <Step n={3}>
                    <p>{t("passage.screen.step.openIcon")}</p>
                  </Step>
                </>
              )}
              {platform === "desktop" && (
                <>
                  <Step n={2}>
                    <p>{t("passage.screen.step.desktopInstall")}</p>
                  </Step>
                  <Step n={3}>
                    <p>{t("passage.screen.step.openIcon")}</p>
                  </Step>
                </>
              )}
              <Step n={platform === "ios" ? 5 : 4}>
                <p>{t(`passage.screen.step.remove.${platform}`)}</p>
              </Step>
            </ol>
            {/* Le bouton après la dernière étape (souhait du propriétaire, 25/10/2026) : en tête, on
                touchait l'étape 1 et on quittait l'écran sans avoir lu la suite. */}
            <div className="mt-6">
              {passage ? (
                <button type="button" onClick={() => openNew(passage)} data-passage-open-new="" className={bigButton}>
                  {t("passage.screen.open")}
                  <ArrowRight size={18} />
                </button>
              ) : (
                !failure && <p className="text-center text-sm text-subtle">{t("passage.screen.preparing")}</p>
              )}
              {copied && (
                <p role="status" className="mt-2 text-center text-[13px] text-subtle">
                  {t("passage.screen.copied")}
                </p>
              )}
              {failureLine}
            </div>
            {carried && (
              <p data-passage-downloads-note="" className="mt-4 text-center text-[13px] leading-snug text-subtle">
                {t("passage.downloads.again")}
              </p>
            )}
            <p className="mt-6 text-center text-[13px] leading-snug text-subtle">{t("passage.screen.already")}</p>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="glass-panel flex gap-3 rounded-2xl p-4 text-[15px] leading-snug text-white">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-sm font-bold text-black">{n}</span>
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
    </li>
  );
}
