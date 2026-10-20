"use client";

import useSWR from "swr";
import { useT } from "@/components/TranslationProvider";
import { ShareTitleSheet } from "@/components/shareGuest/ShareTitleSheet";
import type { ShareTitlePayload } from "@/app/api/share/title/route";

/** La seule adresse d'où l'invité apprend ce qu'il peut regarder — voir la route. */
export const SHARE_TITLE_KEY = "/api/share/title";

/**
 * Le récupérateur commun (`fetcher`) ne garde que le code de la réponse ; ici, le statut compte aussi :
 * un 401 du proxy (session tombée avec le lien) n'a pas de code, et doit ramener au mot de passe.
 */
async function shareTitleFetcher(url: string): Promise<ShareTitlePayload> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw Object.assign(new Error(body.error || `Erreur ${res.status}`), { status: res.status, code: body.code });
  }
  return (await res.json()) as ShareTitlePayload;
}

/**
 * La page d'un lien de partage, une fois le mot de passe donné (DECISIONS.md §112) : son titre, et rien
 * d'autre.
 *
 * Relu toutes les trente secondes et au retour sur l'onglet : c'est ce qui dit si les lectures du lien
 * sont prises ailleurs (`playingElsewhere`), et ça change pendant qu'on regarde la fiche. SWR ne relit
 * rien pendant qu'un film tient l'écran (`isPaused`), et reprend à sa fermeture.
 *
 * Un refus (401, 403 : le lien a été révoqué, ou est arrivé à sa fin) ramène au mot de passe : la page,
 * rechargée, ne trouve plus de session et le demande — sans rien dire du titre.
 */
export function ShareTitleView() {
  const t = useT();
  const { data, error, mutate, isValidating } = useSWR<ShareTitlePayload>(SHARE_TITLE_KEY, shareTitleFetcher, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
    // Garder la fiche affichée si une relecture échoue en passant : une coupure d'une seconde ne doit
    // pas effacer la page sous les yeux.
    keepPreviousData: true,
  });

  const status = (error as { status?: number } | undefined)?.status;
  const code = (error as { code?: string } | undefined)?.code;
  // Le lien n'est plus valable : la page rechargée redemande le mot de passe. Même sous une fiche déjà
  // affichée — elle ne mènerait plus qu'à des refus.
  const gone = !!error && (code === "share-scope" || status === 401 || status === 403);

  if (data && !gone) return <ShareTitleSheet payload={data} />;

  if (error) {
    const missing = code === "title_not_found";
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-ink px-6 text-center">
        <p role="alert" className="max-w-sm text-sm text-slate-300">
          {gone ? t("share.guest.errors.gone") : missing ? t("share.guest.errors.titleMissing") : t("share.guest.errors.loadFailed")}
        </p>
        <button
          type="button"
          disabled={isValidating}
          onClick={() => (gone ? window.location.reload() : void mutate())}
          className="btn settings-glass-btn rounded-full px-4 py-2 text-sm disabled:opacity-60"
        >
          {gone ? t("share.guest.enterPassword") : t("common.retry")}
        </button>
      </main>
    );
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-ink" aria-busy="true">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
    </div>
  );
}
