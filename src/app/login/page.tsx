"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Clapperboard, Activity } from "lucide-react";
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
        throw new Error(data.error || t('auth.error.failed'));
      }
      router.replace(searchParams.get("next") || "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.error.unknown'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-4">
      <div className="card w-full max-w-sm p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-lg bg-accent-600/20 p-2 text-accent-400">
            <Clapperboard size={24} />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white">Cine App</h1>
            <p className="text-xs text-slate-400">{t('auth.title')}</p>
          </div>
        </div>

        {reason === "playback" && (
          <p className="mb-4 rounded-lg border border-accent-500/20 bg-accent-500/10 px-3 py-2 text-xs text-accent-300">
            {t('auth.reasonPlayback')}
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
            <label className="mb-1 block text-xs font-medium text-slate-400">
              {t('auth.jellyfin.username')}
            </label>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">{t('auth.jellyfin.password')}</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button type="submit" disabled={loading} className="btn-primary w-full justify-center">
            {loading ? t('auth.jellyfin.submitting') : t('auth.jellyfin.submit')}
          </button>
        </form>

        <div className="mt-6 border-t border-slate-800 pt-4">
          {!showLocalForm ? (
            <button
              onClick={() => setShowLocalForm(true)}
              className="w-full text-center text-xs text-slate-500 hover:text-slate-300"
            >
              {t('auth.local.heading')}
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit("/api/auth/login");
              }}
              className="space-y-3"
            >
              <p className="text-xs font-medium text-slate-400">{t('auth.local.username')}</p>
              <input
                className="input"
                placeholder={t('auth.local.usernamePlaceholder')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
              <input
                type="password"
                className="input"
                placeholder="Mot de passe"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {error && <p className="text-sm text-red-400">{error}</p>}
              <button type="submit" disabled={loading} className="btn-ghost w-full justify-center">
                {loading ? t('auth.jellyfin.submitting') : t('auth.local.submit')}
              </button>
            </form>
          )}
        </div>
      </div>

      <Link
        href="/status"
        className="mt-4 flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300"
      >
        <Activity size={13} /> {t('health.pageTitle')}
      </Link>
    </main>
  );
}
