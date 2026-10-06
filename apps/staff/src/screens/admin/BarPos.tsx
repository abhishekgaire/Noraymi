import { useCallback, useEffect, useState } from "react";
import { POS_SECTIONS, addToSection, type PosLayoutSections, type PosSection } from "@west4/shared";
import { api, ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { BarPosSettings } from "./BarPosSettings.js";

/**
 * Admin → Bar POS · Layout (M6-01; screens N33; Staff screens and the bar POS
 * · rule 2): the station's ten sections, 25 fixed slots each, every item by
 * its button name. Adding an item takes the first empty slot and nothing
 * else moves; a slot can be emptied. Save keeps a draft; Publish starts it at
 * the next business date ("Starts Sat Sep 26"), and tonight keeps its buttons.
 * The rest of the section (limits, locks, tip path, order aging, tabs) is
 * BarPosSettings (M6-25), saved through Save and publish.
 */
interface Layouts {
  readonly station: string;
  readonly tonight: { id: string; version: number; sections: PosLayoutSections } | null;
  readonly next: { id: string; version: number; starts_on: string } | null;
  readonly draft: { id: string; sections: PosLayoutSections } | null;
}
interface MenuItem {
  readonly id: string;
  readonly name: string;
  readonly button_name: string | null;
}

export function BarPos() {
  const { t, date } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [layouts, setLayouts] = useState<Layouts | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [sections, setSections] = useState<PosLayoutSections | null>(null);
  const [section, setSection] = useState<PosSection>("favorites");
  const [adding, setAdding] = useState("");
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const take = (l: Layouts) => {
    setLayouts(l);
    setSections(l.draft?.sections ?? l.tonight?.sections ?? null);
  };
  const load = useCallback(async () => {
    try {
      const [l, m] = await Promise.all([
        api<Layouts>("GET", `/v1/venues/${venueId}/pos/layouts?station=bar`),
        api<{ categories: { items: MenuItem[] }[] }>("GET", `/v1/venues/${venueId}/menu`),
      ]);
      take(l);
      setItems(m.categories.flatMap((c) => c.items));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    if (venueId) void load();
  }, [venueId, load]);

  const label = (id: string) => {
    const item = items.find((i) => i.id === id);
    return item ? (item.button_name ?? item.name) : "?";
  };
  const slots = sections?.[section] ?? [];
  const set = (next: (string | null)[]) =>
    sections && setSections({ ...sections, [section]: next });

  const save = async () => {
    if (!sections) return null;
    setNote(null);
    setProblem(null);
    try {
      const l = await api<Layouts>("POST", `/v1/venues/${venueId}/pos/layouts`, {
        station: "bar",
        sections,
      });
      take(l);
      setNote(t("barPos.saved"));
      return l;
    } catch (e) {
      setProblem(e instanceof ApiCallError ? e.message : t("shell.error.cantReach"));
      return null;
    }
  };
  const publish = async () => {
    const saved = await save();
    if (!saved?.draft) return;
    try {
      const r = await api<{ published: { version: number; starts_on: string }; layouts: Layouts }>(
        "POST",
        `/v1/venues/${venueId}/pos/layouts/${saved.draft.id}/publish`,
      );
      take(r.layouts);
      setNote(t("barPos.published", { n: r.published.version, date: date(r.published.starts_on) }));
    } catch (e) {
      setProblem(e instanceof ApiCallError ? e.message : t("shell.error.cantReach"));
    }
  };

  return (
    <section className="bar-pos">
      <h2>{t("admin.section.barPos")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {layouts === null || sections === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          <h3>{t("barPos.layout")}</h3>
          <p className="small muted">
            {layouts.tonight && t("barPos.tonight", { n: layouts.tonight.version })}
            {layouts.next &&
              ` · ${t("barPos.next", { n: layouts.next.version, date: date(layouts.next.starts_on) })}`}
          </p>
          <div className="sections" role="tablist" aria-label={t("barPos.sections")}>
            {POS_SECTIONS.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={s === section}
                className={s === section ? "chip on" : "chip"}
                onClick={() => setSection(s)}
              >
                {t(`barPos.section.${s}`)}
              </button>
            ))}
          </div>
          <ol className="slots" aria-label={t(`barPos.section.${section}`)}>
            {slots.map((id, i) => (
              <li key={i} className={id ? "slot" : "slot empty"}>
                {id ? (
                  <>
                    <span data-guest-text>{label(id)}</span>
                    <button
                      type="button"
                      className="link"
                      aria-label={t("barPos.clearSlot", { name: label(id) })}
                      onClick={() => set(slots.map((x, j) => (j === i ? null : x)))}
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <span className="muted">{t("barPos.empty")}</span>
                )}
              </li>
            ))}
          </ol>
          <div className="actions">
            <label>
              <span>{t("barPos.add")}</span>
              <select
                aria-label={t("barPos.add")}
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
              >
                <option value="">{t("barPos.pick")}</option>
                {items
                  .filter((i) => !slots.includes(i.id))
                  .map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.button_name ?? i.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary"
              disabled={!adding}
              onClick={() => {
                const next = addToSection(slots, adding);
                if (next) {
                  set(next);
                  setAdding("");
                  setProblem(null);
                } else setProblem(t("barPos.full"));
              }}
            >
              {t("barPos.addButton")}
            </button>
          </div>
          {problem && (
            <p className="error" role="alert">
              {problem}
            </p>
          )}
          {note && <p role="status">{note}</p>}
          <div className="actions">
            <button type="button" className="secondary" onClick={() => void save()}>
              {t("barPos.save")}
            </button>
            <button type="button" onClick={() => void publish()}>
              {t("barPos.publish")}
            </button>
          </div>
          <p className="small muted">{t("barPos.hint")}</p>
        </>
      )}
      {venueId && <BarPosSettings venueId={venueId} />}
    </section>
  );
}
