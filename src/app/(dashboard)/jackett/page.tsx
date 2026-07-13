"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateViews";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import type { JackettIndexer } from "@/lib/clients/jackett";
import { useRole } from "@/lib/useRole";
import { useT } from "@/components/TranslationProvider";

type TestState = "idle" | "testing" | "ok" | "fail";

export default function JackettPage() {
  const { isGuest } = useRole();
  const t = useT();
  const { data, error, isLoading } = useSWR<JackettIndexer[]>("/api/jackett/indexers", fetcher);
  const [testResults, setTestResults] = useState<Record<string, TestState>>({});

  async function test(id: string) {
    setTestResults((prev) => ({ ...prev, [id]: "testing" }));
    try {
      const res = await fetch(`/api/jackett/indexers/${id}/test`, { method: "POST" });
      const { ok } = await res.json();
      setTestResults((prev) => ({ ...prev, [id]: ok ? "ok" : "fail" }));
    } catch {
      setTestResults((prev) => ({ ...prev, [id]: "fail" }));
    }
  }

  return (
    <div>
      <PageHeader
        title={t('jackett.pageTitle')}
        subtitle={data ? t('jackett.subtitle', { n: data.length }) : undefined}
      />

      {isLoading && <LoadingState />}
      {error && <ErrorState message={error.message || t('jackett.serviceDown')} />}
      {data && data.length === 0 && <EmptyState label={t('jackett.noIndexers')} />}

      {data && data.length > 0 && (
        <div className="card divide-y divide-white/5">
          {data.map((indexer) => {
            const state = testResults[indexer.id] ?? "idle";
            return (
              <div key={indexer.id} className="flex items-center justify-between p-3">
                <div>
                  <p className="text-sm font-medium text-white">{indexer.name}</p>
                  <p className="text-xs text-slate-500">{indexer.type}</p>
                </div>
                <div className="flex items-center gap-3">
                  {state === "ok" && (
                    <span className="badge bg-emerald-500/15 text-emerald-400">
                      <CheckCircle2 size={12} /> OK
                    </span>
                  )}
                  {state === "fail" && (
                    <span className="badge bg-red-500/15 text-red-400">
                      <XCircle size={12} /> {t('jackett.testFailed')}
                    </span>
                  )}
                  {!isGuest && (
                    <button
                      className="btn-ghost px-2 py-1 text-xs"
                      disabled={state === "testing"}
                      onClick={() => test(indexer.id)}
                    >
                      {state === "testing" ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        t('jackett.testButton')
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
