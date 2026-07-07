"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import type { MdbRatings } from "@/app/api/mdblist/[imdbId]/route";

interface Props { imdbId: string | null | undefined }

function fmt(v: number, mode: "ten" | "pct" | "five"): string {
  if (mode === "ten")  return (v / 10).toFixed(1);
  if (mode === "five") return (v / 20).toFixed(1);
  return String(Math.round(v));
}

function Badge({ label, value, color, mode }: {
  label: string;
  value: number | null;
  color: string;
  mode: "ten" | "pct" | "five";
}) {
  if (value === null || value === 0) return null;
  const display = fmt(value, mode);
  const suffix = mode === "ten" ? "/10" : mode === "five" ? "/5" : "%";
  return (
    <span className={["inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold", color].join(" ")}>
      <span className="font-bold opacity-80">{label}</span>
      <span>{display}{suffix}</span>
    </span>
  );
}

export function MediaRatings({ imdbId }: Props) {
  const { data } = useSWR<{ ratings: MdbRatings | null }>(
    imdbId ? `/api/mdblist/${imdbId}` : null,
    fetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );

  const r = data?.ratings;
  if (!r) return null;

  const hasAny = Object.values(r).some((v) => v !== null && v !== 0);
  if (!hasAny) return null;

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <Badge label="IMDb"        value={r.imdb}        color="bg-amber-500/20 text-amber-300"   mode="ten"  />
      <Badge label="RT"          value={r.tomatoes}    color="bg-red-600/20 text-red-300"       mode="pct"  />
      <Badge label="Public"      value={r.tomatoesAudience} color="bg-orange-500/20 text-orange-300" mode="pct" />
      <Badge label="Metacritic"  value={r.metacritic}  color="bg-yellow-600/20 text-yellow-300" mode="pct"  />
      <Badge label="Letterboxd"  value={r.letterboxd}  color="bg-emerald-600/20 text-emerald-300" mode="five" />
      <Badge label="Trakt"       value={r.trakt}       color="bg-pink-600/20 text-pink-300"     mode="pct"  />
      <Badge label="TMDb"        value={r.tmdb}        color="bg-sky-600/20 text-sky-300"       mode="pct"  />
    </div>
  );
}
