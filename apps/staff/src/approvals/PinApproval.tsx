import { useState, type FormEvent } from "react";
import { api, type ApiCallError } from "../api.js";
import { useT } from "../i18n.js";

/**
 * Manager's PIN at the register (F-04; D124; screens N18): an owner or a manager other than the
 * requester picks their name, types their PIN on this register and approves or declines. A wrong
 * PIN says so and counts toward the sign-in lockout on this device.
 */
export function PinApproval({
  venueId,
  approvalId,
  approvers,
  onDone,
}: {
  venueId: string;
  approvalId: string;
  approvers: readonly { readonly user_id: string; readonly name: string }[];
  onDone: () => void;
}) {
  const { t } = useT();
  const [who, setWho] = useState<string>(approvers[0]?.user_id ?? "");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (decision: "approve" | "decline", e?: FormEvent) => {
    e?.preventDefault();
    if (!who || !/^\d{4,8}$/.test(pin)) {
      setError(t("approvals.pin.needed"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/v1/venues/${venueId}/approvals/${approvalId}/pin`, {
        user_id: who,
        pin,
        decision,
      });
      onDone();
    } catch (err) {
      setPin("");
      setError((err as ApiCallError)?.message ?? t("approvals.failed"));
    } finally {
      setBusy(false);
    }
  };

  if (approvers.length === 0)
    return (
      <p className="small muted" role="status">
        {t("approvals.pin.nobody")}
      </p>
    );
  return (
    <form
      className="pin-approval"
      aria-label={t("approvals.pin.title")}
      onSubmit={(e) => void send("approve", e)}
    >
      <fieldset>
        <legend>{t("approvals.pin.who")}</legend>
        {approvers.map((a) => (
          <label key={a.user_id} className="check">
            <input
              type="radio"
              name={`pin-approver-${approvalId}`}
              checked={who === a.user_id}
              onChange={() => setWho(a.user_id)}
            />{" "}
            {a.name}
          </label>
        ))}
      </fieldset>
      <label>
        <span>{t("approvals.pin.pin")}</span>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        />
      </label>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {t("approvals.approve")}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void send("decline")}
        >
          {t("approvals.decline")}
        </button>
      </div>
    </form>
  );
}
