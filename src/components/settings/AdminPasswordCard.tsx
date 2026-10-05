"use client";

import { useState } from "react";
import useSWR from "swr";
import { Loader2 } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";

/**
 * Le compte administrateur local, dans « Connexions » (DECISIONS.md §48) : changer son mot de
 * passe, et la commande à lancer s'il est oublié. Un compte fixé par le .env se change dans le .env.
 */
export function AdminPasswordCard() {
  const t = useT();
  const toast = useToast();
  const { data } = useSWR<{ user: string | null; source: "env" | "setup" | null }>("/api/settings/admin-password", fetcher);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next.length < 8) return setError(t("setup.admin.weak"));
    if (next !== confirm) return setError(t("setup.admin.mismatch"));
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/admin-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, next }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error === "wrong-password" ? t("setup.adminPassword.wrong") : body?.error === "weak-password" ? t("setup.admin.weak") : t("setup.errors.save"));
        return;
      }
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success(t("setup.adminPassword.done"));
    } finally {
      setBusy(false);
    }
  }

  if (!data?.source) return null;
  return (
    <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
      <h3 className="mb-1 text-base font-semibold text-white">
        {t("setup.adminPassword.title")} · <span className="text-muted">{data.user}</span>
      </h3>
      <p className="mb-4 text-sm text-muted">{t("setup.adminPassword.text")}</p>
      {data.source === "env" ? (
        <p className="text-sm text-subtle">{t("setup.adminPassword.env")}</p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <input className="input" type="password" autoComplete="current-password" aria-label={t("setup.adminPassword.current")} placeholder={t("setup.adminPassword.current")} value={current} onChange={(e) => setCurrent(e.target.value)} />
          <input className="input" type="password" autoComplete="new-password" aria-label={t("setup.adminPassword.next")} placeholder={t("setup.adminPassword.next")} value={next} onChange={(e) => setNext(e.target.value)} />
          <input className="input" type="password" autoComplete="new-password" aria-label={t("setup.adminPassword.confirm")} placeholder={t("setup.adminPassword.confirm")} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-subtle">
              <code>{t("setup.adminPassword.forgot")}</code>
            </p>
            <button type="submit" disabled={busy || !current || !next} className="btn btn-primary">
              {busy ? <Loader2 size={15} className="animate-spin" /> : null}
              {t("setup.adminPassword.save")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
