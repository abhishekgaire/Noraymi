import type { MessageKey } from "@west4/shared";
import { useT } from "../i18n.js";

/**
 * A role's home until its screen ships: the board (Tonight), the bar POS and
 * the runner's Runs tab each land in their own ticket. The heading is the
 * menu's word for the screen, and the body is the shell's empty state.
 */
export function Home({ titleKey }: { titleKey: MessageKey }) {
  const { t } = useT();
  return (
    <section className="screen">
      <h1>{t(titleKey)}</h1>
      <p className="empty">{t("shell.empty")}</p>
    </section>
  );
}
