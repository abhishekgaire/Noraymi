/**
 * Layout checks the screen reviews share (the Spanish review in staff.spec.ts, the V-04 design
 * review): text cut off, words broken mid-word because their box got squeezed, and placeholders
 * wider than their field. Each returns a list of offenders, empty when the screen is fine.
 */
import type { Page } from "@playwright/test";

/** Visible text cut off by an overflow or an ellipsis, and a page that scrolls sideways. */
export async function clippedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const clipped: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      // Name the outermost boxes that run past the right edge, so the failure says where.
      const wide = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter(
        (el) =>
          el.getBoundingClientRect().right > window.innerWidth + 1 &&
          !el.closest("[data-scroll]") &&
          !(
            el.parentElement &&
            el.parentElement.getBoundingClientRect().right > window.innerWidth + 1
          ),
      );
      clipped.push(
        `page scrolls sideways${
          wide.length
            ? `: ${wide
                .slice(0, 3)
                .map((el) => `${el.tagName.toLowerCase()}.${el.className}`)
                .join(", ")}`
            : ""
        }`,
      );
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const text = el.textContent?.trim() ?? "";
      if (text === "") continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      // A strip meant to scroll sideways (the phone's tab bar) isn't cut-off text.
      if (el.dataset["scroll"] === "x") continue;
      const hides = style.overflowX !== "visible" || style.textOverflow === "ellipsis";
      if (hides && el.scrollWidth > el.clientWidth + 1) {
        clipped.push(`${el.tagName.toLowerCase()}.${el.className}: "${text.slice(0, 40)}"`);
      }
    }
    return clipped;
  });
}

/**
 * Words broken across lines: a box squeezed narrower than its longest word wraps it a letter or
 * two per line ("Ro / o / m / 5"). Every visible word is measured with a Range; a word whose
 * glyphs land on more than one line is reported with its element and text. Hyphens, slashes and
 * dashes are break points, so "Close-out" may wrap at its hyphen.
 */
export async function brokenWords(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue ?? "";
      const el = node.parentElement;
      if (!el || !text.trim()) continue;
      if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: false })) continue;
      if (el.closest("script, style, noscript, [data-scroll='x']")) continue;
      for (const m of text.matchAll(/[^\s\-‐–—/]{2,}/g)) {
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const tops = new Set<number>();
        for (const r of Array.from(range.getClientRects())) {
          if (r.width > 0 && r.height > 0) tops.add(Math.round(r.top / 4));
        }
        if (tops.size > 1) {
          const box = el.getBoundingClientRect();
          out.add(
            `${el.tagName.toLowerCase()}.${el.className}: "${m[0]}" in "${text.trim().slice(0, 40)}" (${Math.round(box.width)}px wide)`,
          );
        }
      }
    }
    return [...out];
  });
}

/** A field whose placeholder is wider than the field ("Find a name, room or ‹"). */
export async function clippedPlaceholders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const ctx = document.createElement("canvas").getContext("2d")!;
    for (const el of Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input[placeholder], textarea[placeholder]",
      ),
    )) {
      if (!el.placeholder || el.value || !el.checkVisibility()) continue;
      if (el.tagName === "TEXTAREA") continue; // a textarea wraps its placeholder
      const s = getComputedStyle(el, "::placeholder");
      ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
      const box = getComputedStyle(el);
      const room = el.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight);
      const need = ctx.measureText(el.placeholder).width;
      if (need > room + 1)
        out.push(
          `${el.tagName.toLowerCase()}: "${el.placeholder}" needs ${Math.ceil(need)}px, has ${Math.floor(room)}px`,
        );
    }
    return out;
  });
}
