"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  createT,
  DEFAULT_LOCALE,
  getLocaleFromCookie,
  loadLocaleDict,
  LOCALE_COOKIE,
  LOCALES,
  type Locale,
} from "@/lib/i18n";
import frDict from "@/locales/fr.json";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

interface TranslationContextValue {
  t: TFn;
  locale: Locale;
  setLocale: (l: Locale) => Promise<void>;
}

const fr = frDict as Record<string, unknown>;
const defaultT = createT(fr, fr);

const TranslationContext = createContext<TranslationContextValue>({
  t: defaultT,
  locale: DEFAULT_LOCALE,
  setLocale: () => Promise.resolve(),
});

export function TranslationProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [t, setT] = useState<TFn>(() => defaultT);

  useEffect(() => {
    const instanceDefault = (process.env.NEXT_PUBLIC_APP_LANGUAGE as Locale | undefined);
    const fallback: Locale = (instanceDefault && LOCALES.includes(instanceDefault)) ? instanceDefault : DEFAULT_LOCALE;
    const cookieLang = getLocaleFromCookie(document.cookie);
    const detected = cookieLang ?? fallback;

    function applyLocale(l: Locale) {
      setLocaleState(l);
      if (l === "fr") {
        setT(() => defaultT);
      } else {
        loadLocaleDict(l).then((dict) => setT(() => createT(dict, fr)));
      }
    }

    applyLocale(detected);

    // Sync with DB preference — catches cross-device changes without requiring re-login
    fetch("/api/user/preferences")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        const serverLang = data?.lang as string | undefined;
        if (serverLang && LOCALES.includes(serverLang as Locale) && serverLang !== detected) {
          document.cookie = `${LOCALE_COOKIE}=${serverLang};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
          window.location.reload();
        }
      })
      .catch(() => null);
  }, []);

  const setLocale = useCallback(async (l: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${l};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
    await fetch("/api/user/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: l }),
    }).catch(() => null);
    setLocaleState(l);
    if (l === "fr") {
      setT(() => createT(fr, fr));
    } else {
      const dict = await loadLocaleDict(l);
      setT(() => createT(dict, fr));
    }
  }, []);

  return (
    <TranslationContext.Provider value={{ t, locale, setLocale }}>
      {children}
    </TranslationContext.Provider>
  );
}

export function useT() {
  return useContext(TranslationContext).t;
}

export function useLocale() {
  const { locale, setLocale } = useContext(TranslationContext);
  return { locale, setLocale };
}
