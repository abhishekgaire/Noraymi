import { Link } from "react-router";
import { useT } from "../i18n.js";

export function NotFound() {
  const { t } = useT();
  return (
    <section className="screen">
      <h1>{t("shell.notFound")}</h1>
      <Link to="/" className="button secondary">
        {t("shell.notFound.home")}
      </Link>
    </section>
  );
}
