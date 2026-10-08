"use client";

import { useEffect } from "react";
import { reportUncaught } from "@west4/shared";
import { reporter } from "./telemetry";

/** Every guest page reports its uncaught errors, scrubbed of personal data (M8-16). */
export function ErrorReporting() {
  useEffect(() => reportUncaught(window, reporter, () => window.location.pathname), []);
  return null;
}
