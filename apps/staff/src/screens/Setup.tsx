import { useEffect, useState } from "react";
import { useT } from "../i18n.js";
import { isIos, pushState, sendTestPush, subscribeToPush, type PushState } from "../push.js";
import { useSession } from "../session.js";

/**
 * Alerts on this phone (M1-22, spec 09 · Staff phones). On an iPhone web push
 * works only after the app is added to the home screen, so the screen walks
 * through that first; then one tap turns alerts on, and a test alert proves it.
 */
type Status = PushState | "loading" | "working" | "failed";

export function Setup() {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : null;
  const [status, setStatus] = useState<Status>("loading");
  const [testSent, setTestSent] = useState(false);

  useEffect(() => {
    let live = true;
    pushState()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus("unsupported"));
    return () => {
      live = false;
    };
  }, []);

  const turnOn = async () => {
    if (!venueId) return;
    setStatus("working");
    try {
      setStatus(await subscribeToPush(venueId));
    } catch {
      setStatus("failed");
    }
  };

  const sendTest = async () => {
    if (!venueId) return;
    setTestSent(false);
    try {
      await sendTestPush(venueId);
      setTestSent(true);
    } catch {
      setStatus("failed");
    }
  };

  const ios = typeof navigator !== "undefined" && isIos();

  return (
    <section className="screen setup">
      <h1>{t("setup.title")}</h1>
      <p>{t("setup.intro")}</p>
      {status === "loading" && (
        <p className="muted" role="status">
          {t("shell.loading")}
        </p>
      )}
      {status === "needsHomeScreen" && (
        <ol className="steps">
          <li>{t("setup.iphone.step1")}</li>
          <li>{t("setup.iphone.step2")}</li>
          <li>{t("setup.iphone.step3")}</li>
        </ol>
      )}
      {status === "ready" && (
        <>
          <p className="muted">{ios ? t("setup.installed") : t("setup.android.hint")}</p>
          <button type="button" className="primary" onClick={() => void turnOn()}>
            {t("setup.turnOn")}
          </button>
        </>
      )}
      {status === "working" && (
        <p className="muted" role="status">
          {t("setup.working")}
        </p>
      )}
      {status === "subscribed" && (
        <>
          <p className="notice" role="status">
            {t("setup.on")}
          </p>
          <button type="button" className="secondary" onClick={() => void sendTest()}>
            {t("setup.sendTest")}
          </button>
          {testSent && (
            <p className="muted" role="status">
              {t("setup.testSent")}
            </p>
          )}
        </>
      )}
      {status === "denied" && (
        <p className="error" role="alert">
          {t("setup.denied")}
        </p>
      )}
      {status === "unsupported" && (
        <p className="error" role="alert">
          {t("setup.unsupported")}
        </p>
      )}
      {status === "failed" && (
        <>
          <p className="error" role="alert">
            {t("setup.failed")}
          </p>
          <button type="button" className="primary" onClick={() => void turnOn()}>
            {t("setup.turnOn")}
          </button>
        </>
      )}
    </section>
  );
}
