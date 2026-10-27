"use client";

import { useState } from "react";
import useSWR from "swr";
import { Copy, Loader2 } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { relativeTimeAbs } from "@/lib/format";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { ConfigCardFrame } from "@/components/settings/AdminTools";
import type { StreamDeckToken } from "@/lib/streamdeck/tokens";

/**
 * Les jetons du Stream Deck (27/10/2026, `src/lib/streamdeck/tokens.ts`) : un par appareil, montré une
 * seule fois à la création, révocable ici. Le plugin ne voit avec lui que les lectures en cours.
 */
export function StreamDeckCard() {
  const t = useT();
  const toast = useToast();
  const { data, mutate } = useSWR<{ tokens: StreamDeckToken[] }>("/api/admin/streamdeck/tokens", fetcher);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/streamdeck/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => null)) as { token?: string; error?: string } | null;
      if (!res.ok || !body?.token) {
        toast.error(body?.error === "limit" ? t("streamdeck.limit") : t("streamdeck.error"));
        return;
      }
      setFresh(body.token);
      setName("");
      await mutate();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    const res = await fetch(`/api/admin/streamdeck/tokens?id=${id}`, { method: "DELETE" });
    if (!res.ok) return toast.error(t("streamdeck.error"));
    toast.success(t("streamdeck.revoked"));
    await mutate();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
    } catch {
      /* presse-papiers refusé : le texte reste affiché, à sélectionner à la main */
    }
  }

  return (
    <ConfigCardFrame title={t("streamdeck.title")} hint={t("streamdeck.hint")}>
      <div className="space-y-4">
        <div>
          <p className="mb-1 text-xs text-subtle">{t("streamdeck.address")}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-white/[0.05] px-3 py-2 text-sm text-white">{origin}</code>
            <button type="button" onClick={() => copy(origin)} className="btn btn-ghost" aria-label={t("streamdeck.copy")}>
              <Copy size={15} />
              {copied === origin ? t("streamdeck.copied") : t("streamdeck.copy")}
            </button>
          </div>
        </div>

        {fresh && (
          <div className="rounded-xl border border-white/15 bg-white/[0.04] p-3">
            <p className="mb-2 text-sm text-white">{t("streamdeck.created")}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-black/30 px-3 py-2 text-xs text-white">{fresh}</code>
              <button type="button" onClick={() => copy(fresh)} className="btn btn-primary">
                <Copy size={15} />
                {copied === fresh ? t("streamdeck.copied") : t("streamdeck.copy")}
              </button>
            </div>
          </div>
        )}

        <ul className="space-y-2">
          {data?.tokens.length === 0 && <li className="text-sm text-subtle">{t("streamdeck.empty")}</li>}
          {data?.tokens.map((token) => (
            <li key={token.id} className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm text-white">{token.name}</p>
                <p className="text-xs text-subtle">
                  {token.lastUsedAt ? t("streamdeck.lastUsed", { when: relativeTimeAbs(token.lastUsedAt, t) }) : t("streamdeck.never")}
                </p>
              </div>
              <button type="button" onClick={() => revoke(token.id)} className="btn btn-ghost text-danger">
                {t("streamdeck.revoke")}
              </button>
            </li>
          ))}
        </ul>

        <form onSubmit={create} className="flex flex-wrap items-center gap-2">
          <input className="input min-w-0 flex-1" maxLength={40} aria-label={t("streamdeck.name")} placeholder={t("streamdeck.name")} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary">
            {busy ? <Loader2 size={15} className="animate-spin" /> : null}
            {t("streamdeck.create")}
          </button>
        </form>
      </div>
    </ConfigCardFrame>
  );
}
