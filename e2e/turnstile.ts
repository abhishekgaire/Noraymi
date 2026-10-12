import type { BrowserContext, Page } from "@playwright/test";

/**
 * Cloudflare Turnstile in the browser tests (M2-27): the widget's script is
 * answered here, never fetched from Cloudflare, by a stand-in that behaves
 * like Cloudflare's always-pass test key. It draws a titled frame and hands
 * back the dummy token, which the API (on Cloudflare's test secret) accepts.
 */
export const TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const STUB = `(() => {
  let n = 0;
  const widgets = {};
  const pass = (o) => setTimeout(() => o.callback && o.callback(${JSON.stringify(TEST_TOKEN)}), 50);
  window.turnstile = {
    render(el, o) {
      const id = "w" + ++n;
      const f = document.createElement("iframe");
      f.title = "Widget containing a Cloudflare security challenge";
      f.srcdoc = '<!doctype html><html lang="en"><head><title>Security check</title></head><body><p>Success!</p></body></html>';
      f.style.cssText = "border:0;width:300px;height:65px";
      el.appendChild(f);
      widgets[id] = { el: f, o };
      pass(o);
      return id;
    },
    reset(id) {
      const w = widgets[id];
      if (w) pass(w.o);
    },
    remove(id) {
      const w = widgets[id];
      if (w) w.el.remove();
      delete widgets[id];
    },
  };
})();`;

export async function stubTurnstile(target: BrowserContext | Page): Promise<void> {
  await target.route("https://challenges.cloudflare.com/turnstile/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: STUB }),
  );
}
