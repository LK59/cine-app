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

export function TranslationProvider({
  children,
  initialLocale,
  initialDict,
}: {
  children: React.ReactNode;
  // Resolved server-side (from the lang cookie) so the very first paint —
  // SSR and hydration alike — is already in the right language instead of
  // flashing the instance default (fr) for a moment.
  initialLocale?: Locale;
  initialDict?: Record<string, unknown>;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? DEFAULT_LOCALE);
  const [t, setT] = useState<TFn>(() =>
    initialDict ? createT(initialDict, fr) : defaultT
  );

  useEffect(() => {
    const cookieLang = getLocaleFromCookie(document.cookie);

    function applyLocale(l: Locale) {
      setLocaleState(l);
      if (l === "fr") {
        setT(() => defaultT);
      } else {
        loadLocaleDict(l).then((dict) => setT(() => createT(dict, fr)));
      }
    }

    // The server already resolved the correct locale from the cookie (see
    // layout.tsx) — only fall back to re-deriving it here if that prop is
    // somehow missing.
    if (!initialLocale) {
      applyLocale(cookieLang ?? DEFAULT_LOCALE);
    }

    // Fetch runtime config + user prefs in parallel — both work without baked-in env vars
    Promise.all([
      fetch("/api/config/public").then((r) => r.ok ? r.json() : null).catch(() => null),
      fetch("/api/user/preferences").then((r) => r.ok ? r.json() : null).catch(() => null),
    ]).then(([pub, prefs]) => {
      const instanceDefault: Locale =
        pub?.defaultLang && LOCALES.includes(pub.defaultLang as Locale)
          ? pub.defaultLang as Locale
          : DEFAULT_LOCALE;

      const serverLang: Locale | null =
        prefs?.lang && LOCALES.includes(prefs.lang as Locale)
          ? prefs.lang as Locale
          : null;

      const target = serverLang ?? instanceDefault;

      if (cookieLang !== null && target !== cookieLang) {
        // Cookie exists but out of sync (cross-device change) → update + reload
        document.cookie = `${LOCALE_COOKIE}=${target};path=/;max-age=${60 * 60 * 24 * 365};samesite=lax`;
        window.location.reload();
      } else if (cookieLang === null) {
        // No cookie yet (pre-login) → apply instance default to UI without setting cookie
        // The cookie will be set correctly at login
        applyLocale(target);
      }
    });
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
