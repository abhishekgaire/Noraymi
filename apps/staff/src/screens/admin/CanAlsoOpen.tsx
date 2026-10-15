import { useEffect, useState } from "react";
import { grantableAdminSections, type GrantableAdminSection, type Role } from "@west4/shared";
import { adminSections } from "../../admin/sections.js";
import { useT } from "../../i18n.js";

/**
 * Admin → Team → a person → Can also open (P-10; spec 02 · Roles): the Admin sections the owner
 * gives one person on top of their role. Never Payments, Team or Console; an owner or a manager
 * already opens every section that can be given. Saving asks for the passkey again (the Team
 * screen's own change), and the person still needs a passkey to open Admin.
 */
export function CanAlsoOpen({
  name,
  role,
  granted,
  disabled,
  onSave,
}: {
  name: string;
  role: Role;
  granted: readonly string[];
  disabled: boolean;
  onSave: (sections: GrantableAdminSection[]) => Promise<void>;
}) {
  const { t } = useT();
  const [picked, setPicked] = useState<readonly string[]>(granted);
  const [open, setOpen] = useState(false);
  useEffect(() => setPicked(granted), [granted]);
  if (role === "owner" || role === "manager")
    return <span className="small muted">{t("team.alsoOpen.roleHasAll")}</span>;
  const labelOf = (id: string) => {
    const s = adminSections.find((x) => x.id === id);
    return s ? t(s.labelKey) : id;
  };
  const changed = picked.length !== granted.length || picked.some((s) => !granted.includes(s));
  return (
    <details
      className="also-open"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary aria-label={t("team.alsoOpen.for", { name })}>
        {granted.length === 0 ? t("team.alsoOpen.none") : granted.map(labelOf).join(", ")}
      </summary>
      <fieldset>
        <legend className="small muted">{t("team.alsoOpen.hint")}</legend>
        {grantableAdminSections.map((id) => (
          <label key={id} className="check">
            <input
              type="checkbox"
              checked={picked.includes(id)}
              disabled={disabled}
              onChange={(e) =>
                setPicked((now) => (e.target.checked ? [...now, id] : now.filter((x) => x !== id)))
              }
            />{" "}
            {labelOf(id)}
          </label>
        ))}
        <button
          type="button"
          className="primary"
          disabled={disabled || !changed}
          onClick={() =>
            void onSave(grantableAdminSections.filter((s) => picked.includes(s))).then(() =>
              setOpen(false),
            )
          }
        >
          {t("team.alsoOpen.save")}
        </button>
      </fieldset>
    </details>
  );
}
