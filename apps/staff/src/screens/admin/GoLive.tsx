import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";

/**
 * The go-live checklist in Admin → Payments (M4-29; milestones · M4; screens
 * Setup notes 8 and 10), the owner's: the merchant category on the Stripe
 * account matches the one we expect; each owner and manager has a Stripe
 * Dashboard login that can take payments and a phone that runs Tap to Pay,
 * confirmed by the owner, with who and when. Bar tabs & quick sale stay off
 * until the merchant category passes.
 */
interface Confirmation {
  readonly confirmed: boolean;
  readonly by: string | null;
  readonly at: string | null;
}
interface Checklist {
  readonly merchant_category: {
    readonly expected: string | null;
    readonly found: string | null;
    readonly status: "pending" | "passed" | "failed";
  };
  readonly people: readonly {
    readonly user_id: string;
    readonly name: string;
    readonly role: string;
    readonly dashboard_login: Confirmation;
    readonly tap_to_pay: Confirmation;
  }[];
  readonly passes: boolean;
}

export function GoLive({ venueId }: { venueId: string }) {
  const { t, date } = useT();
  const [list, setList] = useState<Checklist | null>(null);
  const [expected, setExpected] = useState("");
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await api<Checklist>("GET", `/v1/venues/${venueId}/go-live`);
      setList(c);
      setExpected(c.merchant_category.expected ?? "");
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  const saveExpected = async () => {
    try {
      setList(
        await api<Checklist>("PUT", `/v1/venues/${venueId}/go-live/merchant-category`, {
          expected: expected.trim() || null,
        }),
      );
    } catch {
      setFailed(true);
    }
  };
  const confirm = async (userId: string, check: "dashboard_login" | "tap_to_pay", on: boolean) => {
    try {
      setList(
        await api<Checklist>("POST", `/v1/venues/${venueId}/go-live/people/${userId}`, {
          check,
          confirmed: on,
        }),
      );
    } catch {
      setFailed(true);
    }
  };
  const who = (c: Confirmation) =>
    c.confirmed && c.by && c.at ? t("goLive.confirmedBy", { name: c.by, date: date(c.at) }) : "";

  return (
    <section className="go-live" aria-labelledby="go-live-h">
      <h3 id="go-live-h">{t("goLive.title")}</h3>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {list && (
        <>
          <p role="status">{list.passes ? t("goLive.passes") : t("goLive.notYet")}</p>
          <fieldset>
            <legend>{t("goLive.merchant")}</legend>
            <label>
              <span>{t("goLive.expected")}</span>
              <input
                inputMode="numeric"
                maxLength={4}
                aria-label={t("goLive.expected")}
                value={expected}
                placeholder={t("goLive.expected.empty")}
                onChange={(e) => setExpected(e.target.value)}
              />
            </label>
            <button type="button" className="secondary" onClick={() => void saveExpected()}>
              {t("goLive.saveExpected")}
            </button>
            <p className="small">
              {t(`goLive.merchant.${list.merchant_category.status}`, {
                found: list.merchant_category.found ?? "",
              })}
            </p>
          </fieldset>
          <table>
            <thead>
              <tr>
                <th>{t("goLive.person")}</th>
                <th>{t("goLive.dashboard")}</th>
                <th>{t("goLive.tapToPay")}</th>
              </tr>
            </thead>
            <tbody>
              {list.people.map((p) => (
                <tr key={p.user_id}>
                  <td>{p.name}</td>
                  {(["dashboard_login", "tap_to_pay"] as const).map((check) => (
                    <td key={check}>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={t(
                            `goLive.${check === "dashboard_login" ? "dashboard" : "tapToPay"}.for`,
                            {
                              name: p.name,
                            },
                          )}
                          checked={p[check].confirmed}
                          onChange={(e) => void confirm(p.user_id, check, e.target.checked)}
                        />
                        <span className="small muted">{who(p[check])}</span>
                      </label>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">{t("goLive.hint")}</p>
        </>
      )}
    </section>
  );
}
