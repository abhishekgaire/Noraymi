import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api.js";
import { useT } from "./i18n.js";

/**
 * The security check on the invite link's phone-code request (M2-27, D109): Cloudflare Turnstile's
 * widget, its script loaded from challenges.cloudflare.com only when the invite page shows it. The
 * site key comes from the API (GET /v1/public/captcha); the token goes with the request as
 * `captcha_token`, which the server checks with Cloudflare once, so the widget resets after a send.
 */
interface Turnstile {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let script: Promise<Turnstile> | null = null;

function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  script ??= new Promise<Turnstile>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SCRIPT;
    el.async = true;
    el.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile"));
    el.onerror = () => {
      script = null;
      el.remove();
      reject(new Error("turnstile"));
    };
    document.head.appendChild(el);
  });
  return script;
}

export interface Captcha {
  readonly widget: ReactNode;
  readonly token: string | null;
  reset(): void;
}

export function useCaptcha(action: string): Captcha {
  const { t, locale } = useT();
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<"waiting" | "ready" | "unavailable">("waiting");

  useEffect(() => {
    // Nothing loads until the widget's box is on the page.
    if (!box) return;
    let gone = false;
    Promise.all([api<{ site_key: string }>("GET", "/v1/public/captcha"), loadTurnstile()])
      .then(([{ site_key }, turnstile]) => {
        if (gone) return;
        setToken(null);
        setState("waiting");
        widgetId.current = turnstile.render(box, {
          sitekey: site_key,
          action,
          theme: "auto",
          language: locale,
          size: "flexible",
          "response-field": false,
          callback: (value: string) => {
            setToken(value);
            setState("ready");
          },
          "expired-callback": () => {
            setToken(null);
            setState("waiting");
          },
          "error-callback": () => {
            setToken(null);
            setState("unavailable");
          },
        });
      })
      .catch(() => {
        if (!gone) setState("unavailable");
      });
    return () => {
      gone = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [action, box, locale]);

  const reset = useCallback(() => {
    setToken(null);
    setState("waiting");
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  }, []);

  const widget = (
    <div className="captcha" role="group" aria-label={t("invite.captcha")}>
      <div ref={setBox} />
      {state === "waiting" && <p className="muted">{t("invite.captchaWaiting")}</p>}
      {state === "unavailable" && (
        <p className="error" role="alert">
          {t("invite.captchaUnavailable")}
        </p>
      )}
    </div>
  );
  return { widget, token, reset };
}
