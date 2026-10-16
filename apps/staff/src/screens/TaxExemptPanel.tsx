import { useState, type FormEvent } from "react";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";
import { useModuleOn } from "../useModule.js";

/**
 * Tax exempt on a check (P-15; Money rules 8): a room's check or a bar tab, for an organization with
 * an exemption certificate. The organization's name and the certificate number are both required
 * (the server refuses it without them), and a manager approves it per the venue's setting (on their
 * phone, by PIN or none); then sales tax comes off what the exemption covers. Remove takes it off
 * while the check is open. Shows only while the venue's switch is on, except Remove, so an
 * exemption is never stuck on a check.
 */
export interface TaxExemptView {
  readonly organization: string;
  readonly certificate_no: string;
  readonly still_taxed: readonly string[];
}
export interface PendingTaxExempt {
  readonly waiting_for: string;
  readonly organization: string;
}

export function TaxExemptPanel(props: {
  venueId: string;
  checkId: string;
  exempt: TaxExemptView | null;
  pending: PendingTaxExempt | null;
  /** Whether the check is still open: an exemption changes only then (before payment). */
  open: boolean;
  /** The bar POS: with nothing standing or asked, only its button until it's pressed. */
  folded?: boolean;
  onDone: () => void;
}) {
  const { t } = useT();
  const on = useModuleOn("tax_exempt");
  const [editing, setEditing] = useState(false);
  const [organization, setOrganization] = useState("");
  const [certificate, setCertificate] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!on && !props.exempt) return null;

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!organization.trim()) return setError(t("taxExempt.organizationMissing"));
    if (!certificate.trim()) return setError(t("taxExempt.certificateMissing"));
    setBusy(true);
    try {
      const answer = await api<{
        status: string;
        waiting_for?: { name: string } | null;
        decided_with?: string;
      }>("POST", `/v1/venues/${props.venueId}/checks/${props.checkId}/tax-exempt`, {
        organization: organization.trim(),
        certificate_no: certificate.trim(),
      });
      setMessage(
        answer.status === "approved"
          ? t("taxExempt.given")
          : answer.decided_with === "pin"
            ? t("approvals.pin.needs")
            : answer.waiting_for
              ? t("fix.waiting", { name: answer.waiting_for.name })
              : t("taxExempt.given"),
      );
      setEditing(false);
      setOrganization("");
      setCertificate("");
      props.onDone();
    } catch (err) {
      setError((err as ApiCallError)?.message ?? t("taxExempt.failed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    setBusy(true);
    try {
      await api("POST", `/v1/venues/${props.venueId}/checks/${props.checkId}/tax-exempt/remove`);
      setMessage(t("taxExempt.removed"));
      props.onDone();
    } catch (err) {
      setError((err as ApiCallError)?.message ?? t("taxExempt.failed"));
    } finally {
      setBusy(false);
    }
  };

  if (props.folded && !props.exempt && !props.pending && !editing && !message && !error)
    return props.open && on ? (
      <button type="button" className="secondary tax-exempt-open" onClick={() => setEditing(true)}>
        {t("taxExempt.open")}
      </button>
    ) : null;
  const stillTaxed = (props.exempt?.still_taxed ?? [])
    .map((c) => t(`taxExempt.category.${c}` as "taxExempt.category.drink"))
    .join(", ");
  return (
    <section className="fix-panel tax-exempt-panel" aria-label={t("taxExempt.title")}>
      <h3>{t("taxExempt.title")}</h3>
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
      {props.exempt ? (
        <>
          <p className="fix-line" data-testid="tax-exempt-standing">
            <span data-guest-text>
              {t("taxExempt.standing", {
                organization: props.exempt.organization,
                certificate: props.exempt.certificate_no,
              })}
            </span>{" "}
            {props.open && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void remove()}
              >
                {t("taxExempt.remove")}
              </button>
            )}
          </p>
          {stillTaxed && (
            <p className="small muted">{t("taxExempt.stillTaxed", { list: stillTaxed })}</p>
          )}
        </>
      ) : props.pending ? (
        <p className="muted" data-testid="tax-exempt-waiting">
          {t("fix.waiting", { name: props.pending.waiting_for })}
        </p>
      ) : (
        props.open &&
        on &&
        !editing && (
          <button type="button" className="secondary" onClick={() => setEditing(true)}>
            {t("taxExempt.open")}
          </button>
        )
      )}
      {editing && !props.exempt && !props.pending && props.open && (
        <form className="invite-form" onSubmit={(e) => void ask(e)} noValidate>
          <p className="small">{t("taxExempt.hint")}</p>
          <div className="invite-fields">
            <label>
              <span>{t("taxExempt.organization")}</span>
              <input
                value={organization}
                maxLength={200}
                onChange={(e) => setOrganization(e.target.value)}
              />
            </label>
            <label>
              <span>{t("taxExempt.certificate")}</span>
              <input
                value={certificate}
                maxLength={60}
                onChange={(e) => setCertificate(e.target.value)}
              />
            </label>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {t("taxExempt.ask")}
            </button>
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              {t("taxExempt.back")}
            </button>
          </div>
        </form>
      )}
      {error && !editing && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
