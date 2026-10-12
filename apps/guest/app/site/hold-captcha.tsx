"use client";
import { createContext, useContext, type ReactNode } from "react";
import { useCaptcha, type Captcha } from "../captcha";

/**
 * Book's security check (M5-05): one widget above the start times, shared by every time's Hold
 * button, so the guest passes it once and picks any time.
 */
const HoldCaptchaContext = createContext<Captcha | null>(null);

export function HoldCaptcha({ children }: { children: ReactNode }) {
  const captcha = useCaptcha("booking");
  return (
    <HoldCaptchaContext.Provider value={captcha}>
      {captcha.widget}
      {children}
    </HoldCaptchaContext.Provider>
  );
}

export function useHoldCaptcha(): Captcha | null {
  return useContext(HoldCaptchaContext);
}
