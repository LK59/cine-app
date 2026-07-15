import Link from "next/link";

export default function NotFound() {
  return (
    <html lang="fr" className="dark">
      <body className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
        <div className="flex flex-col items-center gap-4 text-center px-4">
          <p className="text-6xl font-bold text-accent-500">404</p>
          <h1 className="text-xl font-semibold">Page introuvable</h1>
          <p className="text-sm text-slate-400 max-w-xs">
            Cette page n&apos;existe pas ou a été déplacée.
          </p>
          <Link
            href="/"
            className="mt-2 rounded-lg border border-white/10 bg-white/5 px-5 py-2 text-sm transition-colors hover:bg-white/10"
          >
            Retour à l&apos;accueil
          </Link>
        </div>
      </body>
    </html>
  );
}
