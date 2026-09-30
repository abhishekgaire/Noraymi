import type { en } from "./en.js";

// Spanish catalog. The type makes a missing or extra key a typecheck error.
export const es: { readonly [K in keyof typeof en]: string } = {
  "app.staff.name": "App del personal",
  "app.console.name": "Consola",
  "app.guest.name": "Web para clientes",
  "app.desktop.name": "App de escritorio",
  "scaffold.placeholder": "Base lista. La primera pantalla llega con el ticket M1-21.",
};
