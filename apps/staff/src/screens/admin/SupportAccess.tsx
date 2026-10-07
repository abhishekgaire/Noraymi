import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { MessageKey } from "@west4/shared";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Console (M8-10; screens N39): where the owner approves support
 * access from our staff. Owner only: managers never see the section, and the
 * API refuses them too. Each request shows who asked, the reason, the scope
 * (read, or read plus one named action once) and the length up to 60 minutes,
 * with [Approve] and [Decline]; an open grant shows its time left and [End now].
 * The emergency actions come with M8-11.
 */
export interface SupportGrant {
  readonly id: string;
  readonly staff_name: string | null;
  readonly reason: string;
  readonly scope: "read" | "write";
  readonly action: string | null;
  readonly minutes: number;
  readonly state: "waiting" | "open" | "ended" | "declined" | "revoked";
  readonly seconds_left: number | null;
  readonly action_used_at: string | null;
}

const POLL_MS = 15_000;

function useSupportGrants(venueId: string) {
  const [grants, setGrants] = useState<readonly SupportGrant[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      const r = await api<{ support_grants: SupportGrant[] }>(
        "GET",
        `/v1/venues/${venueId}/support-grants`,
      );
      setGrants(r.support_grants);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { grants, failed, load };
}

const minutesLeft = (g: SupportGrant) => Math.max(1, Math.ceil((g.seconds_left ?? 0) / 60));

export function SupportAccess() {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const { grants, failed, load } = useSupportGrants(venueId);
  const [busy, setBusy] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const act = async (g: SupportGrant, verb: "approve" | "decline" | "revoke") => {
    setBusy(g.id);
    setConflict(false);
    try {
      await api("POST", `/v1/venues/${venueId}/support-grants/${g.id}/${verb}`);
    } catch {
      setConflict(true);
    } finally {
      setBusy(null);
      await load();
    }
  };

  const scopeText = (g: SupportGrant) =>
    g.scope === "read"
      ? t("support.scope.read")
      : t("support.scope.write", {
          action: t(`support.action.${g.action ?? "requeue_print"}` as MessageKey),
        });
  const stateText = (g: SupportGrant) =>
    g.state === "open"
      ? t("support.state.open", { minutes: minutesLeft(g) })
      : t(`support.state.${g.state}` as MessageKey);

  return (
    <section className="support-access" aria-labelledby="support-h">
      <h2 id="support-h">{t("admin.section.console")}</h2>
      <p className="small">{t("support.intro")}</p>
      {(failed || conflict) && (
        <p className="error" role="alert">
          {conflict ? t("support.error.answered") : t("shell.error.cantReach")}
        </p>
      )}
      {grants === null ? (
        !failed && <p role="status">{t("support.loading")}</p>
      ) : grants.length === 0 ? (
        <p className="hint">{t("support.empty")}</p>
      ) : (
        <ul className="support-list">
          {grants.map((g) => (
            <li
              key={g.id}
              aria-label={t("support.from", { name: g.staff_name ?? "—" })}
              className={`support-grant support-${g.state}`}
            >
              <div>
                <strong>{t("support.from", { name: g.staff_name ?? "—" })}</strong>
                <span className={g.state === "open" || g.state === "waiting" ? "warn" : "muted"}>
                  {stateText(g)}
                </span>
              </div>
              <p>{t("support.reason", { reason: g.reason })}</p>
              <p className="small">
                {scopeText(g)} · {t("support.length", { minutes: g.minutes })}
                {g.action_used_at ? ` · ${t("support.actionUsed")}` : ""}
              </p>
              {g.state === "waiting" && (
                <div className="support-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy === g.id}
                    onClick={() => void act(g, "approve")}
                  >
                    {t("support.approve")}
                  </button>
                  <button
                    type="button"
                    disabled={busy === g.id}
                    onClick={() => void act(g, "decline")}
                  >
                    {t("support.decline")}
                  </button>
                </div>
              )}
              {g.state === "open" && (
                <div className="support-actions">
                  <button
                    type="button"
                    className="danger"
                    disabled={busy === g.id}
                    onClick={() => void act(g, "revoke")}
                  >
                    {t("support.endNow")}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The banner across Admin while a grant is open (screens N39 · While open). */
export function SupportBanner({ venueId }: { venueId: string }) {
  const { t } = useT();
  const { grants } = useSupportGrants(venueId);
  const open = grants?.find((g) => g.state === "open");
  if (!open) return null;
  return (
    <p className="notice warn support-banner" role="status" data-testid="support-banner">
      <span>
        {t("support.banner", { name: open.staff_name ?? "—", minutes: minutesLeft(open) })}
      </span>{" "}
      <Link to="/admin/console">{t("support.banner.open")}</Link>
    </p>
  );
}
