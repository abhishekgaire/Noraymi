import type { ReactNode } from "react";
import { t } from "@west4/shared";
import "@west4/shared/design/fonts.css";
import "@west4/shared/design/tokens.css";
import "./globals.css";
import { ErrorReporting } from "./error-reporting";

export const metadata = {
  title: t("en", "app.guest.name"),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ErrorReporting />
        {children}
      </body>
    </html>
  );
}
