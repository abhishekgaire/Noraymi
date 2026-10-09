import { useCallback, useEffect, useState, type FormEvent } from "react";
import { foodCategories, moveCategory, stateOf, type MessageKey } from "@west4/shared";
import { api, type ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { dollarsToCents } from "./Prices.js";

/**
 * Admin → Menu (M3-04; screens.md · AdminDesk notes 3 and 15; spec 03 ·
 * Promotion checks): categories, items with their button name and alcohol
 * flag, variants and choices, shown or hidden, 86 tonight, and, with Packages
 * & specials on, packages and dated price rules (in place of the canvas's
 * free-text happy-hour line). Every edit is held on this screen until Save;
 * the server runs the rule pack's promotion checks and a refusal shows its
 * reason. 86 takes effect at once, like the bar's own 86.
 */
interface Option {
  readonly id: string;
  readonly name: string;
  readonly price_delta_cents: number;
  readonly is_default: boolean;
  readonly out_tonight: boolean;
}
interface Group {
  readonly id: string;
  readonly name: string;
  readonly required: boolean;
  readonly options: readonly Option[];
}
interface Variant {
  readonly id: string;
  readonly name: string;
  readonly price_cents: number;
  readonly out_tonight: boolean;
}
interface Item {
  readonly id: string;
  readonly category_id: string;
  readonly name: string;
  readonly button_name: string | null;
  readonly description: string | null;
  readonly alcohol: boolean;
  /** bar or kitchen (K-02): shown and chosen only while Kitchen & food is on. */
  readonly station: string;
  readonly shown: boolean;
  readonly out_tonight: boolean;
  readonly variants: readonly Variant[];
  readonly groups: readonly Group[];
}
interface Category {
  readonly id: string;
  readonly name: string;
  readonly sort: number;
  readonly tax_category: string;
  readonly items: readonly Item[];
}
interface Package {
  readonly id: string;
  readonly name: string;
  readonly price_cents: number;
  readonly hourly: boolean;
  readonly private_function_only: boolean;
  readonly shown: boolean;
  readonly contents: readonly { item_id: string; qty: number | null }[];
}
interface PriceRule {
  readonly id: string;
  readonly name: string;
  readonly kind: "happy_hour" | "special" | "hourly";
  readonly days: readonly number[];
  readonly from_min: number | null;
  readonly to_min: number | null;
  readonly target: { item_ids: readonly string[]; qty?: number };
  readonly pct_off: number | null;
  readonly price_cents: number | null;
  readonly starts_on: string | null;
  readonly ends_on: string | null;
  readonly shown: boolean;
}

const DAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const KINDS = ["happy_hour", "special", "hourly"] as const;
const money = (cents: number) =>
  `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
const centsText = (cents: number) => money(cents).slice(1);
const hhmm = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
/** "20:00" as minutes from the business date's midnight; before 6:00 AM counts as after midnight. */
const minutesOf = (value: string) => {
  const [h, m] = value.split(":").map(Number) as [number, number];
  const min = h * 60 + m;
  return min < 6 * 60 ? min + 24 * 60 : min;
};

export function Menu() {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const packagesOn =
    state.status === "signedIn" && stateOf(state.membership.modules, "packages") !== "off";
  // Station, and the food categories' names and order (K-02; D100), only while Kitchen & food is on.
  const kitchenOn =
    state.status === "signedIn" && stateOf(state.membership.modules, "kitchen") !== "off";
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [packages, setPackages] = useState<Package[]>([]);
  const [rules, setRules] = useState<PriceRule[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const tree = await api<{ categories: Category[] }>(
      "GET",
      `/v1/venues/${venueId}/menu?include_hidden=true`,
    );
    setCategories(tree.categories);
    if (packagesOn) {
      const [p, r] = await Promise.all([
        api<{ items: Package[] }>("GET", `/v1/venues/${venueId}/packages`),
        api<{ items: PriceRule[] }>("GET", `/v1/venues/${venueId}/price-rules`),
      ]);
      setPackages(p.items);
      setRules(r.items);
    }
  }, [venueId, packagesOn]);

  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load]);

  /** Runs one or more saves; a refusal shows the server's reason and keeps the form open. */
  const run = async (work: () => Promise<unknown>, done?: string) => {
    setError(null);
    setMessage(null);
    try {
      await work();
      await load();
      if (done) setMessage(done);
      return true;
    } catch (e) {
      setError((e as ApiCallError)?.message ?? t("menuAdmin.failed"));
      return false;
    }
  };
  const call = (method: "POST" | "PATCH", path: string, body: unknown) =>
    api(method, `/v1/venues/${venueId}${path}`, body);

  const allItems = (categories ?? []).flatMap((c) => c.items);
  const food = kitchenOn ? foodCategories(categories ?? []) : [];
  const itemName = (id: string) => allItems.find((i) => i.id === id)?.name ?? "?";

  if (failed)
    return (
      <section className="menu-admin">
        <h2>{t("admin.section.menu")}</h2>
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      </section>
    );

  return (
    <section className="menu-admin">
      <h2>{t("admin.section.menu")}</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      {categories === null ? (
        <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          {categories.length === 0 && <p className="muted">{t("menuAdmin.empty")}</p>}
          {categories.map((cat) => (
            <div key={cat.id} className="menu-category">
              <h3>
                <span data-guest-text>{cat.name}</span>{" "}
                <span className="muted small" data-guest-text>
                  · {cat.tax_category}
                </span>
                {food.includes(cat) && (
                  <span className="pill small"> {t("menuAdmin.category.food")}</span>
                )}
              </h3>
              {food.includes(cat) && (
                <FoodCategoryControls
                  category={cat}
                  first={food[0] === cat}
                  last={food[food.length - 1] === cat}
                  onRename={(name) =>
                    run(
                      () => call("PATCH", `/menu/categories/${cat.id}`, { name }),
                      t("menuAdmin.saved", { name }),
                    )
                  }
                  onMove={(direction) =>
                    void run(async () => {
                      for (const change of moveCategory(food, cat.id, direction))
                        await call("PATCH", `/menu/categories/${change.id}`, { sort: change.sort });
                    })
                  }
                />
              )}
              <table className="team-table menu-table">
                <thead>
                  <tr>
                    <th>{t("menuAdmin.col.item")}</th>
                    <th>{t("menuAdmin.col.button")}</th>
                    <th>{t("menuAdmin.col.price")}</th>
                    <th>{t("menuAdmin.col.alcohol")}</th>
                    {kitchenOn && <th>{t("menuAdmin.col.station")}</th>}
                    <th>{t("menuAdmin.col.shown")}</th>
                    <th>{t("menuAdmin.col.tonight")}</th>
                  </tr>
                </thead>
                <tbody>
                  {cat.items.map((item) => (
                    <ItemRows
                      key={item.id}
                      item={item}
                      categories={categories}
                      kitchenOn={kitchenOn}
                      open={editing === item.id}
                      onEdit={() => setEditing(editing === item.id ? null : item.id)}
                      onEightySix={(out) =>
                        void run(
                          () =>
                            api("POST", `/v1/venues/${venueId}/menu/items/${item.id}/out-tonight`, {
                              out,
                            }),
                          out
                            ? t("menuAdmin.86.done", { name: item.name })
                            : t("menuAdmin.86.back", { name: item.name }),
                        )
                      }
                      onSave={async (saves) => {
                        const ok = await run(
                          async () => {
                            const made: Record<string, string> = {};
                            for (const s of saves) {
                              const body = Object.fromEntries(
                                Object.entries(s.body).map(([k, v]) => [
                                  k,
                                  typeof v === "string" && v.startsWith("@") ? made[v] : v,
                                ]),
                              );
                              const answer = (await call(s.method, s.path, body)) as { id: string };
                              if (s.as) made[s.as] = answer.id;
                            }
                          },
                          t("menuAdmin.saved", { name: item.name }),
                        );
                        if (ok) setEditing(null);
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <AddCategory onAdd={(body) => run(() => call("POST", "/menu/categories", body))} />
          {categories.length > 0 && (
            <AddItem
              categories={categories}
              onAdd={(item, priceCents) =>
                run(
                  async () => {
                    const created = (await call("POST", "/menu/items", item)) as { id: string };
                    await call("POST", "/menu/variants", {
                      item_id: created.id,
                      name: t("menuAdmin.regular"),
                      price_cents: priceCents,
                    });
                  },
                  t("menuAdmin.saved", { name: item.name }),
                )
              }
            />
          )}

          {packagesOn && (
            <>
              <h3>{t("menuAdmin.packages")}</h3>
              {packages.length === 0 ? (
                <p className="muted">{t("menuAdmin.packages.none")}</p>
              ) : (
                <table className="team-table menu-table packages-table">
                  <tbody>
                    {packages.map((p) => (
                      <tr key={p.id} className={p.shown ? "" : "gone"}>
                        <td>
                          <div className="tile-name">{p.name}</div>
                          <div className="tile-role">
                            {p.contents
                              .map((c) =>
                                c.qty === null
                                  ? t("menuAdmin.package.unlimited", { name: itemName(c.item_id) })
                                  : `${c.qty} × ${itemName(c.item_id)}`,
                              )
                              .join(", ")}
                          </div>
                        </td>
                        <td>
                          {p.hourly
                            ? t("menuAdmin.perHour", { price: money(p.price_cents) })
                            : money(p.price_cents)}
                        </td>
                        <td>
                          <ShownToggle
                            name={p.name}
                            shown={p.shown}
                            onChange={(shown) =>
                              void run(() => call("PATCH", `/packages/${p.id}`, { shown }))
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <AddPackage
                items={allItems}
                onAdd={(body) =>
                  run(
                    () => call("POST", "/packages", body),
                    t("menuAdmin.saved", { name: body.name }),
                  )
                }
              />

              <h3>{t("menuAdmin.rules")}</h3>
              {rules.length === 0 ? (
                <p className="muted">{t("menuAdmin.rules.none")}</p>
              ) : (
                <table className="team-table menu-table rules-table">
                  <tbody>
                    {rules.map((r) => (
                      <tr key={r.id} className={r.shown ? "" : "gone"}>
                        <td>
                          <div className="tile-name">{r.name}</div>
                          <div className="tile-role">
                            {t(`menuAdmin.kind.${r.kind}` as MessageKey)} ·{" "}
                            {r.target.item_ids.map(itemName).join(", ")}
                          </div>
                        </td>
                        <td>
                          {r.days.map((d) => t(`day.${d}` as MessageKey)).join(" ")}
                          {r.from_min !== null && ` · ${hhmm(r.from_min)}`}
                          {r.to_min !== null && `–${hhmm(r.to_min)}`}
                        </td>
                        <td>
                          {r.price_cents !== null
                            ? (r.target.qty ?? 1) > 1
                              ? t("menuAdmin.rule.forPrice", {
                                  qty: r.target.qty ?? 1,
                                  price: money(r.price_cents),
                                })
                              : money(r.price_cents)
                            : t("menuAdmin.rule.pctOff", { pct: r.pct_off ?? 0 })}
                        </td>
                        <td>
                          <ShownToggle
                            name={r.name}
                            shown={r.shown}
                            onChange={(shown) =>
                              void run(() => call("PATCH", `/price-rules/${r.id}`, { shown }))
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <AddRule
                items={allItems}
                onAdd={(body) =>
                  run(
                    () => call("POST", "/price-rules", body),
                    t("menuAdmin.saved", { name: body.name }),
                  )
                }
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

function ShownToggle(props: { name: string; shown: boolean; onChange: (shown: boolean) => void }) {
  const { t } = useT();
  return (
    <label className="switch-line">
      <input
        type="checkbox"
        aria-label={`${props.name} · ${t("menuAdmin.col.shown")}`}
        checked={props.shown}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>{props.shown ? t("menuAdmin.shown") : t("menuAdmin.hidden")}</span>
    </label>
  );
}

interface Save {
  readonly method: "POST" | "PATCH";
  readonly path: string;
  readonly body: Record<string, unknown>;
  /** A new row's id is remembered under this name, for later saves that name it ("@group0"). */
  readonly as?: string;
}

/** One item's row, and its editor below it while open. Nothing is sent until Save. */
function ItemRows(props: {
  item: Item;
  categories: readonly Category[];
  kitchenOn: boolean;
  open: boolean;
  onEdit: () => void;
  onEightySix: (out: boolean) => void;
  onSave: (saves: Save[]) => Promise<void>;
}) {
  const { t } = useT();
  const { item } = props;
  return (
    <>
      <tr className={item.shown ? "" : "gone"}>
        <td>
          <div className="tile-name" data-guest-text>
            {item.name}
          </div>
          {item.groups.length > 0 && (
            <div className="tile-role" data-guest-text>
              {item.groups.map((g) => g.name).join(" · ")}
            </div>
          )}
        </td>
        <td data-guest-text>{item.button_name ?? <span className="muted">{item.name}</span>}</td>
        <td>{item.variants.map((v) => money(v.price_cents)).join(" / ")}</td>
        <td>{item.alcohol ? t("menuAdmin.alcohol.yes") : t("menuAdmin.alcohol.no")}</td>
        {props.kitchenOn && <td>{t(`menuAdmin.station.${item.station}` as MessageKey)}</td>}
        <td>{item.shown ? t("menuAdmin.shown") : t("menuAdmin.hidden")}</td>
        <td>
          <div className="team-actions">
            {item.out_tonight && <span className="out-tonight">{t("menuAdmin.out")}</span>}
            <button
              type="button"
              className="secondary"
              aria-label={`${item.out_tonight ? t("menuAdmin.86.undo") : t("menuAdmin.86")} · ${item.name}`}
              onClick={() => props.onEightySix(!item.out_tonight)}
            >
              {item.out_tonight ? t("menuAdmin.86.undo") : t("menuAdmin.86")}
            </button>
            <button
              type="button"
              className="secondary"
              aria-label={`${t("menuAdmin.edit")} · ${item.name}`}
              aria-expanded={props.open}
              onClick={props.onEdit}
            >
              {t("menuAdmin.edit")}
            </button>
          </div>
        </td>
      </tr>
      {props.open && (
        <tr className="menu-editor-row">
          <td colSpan={props.kitchenOn ? 7 : 6}>
            <ItemEditor
              item={item}
              categories={props.categories}
              kitchenOn={props.kitchenOn}
              onCancel={props.onEdit}
              onSave={props.onSave}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function ItemEditor(props: {
  item: Item;
  categories: readonly Category[];
  kitchenOn: boolean;
  onCancel: () => void;
  onSave: (saves: Save[]) => Promise<void>;
}) {
  const { t } = useT();
  const { item } = props;
  const [name, setName] = useState(item.name);
  const [button, setButton] = useState(item.button_name ?? "");
  const [description, setDescription] = useState(item.description ?? "");
  const [categoryId, setCategoryId] = useState(item.category_id);
  const [alcohol, setAlcohol] = useState(item.alcohol);
  const [station, setStation] = useState(item.station);
  const [shown, setShown] = useState(item.shown);
  const [variants, setVariants] = useState(
    item.variants.map((v) => ({
      id: v.id as string | null,
      name: v.name,
      price: centsText(v.price_cents),
    })),
  );
  const [groups, setGroups] = useState(
    item.groups.map((g) => ({
      id: g.id as string | null,
      name: g.name,
      required: g.required,
      options: g.options.map((o) => ({
        id: o.id as string | null,
        name: o.name,
        extra: centsText(o.price_delta_cents),
        isDefault: o.is_default,
      })),
    })),
  );
  const [invalid, setInvalid] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const priced = variants.map((v) => ({ ...v, cents: dollarsToCents(v.price) }));
    const extras = groups.map((g) => g.options.map((o) => dollarsToCents(o.extra)));
    if (priced.some((v) => v.cents === null) || extras.flat().some((c) => c === null)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const saves: Save[] = [];
    const itemBody: Record<string, unknown> = {};
    if (name.trim() !== item.name) itemBody["name"] = name.trim();
    if ((button.trim() || null) !== item.button_name)
      itemBody["button_name"] = button.trim() || null;
    if ((description.trim() || null) !== item.description)
      itemBody["description"] = description.trim() || null;
    if (categoryId !== item.category_id) itemBody["category_id"] = categoryId;
    if (alcohol !== item.alcohol) itemBody["alcohol"] = alcohol;
    if (station !== item.station) itemBody["station"] = station;
    if (shown !== item.shown) itemBody["shown"] = shown;
    if (Object.keys(itemBody).length > 0)
      saves.push({ method: "PATCH", path: `/menu/items/${item.id}`, body: itemBody });
    for (const v of priced) {
      const was = item.variants.find((x) => x.id === v.id);
      if (!was)
        saves.push({
          method: "POST",
          path: "/menu/variants",
          body: { item_id: item.id, name: v.name.trim(), price_cents: v.cents },
        });
      else if (was.name !== v.name.trim() || was.price_cents !== v.cents)
        saves.push({
          method: "PATCH",
          path: `/menu/variants/${was.id}`,
          body: { name: v.name.trim(), price_cents: v.cents },
        });
    }
    // Groups and their choices: new groups are created first, so their choices can name them.
    for (const [gi, g] of groups.entries()) {
      const was = item.groups.find((x) => x.id === g.id);
      const options = g.options.map((o, oi) => ({
        ...o,
        cents: extras[gi]![oi]!,
      }));
      const ref = `@group${gi}`;
      saves.push({
        ...(was ? {} : { as: ref }),
        method: was ? "PATCH" : "POST",
        path: was ? `/menu/modifier-groups/${was.id}` : "/menu/modifier-groups",
        body: was
          ? { name: g.name.trim(), required: g.required, min_choices: g.required ? 1 : 0 }
          : {
              item_id: item.id,
              name: g.name.trim(),
              required: g.required,
              min_choices: g.required ? 1 : 0,
              max_choices: 1,
            },
      });
      for (const o of options) {
        const old = was?.options.find((x) => x.id === o.id);
        const body = {
          name: o.name.trim(),
          price_delta_cents: o.cents,
          is_default: o.isDefault,
        };
        if (!old)
          saves.push({
            method: "POST",
            path: "/menu/options",
            body: { ...body, group_id: was ? was.id : ref },
          });
        else if (
          old.name !== body.name ||
          old.price_delta_cents !== body.price_delta_cents ||
          old.is_default !== body.is_default
        )
          saves.push({ method: "PATCH", path: `/menu/options/${old.id}`, body });
      }
    }
    await props.onSave(saves);
  };

  return (
    <form className="invite-form menu-editor" onSubmit={(e) => void submit(e)}>
      <div className="invite-fields">
        <label>
          <span>{t("menuAdmin.name")}</span>
          <input value={name} required maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t("menuAdmin.buttonName")}</span>
          <input
            value={button}
            maxLength={24}
            placeholder={name}
            onChange={(e) => setButton(e.target.value)}
          />
        </label>
        <label>
          <span>{t("menuAdmin.category")}</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {props.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {props.kitchenOn && (
          <label>
            <span>{t("menuAdmin.col.station")}</span>
            <select value={station} onChange={(e) => setStation(e.target.value)}>
              <option value="bar">{t("menuAdmin.station.bar")}</option>
              <option value="kitchen">{t("menuAdmin.station.kitchen")}</option>
            </select>
          </label>
        )}
        <label>
          <span>{t("menuAdmin.description")}</span>
          <input
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>
      <p className="small muted">{t("menuAdmin.buttonName.hint")}</p>
      <label className="switch-line">
        <input type="checkbox" checked={alcohol} onChange={(e) => setAlcohol(e.target.checked)} />
        <span>{t("menuAdmin.alcohol")}</span>
      </label>
      <label className="switch-line">
        <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} />
        <span>{t("menuAdmin.shownOnMenus")}</span>
      </label>

      <h4>{t("menuAdmin.variants")}</h4>
      {variants.map((v, i) => (
        <div key={v.id ?? `new${i}`} className="invite-fields">
          <label>
            <span>{t("menuAdmin.variant.name")}</span>
            <input
              value={v.name}
              required
              maxLength={80}
              onChange={(e) =>
                setVariants(variants.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
            />
          </label>
          <label>
            <span>{t("menuAdmin.variant.price")}</span>
            <input
              inputMode="decimal"
              value={v.price}
              aria-invalid={dollarsToCents(v.price) === null}
              onChange={(e) =>
                setVariants(variants.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))
              }
            />
          </label>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        onClick={() => setVariants([...variants, { id: null, name: "", price: "0.00" }])}
      >
        {t("menuAdmin.variant.add")}
      </button>

      <h4>{t("menuAdmin.groups")}</h4>
      {groups.length === 0 && <p className="muted small">{t("menuAdmin.groups.none")}</p>}
      {groups.map((g, gi) => {
        const setGroup = (next: Partial<(typeof groups)[number]>) =>
          setGroups(groups.map((x, j) => (j === gi ? { ...x, ...next } : x)));
        return (
          <fieldset key={g.id ?? `new${gi}`} className="menu-group">
            <div className="invite-fields">
              <label>
                <span>{t("menuAdmin.group.name")}</span>
                <input
                  value={g.name}
                  required
                  maxLength={80}
                  onChange={(e) => setGroup({ name: e.target.value })}
                />
              </label>
            </div>
            <label className="switch-line">
              <input
                type="checkbox"
                checked={g.required}
                onChange={(e) => setGroup({ required: e.target.checked })}
              />
              <span>{t("menuAdmin.group.required")}</span>
            </label>
            {g.options.map((o, oi) => {
              const setOption = (next: Partial<(typeof g.options)[number]>) =>
                setGroup({
                  options: g.options.map((x, k) =>
                    k === oi ? { ...x, ...next } : next.isDefault ? { ...x, isDefault: false } : x,
                  ),
                });
              return (
                <div key={o.id ?? `new${oi}`} className="invite-fields">
                  <label>
                    <span>{t("menuAdmin.option.name")}</span>
                    <input
                      value={o.name}
                      required
                      maxLength={80}
                      onChange={(e) => setOption({ name: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>{t("menuAdmin.option.extra")}</span>
                    <input
                      inputMode="decimal"
                      value={o.extra}
                      aria-invalid={dollarsToCents(o.extra) === null}
                      onChange={(e) => setOption({ extra: e.target.value })}
                    />
                  </label>
                  <label className="switch-line">
                    <input
                      type="checkbox"
                      checked={o.isDefault}
                      onChange={(e) => setOption({ isDefault: e.target.checked })}
                    />
                    <span>{t("menuAdmin.option.default")}</span>
                  </label>
                </div>
              );
            })}
            <button
              type="button"
              className="secondary"
              onClick={() =>
                setGroup({
                  options: [...g.options, { id: null, name: "", extra: "0.00", isDefault: false }],
                })
              }
            >
              {t("menuAdmin.option.add")}
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="secondary"
        onClick={() => setGroups([...groups, { id: null, name: "", required: false, options: [] }])}
      >
        {t("menuAdmin.group.add")}
      </button>

      {invalid && (
        <p className="error" role="alert">
          {t("menuAdmin.invalidPrice")}
        </p>
      )}
      <div className="team-actions">
        <button type="submit" className="primary">
          {t("menuAdmin.save")}
        </button>
        <button type="button" className="secondary" onClick={props.onCancel}>
          {t("team.badge.cancel")}
        </button>
      </div>
    </form>
  );
}

/** A food category's name and place among the food categories (D100; K-02). */
function FoodCategoryControls(props: {
  category: Category;
  first: boolean;
  last: boolean;
  onRename: (name: string) => Promise<boolean>;
  onMove: (direction: "up" | "down") => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(props.category.name);
  useEffect(() => setName(props.category.name), [props.category.name]);
  const label = `${t("menuAdmin.category.rename")} · ${props.category.name}`;
  return (
    <form
      className="team-actions"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && name.trim() !== props.category.name) void props.onRename(name.trim());
      }}
    >
      <input
        aria-label={label}
        value={name}
        required
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="secondary" aria-label={label}>
        {t("menuAdmin.category.rename")}
      </button>
      <button
        type="button"
        className="secondary"
        disabled={props.first}
        aria-label={`${t("menuAdmin.category.moveUp")} · ${props.category.name}`}
        onClick={() => props.onMove("up")}
      >
        {t("menuAdmin.category.moveUp")}
      </button>
      <button
        type="button"
        className="secondary"
        disabled={props.last}
        aria-label={`${t("menuAdmin.category.moveDown")} · ${props.category.name}`}
        onClick={() => props.onMove("down")}
      >
        {t("menuAdmin.category.moveDown")}
      </button>
    </form>
  );
}

function AddCategory(props: { onAdd: (body: Record<string, unknown>) => Promise<boolean> }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [tax, setTax] = useState("drink");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await props.onAdd({ name: name.trim(), tax_category: tax.trim() })) setName("");
  };
  return (
    <form className="invite-form" onSubmit={(e) => void submit(e)}>
      <h3>{t("menuAdmin.category.add")}</h3>
      <div className="invite-fields">
        <label>
          <span>{t("menuAdmin.category.name")}</span>
          <input value={name} required maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t("menuAdmin.category.tax")}</span>
          <input value={tax} required maxLength={40} onChange={(e) => setTax(e.target.value)} />
        </label>
      </div>
      <button type="submit" className="primary">
        {t("menuAdmin.category.add")}
      </button>
    </form>
  );
}

function AddItem(props: {
  categories: readonly Category[];
  onAdd: (item: { name: string } & Record<string, unknown>, priceCents: number) => Promise<boolean>;
}) {
  const { t } = useT();
  const [categoryId, setCategoryId] = useState(props.categories[0]?.id ?? "");
  const [name, setName] = useState("");
  const [button, setButton] = useState("");
  const [price, setPrice] = useState("");
  const [alcohol, setAlcohol] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = dollarsToCents(price);
    setInvalid(cents === null);
    if (cents === null) return;
    const ok = await props.onAdd(
      {
        category_id: categoryId,
        name: name.trim(),
        button_name: button.trim() || null,
        alcohol,
      },
      cents,
    );
    if (ok) {
      setName("");
      setButton("");
      setPrice("");
      setAlcohol(false);
    }
  };
  return (
    <form className="invite-form" onSubmit={(e) => void submit(e)}>
      <h3>{t("menuAdmin.item.add")}</h3>
      <div className="invite-fields">
        <label>
          <span>{t("menuAdmin.category")}</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {props.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("menuAdmin.item.name")}</span>
          <input value={name} required maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t("menuAdmin.buttonName")}</span>
          <input value={button} maxLength={24} onChange={(e) => setButton(e.target.value)} />
        </label>
        <label>
          <span>{t("menuAdmin.item.price")}</span>
          <input
            inputMode="decimal"
            value={price}
            required
            aria-invalid={invalid}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
      </div>
      <label className="switch-line">
        <input type="checkbox" checked={alcohol} onChange={(e) => setAlcohol(e.target.checked)} />
        <span>{t("menuAdmin.alcohol")}</span>
      </label>
      {invalid && (
        <p className="error" role="alert">
          {t("menuAdmin.invalidPrice")}
        </p>
      )}
      <button type="submit" className="primary">
        {t("menuAdmin.item.add")}
      </button>
    </form>
  );
}

function ItemPicker(props: {
  label: string;
  items: readonly Item[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <label>
      <span>{props.label}</span>
      <select
        aria-label={props.label}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function AddPackage(props: {
  items: readonly Item[];
  onAdd: (body: { name: string } & Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useT();
  const first = props.items[0]?.id ?? "";
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [hourly, setHourly] = useState(false);
  const [privateOnly, setPrivateOnly] = useState(false);
  const [contents, setContents] = useState([{ itemId: first, qty: "" }]);
  const [invalid, setInvalid] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = dollarsToCents(price);
    const bad = cents === null || contents.some((c) => c.qty !== "" && !/^\d{1,4}$/.test(c.qty));
    setInvalid(bad);
    if (bad) return;
    const ok = await props.onAdd({
      name: name.trim(),
      price_cents: cents,
      hourly,
      private_function_only: privateOnly,
      contents: contents.map((c) => ({
        item_id: c.itemId,
        qty: c.qty === "" ? null : Number(c.qty),
      })),
    });
    if (ok) {
      setName("");
      setPrice("");
      setContents([{ itemId: first, qty: "" }]);
    }
  };
  return (
    <form className="invite-form" onSubmit={(e) => void submit(e)}>
      <h4>{t("menuAdmin.package.add")}</h4>
      <div className="invite-fields">
        <label>
          <span>{t("menuAdmin.package.name")}</span>
          <input value={name} required maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t("menuAdmin.package.price")}</span>
          <input
            inputMode="decimal"
            value={price}
            required
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
      </div>
      {contents.map((c, i) => (
        <div key={i} className="invite-fields">
          <ItemPicker
            label={t("menuAdmin.package.item")}
            items={props.items}
            value={c.itemId}
            onChange={(itemId) =>
              setContents(contents.map((x, j) => (j === i ? { ...x, itemId } : x)))
            }
          />
          <label>
            <span>{t("menuAdmin.package.qty")}</span>
            <input
              inputMode="numeric"
              value={c.qty}
              placeholder={t("menuAdmin.package.qty.any")}
              onChange={(e) =>
                setContents(contents.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))
              }
            />
          </label>
        </div>
      ))}
      <button
        type="button"
        className="secondary"
        onClick={() => setContents([...contents, { itemId: first, qty: "" }])}
      >
        {t("menuAdmin.package.addItem")}
      </button>
      <label className="switch-line">
        <input type="checkbox" checked={hourly} onChange={(e) => setHourly(e.target.checked)} />
        <span>{t("menuAdmin.package.hourly")}</span>
      </label>
      <label className="switch-line">
        <input
          type="checkbox"
          checked={privateOnly}
          onChange={(e) => setPrivateOnly(e.target.checked)}
        />
        <span>{t("menuAdmin.package.private")}</span>
      </label>
      {invalid && (
        <p className="error" role="alert">
          {t("menuAdmin.invalidPrice")}
        </p>
      )}
      <button type="submit" className="primary">
        {t("menuAdmin.package.save")}
      </button>
    </form>
  );
}

function AddRule(props: {
  items: readonly Item[];
  onAdd: (body: { name: string } & Record<string, unknown>) => Promise<boolean>;
}) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("happy_hour");
  const [days, setDays] = useState<number[]>([...DAYS]);
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [itemId, setItemId] = useState(props.items[0]?.id ?? "");
  const [qty, setQty] = useState("1");
  const [by, setBy] = useState<"price" | "pct">("price");
  const [amount, setAmount] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const cents = by === "price" ? dollarsToCents(amount) : null;
    const pct = by === "pct" && /^\d{1,3}$/.test(amount) ? Number(amount) : null;
    const bad =
      (by === "price" ? cents === null : pct === null || pct < 1 || pct > 100) ||
      !/^\d{1,2}$/.test(qty) ||
      days.length === 0;
    setInvalid(bad);
    if (bad) return;
    await props.onAdd({
      name: name.trim(),
      kind,
      days: DAYS.filter((d) => days.includes(d)),
      from_min: from === "" ? null : minutesOf(from),
      to_min: until === "" ? null : minutesOf(until),
      target: { item_ids: [itemId], qty: Number(qty) },
      price_cents: cents,
      pct_off: pct,
      starts_on: startsOn || null,
      ends_on: endsOn || null,
    });
  };
  return (
    <form className="invite-form" onSubmit={(e) => void submit(e)}>
      <h4>{t("menuAdmin.rule.add")}</h4>
      <div className="invite-fields">
        <label>
          <span>{t("menuAdmin.rule.name")}</span>
          <input value={name} required maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t("menuAdmin.rule.kind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`menuAdmin.kind.${k}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <ItemPicker
          label={t("menuAdmin.rule.item")}
          items={props.items}
          value={itemId}
          onChange={setItemId}
        />
        <label>
          <span>{t("menuAdmin.rule.qty")}</span>
          <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
      </div>
      <fieldset className="day-picks">
        <legend>{t("menuAdmin.rule.days")}</legend>
        {DAYS.map((d) => (
          <label key={d} className="switch-line">
            <input
              type="checkbox"
              checked={days.includes(d)}
              onChange={(e) =>
                setDays(e.target.checked ? [...days, d] : days.filter((x) => x !== d))
              }
            />
            <span>{t(`day.${d}` as MessageKey)}</span>
          </label>
        ))}
      </fieldset>
      <div className="invite-fields">
        <label>
          <span>{t("menuAdmin.rule.from")}</span>
          <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <span>{t("menuAdmin.rule.until")}</span>
          <input type="time" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <label>
          <span>{t("menuAdmin.rule.by")}</span>
          <select value={by} onChange={(e) => setBy(e.target.value as "price" | "pct")}>
            <option value="price">{t("menuAdmin.rule.by.price")}</option>
            <option value="pct">{t("menuAdmin.rule.by.pct")}</option>
          </select>
        </label>
        <label>
          <span>{by === "price" ? t("menuAdmin.rule.price") : t("menuAdmin.rule.pct")}</span>
          <input
            inputMode="decimal"
            value={amount}
            required
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          <span>{t("menuAdmin.rule.startsOn")}</span>
          <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <label>
          <span>{t("menuAdmin.rule.endsOn")}</span>
          <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </label>
      </div>
      {invalid && (
        <p className="error" role="alert">
          {t("menuAdmin.rule.invalid")}
        </p>
      )}
      <button type="submit" className="primary">
        {t("menuAdmin.rule.save")}
      </button>
    </form>
  );
}
