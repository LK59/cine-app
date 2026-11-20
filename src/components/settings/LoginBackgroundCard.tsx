"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { ConfigCardFrame } from "@/components/settings/AdminTools";
import { LOGIN_BACKGROUND_DEFAULT_DIM, LOGIN_BACKGROUND_DIM_MAX, LOGIN_BACKGROUND_MAX_BYTES, LOGIN_BACKGROUND_DIM_MIN, type LoginBackground } from "@/lib/loginBackgroundShared";

const ENDPOINT = "/api/admin/login-background";

/**
 * L'image de fond des écrans de connexion (DECISIONS §199) : l'envoyer, régler le voile, la retirer. L'aperçu
 * reproduit l'écran en petit — l'image, le voile, et une carte à la place du formulaire — pour juger la
 * lisibilité avant de quitter la page.
 */
export function LoginBackgroundCard() {
  const t = useT();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const { data, mutate } = useSWR<{ background: LoginBackground | null }>(ENDPOINT, fetcher);
  const [busy, setBusy] = useState(false);
  // Le voile pendant que le curseur bouge : l'aperçu suit le doigt, l'envoi part au relâchement.
  const [dimDraft, setDimDraft] = useState<number | null>(null);
  const bg = data?.background ?? null;
  const dim = dimDraft ?? bg?.dim ?? LOGIN_BACKGROUND_DEFAULT_DIM;

  async function send(file: File) {
    if (file.size > LOGIN_BACKGROUND_MAX_BYTES) {
      toast.error(t("loginBackground.tooLarge"));
      if (input.current) input.current.value = "";
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("image", file);
      const res = await fetch(ENDPOINT, { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as { background?: LoginBackground | null; error?: string } | null;
      if (!res.ok || !body?.background) {
        toast.error(t(body?.error === "tooLarge" || res.status === 413 ? "loginBackground.tooLarge" : "loginBackground.notImage"));
        return;
      }
      await mutate({ background: body.background }, { revalidate: false });
      toast.success(t("loginBackground.saved"));
    } catch {
      toast.error(t("loginBackground.error"));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function commitDim(value: number) {
    const res = await fetch(ENDPOINT, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dim: value }) }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { background?: LoginBackground | null } | null;
    if (!res?.ok || !body?.background) toast.error(t("loginBackground.error"));
    else await mutate({ background: body.background }, { revalidate: false });
    setDimDraft(null);
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(ENDPOINT, { method: "DELETE" });
      if (!res.ok) return toast.error(t("loginBackground.error"));
      await mutate({ background: null }, { revalidate: false });
      toast.success(t("loginBackground.removed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfigCardFrame title={t("loginBackground.title")} hint={t("loginBackground.hint")}>
      <div className="space-y-4">
        <div className="relative isolate aspect-video w-full max-w-md overflow-hidden rounded-xl border border-white/10 bg-ink">
          {bg && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- l'image publique des écrans de connexion, déjà réduite en WebP */}
              <img src={`/api/login-background?v=${bg.v}`} alt={t("loginBackground.previewAlt")} className="absolute inset-0 -z-10 h-full w-full object-cover" />
              <div className="absolute inset-0 -z-10 bg-black" style={{ opacity: dim / 100 }} />
            </>
          )}
          <div className="flex h-full flex-col items-center justify-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- l'icône de l'application, comme sur l'écran de connexion */}
            <img src="/icon-192.png" alt="" width={28} height={28} className="h-7 w-7 rounded-lg" />
            <div className="h-16 w-36 rounded-xl border border-white/15 bg-white/[0.08] backdrop-blur-md" />
            {!bg && <p className="text-xs text-subtle">{t("loginBackground.none")}</p>}
          </div>
        </div>

        {bg && (
          <label className="block max-w-md">
            <span className="mb-1 flex justify-between text-xs text-subtle">
              <span>{t("loginBackground.dim")}</span>
              <span>{dim} %</span>
            </span>
            <input
              type="range"
              min={LOGIN_BACKGROUND_DIM_MIN}
              max={LOGIN_BACKGROUND_DIM_MAX}
              step={5}
              value={dim}
              onChange={(e) => setDimDraft(Number(e.target.value))}
              onPointerUp={(e) => commitDim(Number((e.target as HTMLInputElement).value))}
              onKeyUp={(e) => commitDim(Number((e.target as HTMLInputElement).value))}
              className="w-full accent-white"
            />
          </label>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {/* JPEG, PNG et WebP seulement : Safari convertit alors lui-même une photo HEIC de l'iPhone en JPEG. */}
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void send(file);
            }}
          />
          <button type="button" disabled={busy} onClick={() => input.current?.click()} className="btn btn-primary">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
            {bg ? t("loginBackground.replace") : t("loginBackground.choose")}
          </button>
          {bg && (
            <button type="button" disabled={busy} onClick={remove} className="btn btn-ghost text-danger">
              <Trash2 size={15} />
              {t("loginBackground.remove")}
            </button>
          )}
        </div>
        <p className="text-xs text-subtle">{t("loginBackground.limits")}</p>
      </div>
    </ConfigCardFrame>
  );
}
