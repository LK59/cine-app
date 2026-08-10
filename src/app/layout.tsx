import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import { UpdateBanner } from "@/components/UpdateBanner";
import { SWRProvider } from "@/components/SWRProvider";
import { ToastProvider } from "@/components/Toast";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TranslationProvider } from "@/components/TranslationProvider";
import { LOCALES, LOCALE_COOKIE, loadLocaleDict, type Locale } from "@/lib/i18n";
import { InstallPrompt } from "@/components/InstallPrompt";

// Portrait iOS splash screens, keyed by CSS width/height/DPR so Safari picks
// the right one for the device at launch (avoids the blank flash).
const SPLASH_SCREENS: { width: number; height: number; dpr: number; file: string }[] = [
  { width: 430, height: 932, dpr: 3, file: "1290-2796" },
  { width: 393, height: 852, dpr: 3, file: "1179-2556" },
  { width: 390, height: 844, dpr: 3, file: "1170-2532" },
  { width: 428, height: 926, dpr: 3, file: "1284-2778" },
  { width: 375, height: 812, dpr: 3, file: "1125-2436" },
  { width: 414, height: 896, dpr: 3, file: "1242-2688" },
  { width: 414, height: 896, dpr: 2, file: "828-1792" },
  { width: 414, height: 736, dpr: 3, file: "1242-2208" },
  { width: 375, height: 667, dpr: 2, file: "750-1334" },
  { width: 320, height: 568, dpr: 2, file: "640-1136" },
];

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
  interactiveWidget: "resizes-content",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const rawLang = (await cookies()).get(LOCALE_COOKIE)?.value ?? "";
  const lang: Locale = LOCALES.includes(rawLang as Locale) ? rawLang as Locale : "fr";
  const dict = await loadLocaleDict(lang);
  return (
    <html lang={lang} className={`dark ${inter.variable}`}>
      <head>
        {/* Apply saved theme before first paint to avoid flash */}
        <script dangerouslySetInnerHTML={{ __html: `try{var a=localStorage.getItem("cine-accent")||"violet";document.documentElement.dataset.accent=a;if(localStorage.getItem("cine-amoled")==="1")document.documentElement.dataset.amoled="";}catch(e){}` }} />
        {SPLASH_SCREENS.map((s) => (
          <link
            key={s.file}
            rel="apple-touch-startup-image"
            href={`/splash/apple-splash-${s.file}.png`}
            media={`(device-width: ${s.width}px) and (device-height: ${s.height}px) and (-webkit-device-pixel-ratio: ${s.dpr}) and (orientation: portrait)`}
          />
        ))}
      </head>
      <body>
        <TranslationProvider initialLocale={lang} initialDict={dict}>
          <ThemeProvider>
            <SWRProvider>
              <ToastProvider>{children}</ToastProvider>
            </SWRProvider>
          </ThemeProvider>
          <UpdateBanner />
          <InstallPrompt />
        </TranslationProvider>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
