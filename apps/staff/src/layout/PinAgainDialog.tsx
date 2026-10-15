import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MessageKey } from "@west4/shared";
import { setPinAgainPrompt } from "../api.js";
import { useT } from "../i18n.js";
import { Dialog, useSheetDialog } from "./Dialog.js";

/**
 * Ask for the PIN again (P-10; spec 02 · PINs): when the venue ticks an action in Admin → Features →
 * Choices, the API answers pin_again_required and this asks the signed-in person for their own PIN,
 * then the same call goes again with it. A wrong PIN says so and counts toward the sign-in lockout
 * on this device; Cancel leaves the action undone. Mounted once, for every screen.
 */
interface Asking {
  readonly action: string;
  readonly problem: "wrong" | "locked" | null;
  readonly answer: (pin: string | null) => void;
}

const actionKey: Record<string, MessageKey> = {
  no_sale: "pinAgain.action.no_sale",
  void: "pinAgain.action.void",
  comp: "pinAgain.action.comp",
  discount: "pinAgain.action.discount",
  refund: "pinAgain.action.refund",
  reprint_receipt: "pinAgain.action.reprint_receipt",
  open_tab: "pinAgain.action.open_tab",
  change_tip: "pinAgain.action.change_tip",
};

export function PinAgainDialog() {
  const [asking, setAsking] = useState<Asking | null>(null);
  useEffect(() => {
    setPinAgainPrompt(
      (action, problem) =>
        new Promise<string | null>((resolve) =>
          setAsking({
            action,
            problem,
            answer: (pin) => {
              setAsking(null);
              resolve(pin);
            },
          }),
        ),
    );
    return () => setPinAgainPrompt(null);
  }, []);
  if (!asking) return null;
  return (
    <Dialog onClose={() => asking.answer(null)}>
      <PinAgainSheet asking={asking} />
    </Dialog>
  );
}

function PinAgainSheet({ asking }: { asking: Asking }) {
  const { t } = useT();
  const [pin, setPin] = useState("");
  const [short, setShort] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const sheet = useSheetDialog(t("pinAgain.title"));
  useEffect(() => input.current?.focus(), []);
  const key = actionKey[asking.action];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{4,8}$/.test(pin)) {
      setShort(true);
      return;
    }
    asking.answer(pin);
  };
  return (
    <form className="sheet pin-again" {...sheet.root} onSubmit={submit}>
      <h2 {...sheet.title}>{t("pinAgain.title")}</h2>
      <p className="small">{key ? t("pinAgain.why", { action: t(key) }) : t("pinAgain.whyAny")}</p>
      <label>
        <span>{t("pinAgain.pin")}</span>
        <input
          ref={input}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          aria-label={t("pinAgain.pin")}
          value={pin}
          onChange={(e) => {
            setShort(false);
            setPin(e.target.value.replace(/\D/g, ""));
          }}
        />
      </label>
      {(short || asking.problem) && (
        <p className="error small" role="alert">
          {short
            ? t("pinAgain.needed")
            : asking.problem === "locked"
              ? t("pinAgain.locked")
              : t("pinAgain.wrong")}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary">
          {t("pinAgain.continue")}
        </button>
        <button type="button" className="secondary" onClick={() => asking.answer(null)}>
          {t("pinAgain.cancel")}
        </button>
      </div>
    </form>
  );
}
