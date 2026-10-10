import { useCallback, useEffect, useState } from "react";
import { api, ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * A package on a room's tab (K-09; spec 16 · Food in packages). [Add a package] lists the packages
 * staff can sell; choosing one asks for its picks (a required choice, like the wings' sauce), then
 * Add makes a staff order accepted at once: its drinks print at the bar, its food reads Not sent
 * until Send to kitchen. The tab lists the package's lines under its name. Shown only while the
 * Packages module is on and the venue has a package to sell.
 */
interface Group {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly min_choices: number;
  readonly max_choices: number;
  readonly options: readonly { readonly id: string; readonly name: string }[];
}
interface Content {
  readonly item_id: string;
  readonly name: string | null;
  readonly qty: number;
  readonly food: boolean;
  readonly available: boolean;
  readonly groups: readonly Group[];
}
interface Pkg {
  readonly id: string;
  readonly name: string;
  readonly price_cents: number;
  readonly contents: readonly Content[];
}
export interface PackageLine {
  readonly id: number;
  readonly kind: string;
  readonly description: string;
  readonly amount_cents: number;
  readonly package?: { readonly id: string; readonly name: string } | undefined;
}

const needs = (g: Group) => g.required || g.min_choices > 0;

export function AddPackage(props: {
  venueId: string;
  checkId: string;
  lines: readonly PackageLine[];
  onAdded: () => void;
}) {
  const { t, money } = useT();
  const [packages, setPackages] = useState<readonly Pkg[] | null>(null);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Pkg | null>(null);
  const [picks, setPicks] = useState<Record<number, readonly string[]>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ packages: Pkg[] }>("GET", `/v1/venues/${props.venueId}/package-menu`);
      setPackages(r.packages);
    } catch {
      // The Packages module is off, or the list can't load: the button stays hidden.
      setPackages([]);
    }
  }, [props.venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  const grouped = new Map<string, PackageLine[]>();
  for (const l of props.lines)
    if (l.kind === "item" && l.package)
      grouped.set(l.package.name, [...(grouped.get(l.package.name) ?? []), l]);

  const toggle = (n: number, g: Group, id: string) => {
    const mine = picks[n] ?? [];
    const inGroup = mine.filter((p) => g.options.some((o) => o.id === p));
    let next: readonly string[];
    if (mine.includes(id)) next = mine.filter((p) => p !== id);
    else if (g.max_choices <= 1) next = [...mine.filter((p) => !inGroup.includes(p)), id];
    else if (inGroup.length >= g.max_choices) return;
    else next = [...mine, id];
    setPicks({ ...picks, [n]: next });
  };
  const missing = chosen?.contents.some((c, n) =>
    c.groups.some((g) => needs(g) && !g.options.some((o) => (picks[n] ?? []).includes(o.id))),
  );
  const sellable = (p: Pkg) => p.contents.every((c) => c.available);

  const add = async () => {
    if (!chosen) return;
    setBusy(true);
    setMessage(null);
    try {
      await api("POST", `/v1/venues/${props.venueId}/checks/${props.checkId}/packages`, {
        package_id: chosen.id,
        client_order_id: crypto.randomUUID(),
        picks: chosen.contents.map((_, n) => ({ option_ids: picks[n] ?? [] })),
      });
      setMessage(t("packages.added", { name: chosen.name }));
      setChosen(null);
      setOpen(false);
      setPicks({});
      props.onAdded();
    } catch (e) {
      setMessage(
        t("packages.error", { reason: e instanceof ApiCallError ? e.message : String(e) }),
      );
    } finally {
      setBusy(false);
    }
  };

  if (packages === null) return <p className="small muted">{t("packages.loading")}</p>;
  if (packages.length === 0 && grouped.size === 0) return null;
  return (
    <section className="add-package" aria-label={t("packages.title")}>
      {grouped.size > 0 && (
        <div className="package-lines">
          <h3>{t("packages.onTab")}</h3>
          {[...grouped].map(([name, ls]) => (
            <div key={name} className="package-group">
              <p>
                <strong data-guest-text>{name}</strong>{" "}
                {money(ls.reduce((s, l) => s + l.amount_cents, 0) as never)}
              </p>
              <ul>
                {ls.map((l) => (
                  <li key={l.id}>
                    <span data-guest-text>{l.description}</span> {money(l.amount_cents as never)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      {packages.length > 0 && !open && (
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          {t("packages.add")}
        </button>
      )}
      {open && !chosen && (
        <div className="sheet" role="dialog" aria-label={t("packages.choose")}>
          <h3>{t("packages.choose")}</h3>
          <div className="choice-row">
            {packages.map((p) => (
              <button
                key={p.id}
                type="button"
                className="chip"
                disabled={!sellable(p)}
                onClick={() => {
                  setChosen(p);
                  setPicks({});
                }}
              >
                <span data-guest-text>{p.name}</span> {money(p.price_cents as never)}
                {!sellable(p) && ` · ${t("packages.unavailable")}`}
              </button>
            ))}
          </div>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              {t("packages.cancel")}
            </button>
          </div>
        </div>
      )}
      {chosen && (
        <div className="sheet food-choices" role="dialog" aria-label={chosen.name}>
          <h3 data-guest-text>{chosen.name}</h3>
          <ul className="small">
            {chosen.contents.map((c, n) => (
              <li key={n}>
                <span data-guest-text>
                  {t("packages.contents", { qty: c.qty, name: c.name ?? "" })}
                </span>
                {c.food && <span className="kchip"> {t("kitchen.chip")}</span>}
              </li>
            ))}
          </ul>
          {chosen.contents.flatMap((c, n) =>
            c.groups.map((g) => (
              <fieldset key={`${n}:${g.id}`}>
                <legend>
                  {needs(g)
                    ? t("kitchen.choices.pickOne", { group: g.name })
                    : t("kitchen.choices.optional", { group: g.name })}{" "}
                  · <span data-guest-text>{t("packages.pick", { name: c.name ?? "" })}</span>
                </legend>
                <div className="choice-row">
                  {g.options.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      className={(picks[n] ?? []).includes(o.id) ? "chip on" : "chip"}
                      aria-pressed={(picks[n] ?? []).includes(o.id)}
                      onClick={() => toggle(n, g, o.id)}
                    >
                      <span data-guest-text>{o.name}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
            )),
          )}
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setChosen(null)}>
              {t("packages.cancel")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || missing}
              onClick={() => void add()}
            >
              {t("packages.addButton", { price: money(chosen.price_cents as never) })}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
