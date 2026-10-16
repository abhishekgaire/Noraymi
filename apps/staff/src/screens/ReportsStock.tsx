import { useCallback, useEffect, useState } from "react";
import { ApiCallError, api } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { useModuleOn } from "../useModule.js";

/**
 * Reports → Stock (P-16; spec 04 · Inventory; module Inventory, off by default): what's counted,
 * each with its count on hand, its low level and whether it's 86'd tonight; Receive, Count and
 * Adjust (with a reason); Count an item to start one; and the counts by date: on hand, used,
 * received and adjusted. Sales and voids move the counts on the server. Owners and managers (the
 * API refuses everyone else). English and Spanish.
 */
interface Level {
  readonly id: string;
  readonly item_id: string;
  readonly variant_id: string | null;
  readonly item: string;
  readonly variant: string | null;
  readonly on_hand: number;
  readonly low_at: number | null;
  readonly low: boolean;
  readonly counting: boolean;
  readonly out_tonight: boolean;
}
interface ReportLevel extends Level {
  readonly used: number;
  readonly received: number;
  readonly adjusted: number;
}
interface MenuItem {
  readonly id: string;
  readonly name: string;
}
interface MenuVariant {
  readonly id: string;
  readonly item_id: string;
  readonly name: string;
}
type Action = "receive" | "count" | "adjust" | "low";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE = /^-?\d+$/;
const nameOf = (l: Level) => (l.variant ? `${l.item} · ${l.variant}` : l.item);

export function ReportsStock(props: { readonly venueId: string; readonly tonight: string }) {
  const on = useModuleOn("inventory");
  if (!on) return null;
  return <StockPanel {...props} />;
}

function StockPanel({ venueId, tonight }: { readonly venueId: string; readonly tonight: string }) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const [levels, setLevels] = useState<readonly Level[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; action: Action } | null>(null);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [items, setItems] = useState<readonly MenuItem[]>([]);
  const [variants, setVariants] = useState<readonly MenuVariant[]>([]);
  const [pick, setPick] = useState({ item: "", variant: "", low: "" });
  const [from, setFrom] = useState(tonight);
  const [to, setTo] = useState(tonight);
  const [report, setReport] = useState<{
    from: string;
    to: string;
    levels: readonly ReportLevel[];
  } | null>(null);
  const [reportFailed, setReportFailed] = useState<"load" | "range" | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ levels: Level[] }>("GET", `/v1/venues/${venueId}/stock`);
      setLevels(r.levels.filter((l) => l.counting));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  const loadReport = useCallback(async () => {
    if (!DATE.test(from) || !DATE.test(to)) return;
    setReportFailed(null);
    if (from > to) {
      setReport(null);
      setReportFailed("range");
      return;
    }
    try {
      setReport(await api("GET", `/v1/venues/${venueId}/stock/report?from=${from}&to=${to}`));
    } catch (e) {
      setReport(null);
      setReportFailed(e instanceof ApiCallError && e.status === 400 ? "range" : "load");
    }
  }, [venueId, from, to]);
  useEffect(() => void load(), [load]);
  useEffect(() => void loadReport(), [loadReport]);
  useEffect(() => {
    void (async () => {
      try {
        const [i, v] = await Promise.all([
          api<{ items: MenuItem[] }>("GET", `/v1/venues/${venueId}/menu/items`),
          api<{ items: MenuVariant[] }>("GET", `/v1/venues/${venueId}/menu/variants`),
        ]);
        setItems([...i.items].sort((a, b) => a.name.localeCompare(b.name)));
        setVariants(v.items);
      } catch {
        // The picker stays empty; the list and its error still show.
      }
    })();
  }, [venueId]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.some((e) => e.type === "stock.changed" || e.type === "menu.changed")) {
          void load();
          void loadReport();
        }
      }),
    [subscribe, load, loadReport],
  );

  const done = (l: Level) => {
    setOpen(null);
    setValue("");
    setReason("");
    setNotice(t("stock.saved", { item: nameOf(l), count: l.on_hand }));
    void load();
    void loadReport();
  };
  const save = async (l: Level, action: Action) => {
    setError(null);
    setNotice(null);
    const blankLow = action === "low" && value.trim() === "";
    if (!blankLow && !WHOLE.test(value.trim())) return setError(t("stock.badNumber"));
    const n = blankLow ? null : Number(value.trim());
    if (action === "adjust" && !reason.trim()) return setError(t("stock.reasonMissing"));
    const base = `/v1/venues/${venueId}/stock/${l.item_id}`;
    const variant = { variant_id: l.variant_id };
    try {
      const next =
        action === "low"
          ? await api<Level>("PUT", base, { ...variant, counting: true, low_at: n })
          : await api<Level>(
              "POST",
              `${base}/${action}`,
              action === "receive"
                ? { ...variant, qty: n }
                : action === "count"
                  ? { ...variant, on_hand: n }
                  : { ...variant, delta: n, reason: reason.trim() },
            );
      done(next);
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : t("stock.saveFailed"));
    }
  };
  const stop = async (l: Level) => {
    setError(null);
    try {
      await api("PUT", `/v1/venues/${venueId}/stock/${l.item_id}`, {
        variant_id: l.variant_id,
        counting: false,
      });
      setOpen(null);
      void load();
    } catch {
      setError(t("stock.saveFailed"));
    }
  };
  const start = async () => {
    setError(null);
    if (!pick.item) return;
    if (pick.low.trim() && !WHOLE.test(pick.low.trim())) return setError(t("stock.badNumber"));
    try {
      await api("PUT", `/v1/venues/${venueId}/stock/${pick.item}`, {
        variant_id: pick.variant || null,
        counting: true,
        low_at: pick.low.trim() ? Number(pick.low.trim()) : null,
      });
      setPick({ item: "", variant: "", low: "" });
      void load();
    } catch (e) {
      setError(e instanceof ApiCallError ? e.message : t("stock.saveFailed"));
    }
  };

  const label: Record<Action, string> = {
    receive: t("stock.qty"),
    count: t("stock.onHandNow"),
    adjust: t("stock.delta"),
    low: t("stock.lowAtLabel"),
  };
  const sizes = variants.filter((v) => v.item_id === pick.item);
  const current = report?.from === from && report.to === to ? report : null;

  return (
    <section className="card desk-card" aria-labelledby="stock-title" data-testid="report-stock">
      <h2 id="stock-title">{t("stock.title")}</h2>
      <p className="small muted">{t("stock.hint")}</p>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {failed && (
        <p role="alert" className="error">
          {t("stock.loadFailed")}
        </p>
      )}
      {!failed && levels === null && <p role="status">{t("shell.loading")}</p>}
      {levels && levels.length === 0 && <p className="muted">{t("stock.empty")}</p>}
      {levels && levels.length > 0 && (
        <ul className="staff-actions stock-levels">
          {levels.map((l) => (
            <li key={l.id}>
              <div className="row">
                <span>
                  <strong>{nameOf(l)}</strong>
                  {` · ${t("stock.onHand")} ${l.on_hand}`}
                  {l.low_at !== null ? ` · ${t("stock.lowAt")} ${l.low_at}` : ""}
                  {l.low && <span className="badge"> {t("stock.lowBadge")}</span>}
                  {l.out_tonight && <span className="badge"> {t("stock.outBadge")}</span>}
                </span>
              </div>
              <div className="actions">
                {(["receive", "count", "adjust", "low"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    className="secondary"
                    aria-expanded={open?.id === l.id && open.action === a}
                    aria-label={`${a === "low" ? t("stock.lowAt") : t(`stock.${a}`)} · ${nameOf(l)}`}
                    onClick={() => {
                      setError(null);
                      setValue(a === "low" && l.low_at !== null ? String(l.low_at) : "");
                      setReason("");
                      setOpen(
                        open?.id === l.id && open.action === a ? null : { id: l.id, action: a },
                      );
                    }}
                  >
                    {a === "low" ? t("stock.lowAt") : t(`stock.${a}`)}
                  </button>
                ))}
              </div>
              {open?.id === l.id && (
                <form
                  className="actions"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save(l, open.action);
                  }}
                >
                  <label>
                    {label[open.action]}{" "}
                    <input
                      inputMode="numeric"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      autoFocus
                    />
                  </label>
                  {open.action === "adjust" && (
                    <label>
                      {t("stock.reason")}{" "}
                      <input
                        value={reason}
                        maxLength={200}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </label>
                  )}
                  <button type="submit">{t("stock.save")}</button>
                  <button type="button" className="secondary" onClick={() => setOpen(null)}>
                    {t("stock.cancel")}
                  </button>
                  {open.action === "low" && (
                    <button type="button" className="secondary" onClick={() => void stop(l)}>
                      {t("stock.stop")}
                    </button>
                  )}
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3>{t("stock.add")}</h3>
      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <label>
          {t("stock.addItem")}{" "}
          <select
            value={pick.item}
            onChange={(e) => setPick({ item: e.target.value, variant: "", low: pick.low })}
          >
            <option value="">{t("stock.choose")}</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        {sizes.length > 1 && (
          <label>
            {t("stock.addVariant")}{" "}
            <select
              value={pick.variant}
              onChange={(e) => setPick({ ...pick, variant: e.target.value })}
            >
              <option value="">{t("stock.wholeItem")}</option>
              {sizes.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {t("stock.lowAtLabel")}{" "}
          <input
            inputMode="numeric"
            value={pick.low}
            onChange={(e) => setPick({ ...pick, low: e.target.value })}
          />
        </label>
        <button type="submit" disabled={!pick.item}>
          {t("stock.start")}
        </button>
      </form>

      <h3>{t("stock.report")}</h3>
      <div className="actions">
        <label>
          {t("stock.from")}{" "}
          <input type="date" value={from} max={tonight} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t("stock.to")}{" "}
          <input type="date" value={to} max={tonight} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {reportFailed && (
        <p role="alert" className="error">
          {t(reportFailed === "range" ? "stock.range" : "stock.loadFailed")}
        </p>
      )}
      {!reportFailed && !current && <p role="status">{t("shell.loading")}</p>}
      {current && current.levels.length === 0 && <p className="muted">{t("stock.noMoves")}</p>}
      {current && current.levels.length > 0 && (
        <table className="stock-report" aria-label={t("stock.report")}>
          <thead>
            <tr>
              <th scope="col">{t("stock.item")}</th>
              <th scope="col">{t("stock.onHand")}</th>
              <th scope="col">{t("stock.used")}</th>
              <th scope="col">{t("stock.received")}</th>
              <th scope="col">{t("stock.adjusted")}</th>
            </tr>
          </thead>
          <tbody>
            {current.levels.map((l) => (
              <tr key={l.id}>
                <th scope="row">{nameOf(l)}</th>
                <td>{l.on_hand}</td>
                <td>{l.used}</td>
                <td>{l.received}</td>
                <td>{l.adjusted > 0 ? `+${l.adjusted}` : l.adjusted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
