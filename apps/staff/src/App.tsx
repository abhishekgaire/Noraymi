import { t, type Locale } from "@west4/shared";

// Placeholder until the app shell lands. Every visible string comes from the
// shared catalog; the locale picker arrives with M1-21.
const locale: Locale = "en";

export function App() {
  return (
    <main>
      <h1>{t(locale, "app.staff.name")}</h1>
      <p>{t(locale, "scaffold.placeholder")}</p>
    </main>
  );
}
