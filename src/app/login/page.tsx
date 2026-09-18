"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Clapperboard, Activity, Eye, EyeOff } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // Un seul interrupteur pour les deux formulaires : ils ne s'affichent jamais ensemble.
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showLocalForm, setShowLocalForm] = useState(false);
  const reason = searchParams.get("reason");

  async function submit(endpoint: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Le serveur nomme ce qu'il a vu dans ce qui lui a été envoyé — jamais ce qu'il sait du
        // mot de passe attendu. Une espace de tête est invisible et ne pardonne pas ; la signaler
        // transforme six tentatives identiques en une correction.
        if (data.code === "password-leading-space") throw new Error(t("auth.passwordLeadingSpace"));
        throw new Error(data.error || t("auth.error.failed"));
      }
      /**
       * La connexion locale n'a pas d'identité Jellyfin — et donc pas de lecture.
       *
       * C'est la porte de secours, celle qui reste ouverte quand Jellyfin ne répond plus : elle
       * ne porte ni jeton ni identifiant de compte, si bien que tout ce qui en dépend — lancer un
       * film, les chapitres, l'aperçu de la barre, les préférences, « vu » et « favori » —
       * répond 401. Vérifié en direct sur les routes concernées.
       *
       * L'y faire atterrir sur l'écran cinéma le jour où il devient la racine, c'est offrir une
       * interface dont le bouton « Lire » ne marche pas. Cette connexion-là va donc à la gestion,
       * qui est ce pour quoi elle existe. Une destination explicitement demandée reste prioritaire,
       * et rien n'empêche d'aller ensuite au lecteur à la main.
       */
      const asked = searchParams.get("next");
      const local = endpoint.endsWith("/login");
      router.replace(asked || (local ? "/gestion" : "/"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.error.unknown"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-ink px-5 py-10">
      {/*
        Une lueur, pas une image.
        
        La porte d'entrée doit ressembler à l'application qu'elle ouvre, et l'application est
        sombre avec un accent chaud. Deux dégradés radiaux suffisent à le dire : rien à télécharger,
        rien qui puisse manquer sur une connexion lente, et l'écran est peint avant même que la
        police d'affichage soit arrivée. `pointer-events-none` parce qu'un décor ne se clique pas.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60rem 40rem at 50% -10%, color-mix(in srgb, var(--color-accent-600) 22%, transparent), transparent 70%)," +
            "radial-gradient(40rem 30rem at 100% 100%, color-mix(in srgb, var(--color-accent-500) 10%, transparent), transparent 70%)",
        }}
      />

      <div className="relative w-full max-w-sm">
        {/* L'enseigne, au-dessus de la carte plutôt que dedans : on reconnaît d'abord l'endroit,
            on s'identifie ensuite. */}
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-600/15 text-accent-400 ring-1 ring-accent-500/25">
            <Clapperboard size={28} />
          </span>
          <h1 className="font-display text-3xl font-bold tracking-tight text-white">Ciné App</h1>
          <p className="mt-2 text-sm text-slate-400">{t("auth.tagline")}</p>
        </div>

        <div className="card p-6 sm:p-7">
          {reason === "playback" && (
            <p className="mb-5 rounded-lg border border-accent-500/20 bg-accent-500/10 px-3 py-2 text-xs text-accent-200">
              {t("auth.reasonPlayback")}
            </p>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit("/api/auth/jellyfin");
            }}
            className="space-y-4"
          >
            <div>
              <label htmlFor="login-user" className="mb-1.5 block text-xs font-medium text-slate-300">
                {t("auth.jellyfin.username")}
              </label>
              {/*
                `autoCapitalize` et `autoCorrect` désactivés : un téléphone met une majuscule à la
                première lettre de tout champ de texte, et un identifiant en minuscules devenait
                donc faux à la première frappe — un échec de connexion que personne ne sait
                expliquer. `autoComplete` pour que les gestionnaires de mots de passe proposent le
                bon couple plutôt que de ne rien reconnaître.
              */}
              <input
                id="login-user"
                className="input py-2.5"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                required
              />
            </div>
            <div>
              <label htmlFor="login-pass" className="mb-1.5 block text-xs font-medium text-slate-300">
                {t("auth.jellyfin.password")}
              </label>
              {/* Un mot de passe qu'on ne voit pas est un mot de passe qu'on ne peut pas
                  déboguer. Un long mot de passe collé depuis un gestionnaire peut arriver tronqué
                  au premier saut de ligne, ou lesté d'une espace : il a l'air juste, il ne marche
                  pas, et l'écran répète « identifiants invalides ». Le voir règle ça en une
                  seconde. */}
              <div className="relative">
                <input
                  id="login-pass"
                  type={revealed ? "text" : "password"}
                  className="input py-2.5 pr-11"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
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

            <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-3 text-base">
              {loading ? t("auth.jellyfin.submitting") : t("auth.jellyfin.submit")}
            </button>
          </form>

          {/* Dit une fois, en petit : c'est la réponse à « quel mot de passe ? », et c'est la seule
              question que cet écran provoque. Sans elle on la reçoit par message. */}
          <p className="mt-4 text-center text-xs leading-5 text-slate-500">{t("auth.hint")}</p>
        </div>

        {/* La porte de service. Elle existe pour le jour où Jellyfin ne répond plus, et elle ne
            s'adresse qu'à une personne : elle reste donc repliée et discrète. */}
        <div className="mt-6">
          {!showLocalForm ? (
            <button
              onClick={() => setShowLocalForm(true)}
              className="mx-auto block text-xs text-slate-600 transition-colors hover:text-slate-400"
            >
              {t("auth.local.heading")}
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit("/api/auth/login");
              }}
              className="card space-y-3 p-5"
            >
              <p className="text-xs font-medium text-slate-400">{t("auth.local.heading")}</p>
              <input
                className="input"
                placeholder={t("auth.local.usernamePlaceholder")}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
              />
              <div className="relative">
                <input
                  type={revealed ? "text" : "password"}
                  className="input w-full pr-11"
                  placeholder={t("auth.local.passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
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
              {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
              <button type="submit" disabled={loading} className="btn-ghost w-full justify-center">
                {loading ? t("auth.jellyfin.submitting") : t("auth.local.submit")}
              </button>
            </form>
          )}
        </div>

        <Link
          href="/status"
          className="mx-auto mt-8 flex w-fit items-center gap-1.5 text-xs text-slate-600 transition-colors hover:text-slate-400"
        >
          <Activity size={13} /> {t("auth.statusLink")}
        </Link>
      </div>
    </main>
  );
}
