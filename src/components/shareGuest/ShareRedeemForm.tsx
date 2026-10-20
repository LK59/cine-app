"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Eye, EyeOff } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { hardNavigate } from "@/lib/signOut";
import { touchHintHeaders } from "@/lib/deviceLabel";
import { useLiquidDelegation } from "@/lib/liquidGlass/useLiquidDelegation";

/** Le code d'un lien : dix signes, sans 0/o ni 1/l/i (`share/store.ts`). Tapé, il est mis en minuscules. */
const CODE_PATTERN = "[a-zA-Z2-9]{10}";

/**
 * L'entrée d'un lien de partage (DECISIONS.md §112) : le mot de passe — et le code, quand il n'est pas
 * dans l'adresse (`/partage`, venu de la page de connexion).
 *
 * La même page que la connexion, au mot près de ses classes : on arrive ici depuis un message, sans
 * rien connaître de l'application, et c'est elle qu'on doit reconnaître ensuite. Rien du titre n'est
 * dit avant le mot de passe : la phrase est la même pour un code qui existe et pour un code inventé.
 *
 * Un refus ne dit pas pourquoi (la route non plus) : code inconnu, mot de passe faux, lien passé ou
 * révoqué se lisent pareil, pour ne rien apprendre à qui essaie.
 *
 * `household` : la page a été ouverte sous un compte du foyer. L'entrée remplace la session de
 * l'appareil — la personne serait déconnectée de son compte sans l'avoir vu venir ; on le lui dit
 * avant qu'elle valide.
 */
export function ShareRedeemForm({ code: fixedCode, household }: { code: string | null; household: boolean }) {
  const t = useT();
  const [code, setCode] = useState(fixedCode ?? "");
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit() {
    const wanted = (fixedCode ?? code).trim().toLowerCase();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/share/redeem", {
        method: "POST",
        // L'indice tactile : l'appareil du lien se nomme comme celui d'une connexion (`deviceLabel.ts`).
        headers: { "Content-Type": "application/json", ...touchHintHeaders() },
        body: JSON.stringify({ code: wanted, password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        setError(
          data.code === "rate_limited"
            ? t("share.guest.errors.rateLimited")
            : data.code === "share-unavailable"
              ? t("share.guest.errors.unavailable")
              : res.status === 400 || res.status === 401
                ? t("share.guest.errors.refused")
                : t("share.guest.errors.generic")
        );
        return;
      }
      // Un vrai chargement : la racine relit la session (`ShareModeProvider`), et rien de la page d'avant
      // — un compte du foyer, son cache — ne suit l'invité. Voir `hardNavigate`.
      hardNavigate(`/partage/${wanted}`);
    } catch {
      setError(t("share.guest.errors.network"));
    } finally {
      setLoading(false);
    }
  }

  // Le verre liquide des accueils, comme la page de connexion.
  const rootRef = useRef<HTMLElement>(null);
  useLiquidDelegation(rootRef);

  return (
    <main
      ref={rootRef}
      className="setup-liquid relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-ink px-5 py-10"
      style={{ paddingBottom: "max(2.5rem, calc(env(safe-area-inset-bottom, 0px) + 1rem))" }}
    >
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- l’icône de l’application, servie sans session (ACTIFS_PUBLICS), comme sur la page de connexion */}
          <img src="/icon-512.png" alt="" width={64} height={64} className="mb-4 h-16 w-16 rounded-2xl" />
          <h1 className="font-display text-3xl font-bold tracking-tight text-white">Cine App</h1>
          {/* La même phrase pour tout code, existant ou non : rien du titre avant le mot de passe. */}
          <p className="mt-2 text-sm text-slate-400">{t("share.guest.tagline")}</p>
        </div>

        <div className="card settings-card p-6 sm:p-7">
          {household && (
            <p role="status" data-share-household-warning="" className="mb-5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-200">
              {t("share.guest.householdWarning")}
            </p>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-4"
          >
            {fixedCode === null && (
              <div>
                <label htmlFor="share-code" className="mb-1.5 block text-xs font-medium text-slate-300">
                  {t("share.guest.code")}
                </label>
                <input
                  id="share-code"
                  className="input py-2.5 font-mono tracking-wider focus:border-white/40! focus:ring-white/25!"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
                  pattern={CODE_PATTERN}
                  maxLength={10}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                  required
                />
              </div>
            )}
            <div>
              <label htmlFor="share-pass" className="mb-1.5 block text-xs font-medium text-slate-300">
                {t("share.guest.password")}
              </label>
              {/* Visible à la demande, comme à la connexion : un mot de passe recopié d'un message se
                  vérifie d'un coup d'œil. Les tirets et la casse ne comptent pas (`normalizeSharePassword`). */}
              <div className="relative">
                <input
                  id="share-pass"
                  type={revealed ? "text" : "password"}
                  className="input py-2.5 pr-11 font-mono tracking-wider focus:border-white/40! focus:ring-white/25!"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="xxxx-xxxx-xxxx"
                  maxLength={64}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus={fixedCode !== null}
                  required
                />
                <button
                  type="button"
                  onClick={() => setRevealed((v) => !v)}
                  aria-label={t(revealed ? "auth.hidePassword" : "auth.showPassword")}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-slate-400 transition-colors hover:text-slate-200"
                >
                  {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && (
              <p role="alert" className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </p>
            )}

            <button type="submit" disabled={loading} data-liquid-pan="wide" className="flex w-full items-center justify-center rounded-full bg-white py-3 text-base font-semibold text-black transition-opacity hover:bg-white/90 disabled:opacity-60">
              {loading ? t("share.guest.submitting") : t("share.guest.submit")}
            </button>
          </form>

          <p className="mt-4 text-center text-xs leading-5 text-slate-500">{t("share.guest.hint")}</p>
        </div>

        {/* Le retour vers la connexion, pour qui est arrivé ici par erreur — un compte du foyer. */}
        <Link
          href="/login"
          data-liquid-pan="wide"
          className="settings-glass-btn mx-auto mt-8 flex w-fit items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs text-slate-400 transition-colors hover:text-slate-200"
        >
          {t("share.guest.toLogin")}
        </Link>
        {/* Pas de signature ici : elle n'a que ses emplacements (DECISIONS.md §41). */}
      </div>
    </main>
  );
}
