import { useCallback, useEffect, useState } from "react";
import { Temporal, type CashSettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Cash drawers (M7-05; spec 03 · CashSettings, When a change starts;
 * screens AdminDesk note 9): the drawer model, the starting bank, the note
 * limit, the second counter, the paid-out amount that needs approval and the
 * per-person options. The `drawer` key starts with the next business date, so
 * a change saved on Fri Sep 25 shows "Starts Sat Sep 26" and tonight's drawers
 * stay as they are. Saved through Save and publish, checked against the rule
 * pack, whose cash.mustAccept means cash can't be turned off.
 */
interface Version {
  readonly version: number;
  readonly startsOn: string;
  readonly value: CashSettings;
}
interface Pack {
  readonly current: { readonly cash?: { readonly mustAccept: boolean } } | null;
}

const dollars = (cents: number) =>
  `${Math.floor(cents / 100)}${cents % 100 ? `.${String(cents % 100).padStart(2, "0")}` : ""}`;
/** "300" or "20.50" to cents, without a float. */
function toCents(text: string): number | null {
  const m = /^\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(text);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")) : null;
}

export function CashDrawers() {
  const { t, date } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [inForce, setInForce] = useState<{ value: CashSettings; business_date: string } | null>(
    null,
  );
  const [latest, setLatest] = useState<Version | null>(null);
  const [mustAccept, setMustAccept] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [now, history, pack] = await Promise.all([
      api<{ value: CashSettings; business_date: string }>(
        "GET",
        `/v1/venues/${venueId}/settings/drawer`,
      ),
      api<{ versions: Version[] }>("GET", `/v1/venues/${venueId}/settings/drawer?history=1`),
      api<Pack>("GET", `/v1/venues/${venueId}/rule-pack`).catch(() => null),
    ]);
    setInForce(now);
    setLatest(history.versions[0] ?? null);
    setMustAccept(pack?.current?.cash?.mustAccept ?? true);
  }, [venueId]);
  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);

  const saved = latest?.value ?? inForce?.value ?? null;
  const current = (draft.values["drawer"] as CashSettings | undefined) ?? saved;
  const set = (next: Partial<CashSettings>) => {
    if (current) draft.set("drawer", { ...current, ...next });
  };
  // The date a change starts: a version already waiting, or the next business date for an unsaved change.
  const today = inForce ? Temporal.PlainDate.from(inForce.business_date) : null;
  const waiting = latest && today && Temporal.PlainDate.compare(latest.startsOn, today) > 0;
  const changed = current && inForce && JSON.stringify(current) !== JSON.stringify(inForce.value);
  const startsOn = waiting
    ? latest.startsOn
    : changed && today
      ? today.add({ days: 1 }).toString()
      : null;

  const money = (label: string, field: keyof CashSettings) =>
    current && (
      <label>
        <span>{label}</span>
        <input
          inputMode="decimal"
          aria-label={label}
          defaultValue={dollars(current[field] as number)}
          onChange={(e) => {
            const c = toCents(e.target.value);
            if (c !== null) set({ [field]: c } as Partial<CashSettings>);
          }}
        />
      </label>
    );

  return (
    <section className="cash-drawers">
      <h2>{t("admin.section.cashDrawers")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {current === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <div className="invite-fields">
          <fieldset>
            <legend>{t("cashAdmin.model")}</legend>
            {(["house", "perPerson"] as const).map((m) => (
              <label key={m} className="row">
                <input
                  type="radio"
                  name="drawer-model"
                  checked={current.drawer === m}
                  onChange={() => set({ drawer: m })}
                />
                <span>{t(m === "house" ? "cashAdmin.house" : "cashAdmin.perPerson")}</span>
              </label>
            ))}
            {startsOn && (
              <p role="status" className="notice">
                {t("cashAdmin.startsOn", { date: date(startsOn) })}
              </p>
            )}
          </fieldset>
          {money(t("cashAdmin.startingBank"), "startingBankCents")}
          {money(t("cashAdmin.noteOver"), "noteOverCents")}
          <label>
            <span>{t("cashAdmin.secondCounter")}</span>
            <select
              aria-label={t("cashAdmin.secondCounter")}
              value={current.secondCounter}
              onChange={(e) =>
                set({ secondCounter: e.target.value as CashSettings["secondCounter"] })
              }
            >
              <option value="never">{t("cashAdmin.second.never")}</option>
              <option value="whenOff">{t("cashAdmin.second.whenOff")}</option>
              <option value="always">{t("cashAdmin.second.always")}</option>
            </select>
          </label>
          {money(t("cashAdmin.paidOut"), "paidOutApprovalCents")}
          {current.drawer === "perPerson" && (
            <>
              <label>
                <span>{t("cashAdmin.perPersonWho")}</span>
                <select
                  aria-label={t("cashAdmin.perPersonWho")}
                  value={current.perPerson.who}
                  onChange={(e) =>
                    set({
                      perPerson: {
                        ...current.perPerson,
                        who: e.target.value as CashSettings["perPerson"]["who"],
                      },
                    })
                  }
                >
                  <option value="bartenders">{t("cashAdmin.who.bartenders")}</option>
                  <option value="bartendersAndServers">
                    {t("cashAdmin.who.bartendersAndServers")}
                  </option>
                </select>
              </label>
              <label className="row">
                <input
                  type="checkbox"
                  checked={current.perPerson.countLater}
                  onChange={(e) =>
                    set({ perPerson: { ...current.perPerson, countLater: e.target.checked } })
                  }
                />
                <span>{t("cashAdmin.countLater")}</span>
              </label>
            </>
          )}
          <p className="small muted">{t("cashAdmin.blindHint")}</p>
          {mustAccept && <p className="small muted">{t("cashAdmin.mustAccept")}</p>}
        </div>
      )}
    </section>
  );
}
