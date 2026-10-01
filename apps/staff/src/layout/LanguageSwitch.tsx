import { useState } from "react";
import { localeNames, locales } from "@west4/shared";
import { useT } from "../i18n.js";
import { useSession } from "../session.js";

/**
 * "English · Español" (spec 02 · Languages): each language named in itself.
 * Signed in, the choice is saved on the person's membership; signed out, on
 * this device for the sign-in screen.
 */
export function LanguageSwitch() {
  const { t, locale } = useT();
  const { setLocale } = useSession();
  const [error, setError] = useState(false);
  return (
    <div className="language" role="group" aria-label={t("language.label")}>
      {locales.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === locale}
          aria-label={t("language.switchTo", { language: localeNames[l] })}
          onClick={() => {
            setError(false);
            setLocale(l).catch(() => setError(true));
          }}
        >
          {localeNames[l]}
        </button>
      ))}
      {error && (
        <span className="error" role="alert">
          {t("shell.error.title")}
        </span>
      )}
    </div>
  );
}
