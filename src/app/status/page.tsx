"use client";

import Link from "next/link";
import { ArrowLeft, Clapperboard } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { CapabilitySection } from "@/components/CapabilityStatus";

// Standalone — deliberately outside the (dashboard) route group, so it renders with none of
// the Sidebar/MobileNav chrome that assumes a logged-in session. Reachable without logging in
// (see PUBLIC_PATHS in proxy.ts) so it still works when the rest of the app — or the login flow
// itself — is what's broken.
export default function PublicStatusPage() {
  const t = useT();

  return (
    <main className="min-h-screen bg-ink px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-accent-600/20 p-2 text-accent-400">
              <Clapperboard size={22} />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white">Cine App</h1>
              <p className="text-xs text-slate-400">{t('health.pageTitle')}</p>
            </div>
          </div>
          <Link href="/login" className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white">
            <ArrowLeft size={14} /> {t('common.back')}
          </Link>
        </div>

        <CapabilitySection />
      </div>
    </main>
  );
}
