import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every sheet and dialog works the same way (U-22, D133): each one is the shared `Dialog`
 * (layout/Dialog.tsx), so Esc closes it with no change, Tab stays inside it, focus goes back to
 * what opened it, and a phone shows it as a bottom sheet. This is the list of them: a new sheet
 * adds its line here, and a hand-built `role="dialog"` (or `aria-modal`) anywhere else fails.
 * The e2e "U-22 · …" tests press Esc and Tab in the real screens.
 */
const DIALOGS: Record<string, { count: number; what: string }> = {
  "approvals/PinApproval.tsx": { count: 1, what: "Needs a manager's PIN (on top)" },
  "layout/PinAgainDialog.tsx": { count: 1, what: "Your PIN again (on top)" },
  "screens/AddPackage.tsx": { count: 2, what: "Choose a package; the package's choices" },
  "screens/Calendar.tsx": { count: 1, what: "Block this date" },
  "screens/CutOff.tsx": { count: 1, what: "No more alcohol: a room, a guest or a tab" },
  "screens/FoodChoices.tsx": { count: 1, what: "An item's choices" },
  "screens/NoSaleButton.tsx": { count: 1, what: "No sale" },
  "screens/PhoneTonight.tsx": { count: 2, what: "Check in; a booking's sheet" },
  "screens/Rail.tsx": { count: 2, what: "A drink's sizes (and 86); Move to a new room" },
  "screens/RefundSheet.tsx": { count: 1, what: "Refund from check" },
  "screens/RoomScreen.tsx": { count: 3, what: "Move, Report a fault, Damage fee" },
  "screens/SendToKitchen.tsx": { count: 2, what: "N food items not sent; Send to kitchen" },
  "screens/TipChangeSheet.tsx": { count: 1, what: "Change tip" },
  "screens/Tonight.tsx": { count: 4, what: "Check in, Damage fee, Move, Report a fault" },
  "screens/admin/Devices.tsx": { count: 1, what: "Revoke a device?" },
  "screens/admin/EraseGuest.tsx": { count: 1, what: "Erase a guest?" },
  "screens/admin/Features.tsx": { count: 1, what: "Turn a feature on or off?" },
  "screens/admin/Rooms.tsx": { count: 1, what: "Archive a room?" },
  "screens/admin/SetUpVenue.tsx": { count: 1, what: "Set up your venue's sheets" },
  "screens/admin/Team.tsx": { count: 1, what: "Deactivate someone?" },
  "screens/admin/TwilioConnect.tsx": { count: 1, what: "Disconnect Twilio?" },
};

const here = path.dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [full] : [];
  });
}
const files = sources(here).map((full) => ({
  rel: path.relative(here, full).split(path.sep).join("/"),
  text: readFileSync(full, "utf8"),
}));

describe("every sheet is the shared Dialog (U-22)", () => {
  it("the list above is every Dialog in the staff app", () => {
    const found: Record<string, number> = {};
    for (const f of files) {
      const n = f.text.match(/<Dialog\b/g)?.length ?? 0;
      if (n > 0) found[f.rel] = n;
    }
    expect(found).toEqual(
      Object.fromEntries(Object.entries(DIALOGS).map(([k, v]) => [k, v.count])),
    );
  });

  it("no screen hand-builds a dialog: role dialog or alertdialog only on <Dialog>, aria-modal only in it", () => {
    const bad: string[] = [];
    for (const f of files) {
      if (f.rel === "layout/Dialog.tsx") continue;
      if (/aria-modal/.test(f.text)) bad.push(`${f.rel}: aria-modal`);
      for (const m of f.text.matchAll(/role=["{]+"?(alert)?dialog"/g)) {
        const tag = f.text.slice(0, m.index).lastIndexOf("<");
        const name = /^<([A-Za-z]+)/.exec(f.text.slice(tag))?.[1];
        if (name !== "Dialog") {
          const line = f.text.slice(0, m.index).split("\n").length;
          bad.push(`${f.rel}:${line} <${name ?? "?"} ${m[0]}>`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("the Dialog closes on Esc, keeps Tab inside, and is a bottom sheet on a phone", () => {
    const dialog = readFileSync(path.join(here, "layout/Dialog.tsx"), "utf8");
    expect(dialog).toMatch(/e\.key === "Escape"/);
    expect(dialog).toMatch(/lastItem\.focus\(\)/);
    expect(dialog).toMatch(/firstItem\.focus\(\)/);
    expect(dialog).toMatch(/opener\?\.isConnected/);
    const css = readFileSync(path.join(here, "layout/dialog.css"), "utf8");
    expect(css).toMatch(
      /@media \(max-width: 1023\.98px\) \{\s*\.dialog-scrim \{\s*place-items: end stretch;/,
    );
  });
});
