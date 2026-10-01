import type { ReactNode } from "react";
import { t } from "@west4/shared";
import "./globals.css";

export const metadata = {
  title: t("en", "app.guest.name"),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
