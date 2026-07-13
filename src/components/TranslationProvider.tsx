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
  type Locale,
} from "@/lib/i18n";
import frDict from "@/locales/fr.json";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

interface TranslationContextValue {
  t: TFn;
  locale: Locale;
  setLocale: (l: Locale) => void;
}

const fr = frDict as Record<string, unknown>;
const defaultT = createT(fr, fr);

const TranslationContext = createContext<TranslationContextValue>({
  t: defaultT,
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
});

export function TranslationProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [t, setT] = useState<TFn>(() => defaultT);

  useEffect(() => {
    const detected = getLocaleFromCookie(document.cookie);
    if (detected === "fr") {
      setLocaleState("fr");
      setT(() => defaultT);
    } else {
      setLocaleState(detected);
      loadLocaleDict(detected).then((dict) => {
        setT(() => createT(dict, fr));
      });
    }
  }, []);

  const setLocale = useCallback((l: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${l};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
    setLocaleState(l);
    if (l === "fr") {
      setT(() => createT(fr, fr));
    } else {
      loadLocaleDict(l).then((dict) => {
        setT(() => createT(dict, fr));
      });
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
