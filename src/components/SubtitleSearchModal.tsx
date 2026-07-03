"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { Modal } from "@/components/Modal";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateViews";
import { Download, Captions } from "lucide-react";
import type { BazarrSubtitleCandidate } from "@/lib/clients/bazarr";
import { useToast } from "@/components/Toast";

export function SubtitleSearchModal({
  title,
  searchEndpoint,
  downloadEndpoint,
  downloadExtra,
  onClose,
}: {
  title: string;
  searchEndpoint: string;
  downloadEndpoint: string;
  downloadExtra?: Record<string, unknown>;
  onClose: () => void;
}) {
  const { data, error, isLoading } = useSWR<{ data: BazarrSubtitleCandidate[] }>(
    searchEndpoint,
    fetcher,
    { revalidateOnFocus: false }
  );
  const toast = useToast();
  const [downloading, setDownloading] = useState<number | null>(null);
  const [downloaded, setDownloaded] = useState<Set<number>>(new Set());
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function download(candidate: BazarrSubtitleCandidate, index: number) {
    setDownloading(index);
    setDownloadError(null);
    try {
      const res = await fetch(downloadEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...downloadExtra, candidate }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Échec du téléchargement");
      }
      setDownloaded((prev) => new Set(prev).add(index));
      toast.success(`Sous-titre téléchargé · ${candidate.language}`);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Erreur inconnue");
      toast.error("Échec du téléchargement");
    } finally {
      setDownloading(null);
    }
  }

  const candidates = data?.data ?? [];
  const sorted = [...candidates].sort((a, b) => b.score - a.score);

  return (
    <Modal title={title} onClose={onClose} wide>
      {isLoading && <LoadingState label="Recherche sur les fournisseurs de sous-titres..." />}
      {error && <ErrorState message={error.message || "Recherche impossible."} />}
      {downloadError && <ErrorState message={downloadError} />}
      {data && sorted.length === 0 && <EmptyState label="Aucun sous-titre trouvé." />}

      {sorted.length > 0 && (
        <div className="scrollbar-thin max-h-[60vh] space-y-2 overflow-y-auto">
          {sorted.map((c, index) => (
            <div key={index} className="rounded-lg border border-white/5 bg-white/5 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm text-white">
                    <Captions size={14} className="text-accent-400" />
                    {c.language}
                    {c.forced === "True" && <span className="badge bg-amber-500/15 text-amber-400">Forcé</span>}
                    {c.hearing_impaired === "True" && (
                      <span className="badge bg-sky-500/15 text-sky-400">HI</span>
                    )}
                    <span className="badge bg-accent-600/15 text-accent-400">Score {c.score}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-500" title={c.release_info?.join(", ")}>
                    {c.provider} · {c.release_info?.join(", ") || "release inconnue"}
                  </p>
                </div>
                <button
                  className="btn-primary shrink-0"
                  disabled={downloading === index || downloaded.has(index)}
                  onClick={() => download(c, index)}
                >
                  <Download size={14} />
                  {downloaded.has(index) ? "Téléchargé" : downloading === index ? "..." : "Télécharger"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
