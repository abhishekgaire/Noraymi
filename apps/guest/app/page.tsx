import { t } from "@west4/shared";

// Placeholder until the venue site lands (M5). Strings come from the shared catalog.
export default function Home() {
  return (
    <main>
      <h1>{t("en", "app.guest.name")}</h1>
      <p>{t("en", "scaffold.placeholder")}</p>
    </main>
  );
}
