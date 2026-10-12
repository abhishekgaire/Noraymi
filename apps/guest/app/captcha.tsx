"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t, type MessageKey } from "@west4/shared";

/**
 * The security check on the guest web's public forms (M2-27, D109): Cloudflare
 * Turnstile's widget. Its script loads from challenges.cloudflare.com only on
 * a page that mounts this hook (the waitlist page, the singer's code request,
 * and with M5-05 Book and the enquiry form), never on the payment page. The
 * site key comes from the API (GET /v1/public/captcha), so it lives in one
 * place; locally that's Cloudflare's always-pass test key. The token it hands
 * back goes with the form as `captcha_token`; the server checks it with
 * Cloudflare, once, so the hook resets the widget after every send.
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
let siteKey: Promise<string> | null = null;

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

function loadSiteKey(): Promise<string> {
  siteKey ??= fetch("/v1/public/captcha")
    .then((r) => (r.ok ? (r.json() as Promise<{ site_key?: string }>) : Promise.reject()))
    .then((b) => (b.site_key ? b.site_key : Promise.reject(new Error("no site key"))))
    .catch((e: unknown) => {
      siteKey = null;
      throw e;
    });
  return siteKey;
}

export type CaptchaState = "waiting" | "ready" | "unavailable";

export interface Captcha {
  /** The widget, with its status line: render it inside the form, above the send button. */
  readonly widget: ReactNode;
  /** The one-time token, once the check has passed; null until then and after each send. */
  readonly token: string | null;
  readonly state: CaptchaState;
  /** After every send: a token is good once, so the widget makes a new one. */
  reset(): void;
}

/** `action` names the form in Cloudflare's analytics: letters, digits, - and _. */
export function useCaptcha(action: string): Captcha {
  // A callback ref: a form that swaps steps remounts the box, and the widget follows it.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<CaptchaState>("waiting");

  useEffect(() => {
    // Nothing loads until the widget's box is on the page.
    if (!box) return;
    let gone = false;
    Promise.all([loadSiteKey(), loadTurnstile()])
      .then(([key, turnstile]) => {
        if (gone) return;
        setToken(null);
        setState("waiting");
        widgetId.current = turnstile.render(box, {
          sitekey: key,
          action,
          theme: "auto",
          language: "en",
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
  }, [action, box]);

  const reset = useCallback(() => {
    setToken(null);
    setState("waiting");
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  }, []);

  const widget = (
    <div className="captcha" role="group" aria-label={t("en", "guestCaptcha.label")}>
      <div ref={setBox} />
      {state === "waiting" && <p className="small">{t("en", "guestCaptcha.waiting")}</p>}
      {state === "unavailable" && <p role="alert">{t("en", "guestCaptcha.unavailable")}</p>}
    </div>
  );
  return { widget, token, state, reset };
}

/**
 * The guest's words for a refused send: the security check, or the form's daily limit
 * (`limit`: what the guest is told to do instead). Null for any other refusal.
 */
export function captchaRefusal(
  body: { error?: { code?: string } } | null | undefined,
  limit: MessageKey,
): string | null {
  switch (body?.error?.code) {
    case "captcha_failed":
      return t("en", "guestCaptcha.failed");
    case "captcha_unavailable":
      return t("en", "guestCaptcha.busy");
    case "daily_limit":
      return t("en", limit);
    default:
      return null;
  }
}
