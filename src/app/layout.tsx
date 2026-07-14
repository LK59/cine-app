import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import { SWRProvider } from "@/components/SWRProvider";
import { ToastProvider } from "@/components/Toast";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TranslationProvider } from "@/components/TranslationProvider";
import { LOCALES, LOCALE_COOKIE, type Locale } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Cine App",
  description: "Tableau de bord unifié pour la stack média",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Cine App",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#020617",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const rawLang = (await cookies()).get(LOCALE_COOKIE)?.value ?? "";
  const lang: Locale = LOCALES.includes(rawLang as Locale) ? rawLang as Locale : "fr";
  return (
    <html lang={lang} className="dark">
      <head>
        {/* Apply saved theme before first paint to avoid flash */}
        <script dangerouslySetInnerHTML={{ __html: `try{var a=localStorage.getItem("cine-accent")||"violet";document.documentElement.dataset.accent=a;if(localStorage.getItem("cine-amoled")==="1")document.documentElement.dataset.amoled="";}catch(e){}` }} />
      </head>
      <body>
        <TranslationProvider>
          <ThemeProvider>
            <SWRProvider>
              <ToastProvider>{children}</ToastProvider>
            </SWRProvider>
          </ThemeProvider>
        </TranslationProvider>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
