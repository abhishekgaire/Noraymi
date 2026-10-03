import { useCallback, useEffect, useState } from "react";
import {
  SITE_PHOTO_PLACES,
  type ModuleId,
  type SiteContent,
  type SitePhoto,
  type WebsiteSettings,
} from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api, ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { uploadPhoto } from "../../upload.js";

/**
 * Admin → Website (M5-02; Settings · website; screens SiteBuilder note 2):
 * one draft of the guest site's words, photos (each with alt text) and which
 * sections show, then Publish. Every published version is kept, and any of
 * them can be published again to undo a publish. A section whose module is
 * off can't be switched on, and says why. How prices read is a setting, saved
 * with Save and publish. Styles, section order and domains wait for the
 * phase 2 builder.
 */
interface Section {
  readonly id: keyof typeof SECTION_KEYS;
  readonly module: ModuleId | null;
  readonly module_on: boolean;
  readonly shown: boolean;
}
interface Versions {
  readonly draft: { readonly version: number } | null;
  readonly live_version: number | null;
  readonly content: SiteContent | null;
  readonly photos: readonly (SitePhoto & { readonly url: string | null })[];
  readonly sections: readonly Section[];
  readonly versions: readonly {
    readonly version: number;
    readonly published_at: string;
    readonly published_on: string;
    readonly published_by: string | null;
    readonly headline: string;
    readonly live: boolean;
  }[];
}

const SECTION_KEYS = {
  numbers: "website.section.numbers",
  songbook: "website.section.songbook",
  singAtTheBar: "website.section.singAtTheBar",
  menu: "website.section.menu",
  houseRules: "website.section.houseRules",
  rooms: "website.section.rooms",
  findUs: "website.section.findUs",
  parties: "website.section.parties",
  packages: "website.section.packages",
} as const;
const PLACE_KEYS = {
  hero: "website.place.hero",
  rooms: "website.place.rooms",
  parties: "website.place.parties",
} as const;

export function Website() {
  const { t, date } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [site, setSite] = useState<Versions | null>(null);
  const [content, setContent] = useState<SiteContent | null>(null);
  const [wording, setWording] = useState<WebsiteSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});

  const take = useCallback((v: Versions) => {
    setSite(v);
    setContent(v.content);
    setUrls(Object.fromEntries(v.photos.flatMap((p) => (p.url ? [[p.file_id, p.url]] : []))));
  }, []);
  const load = useCallback(async () => {
    try {
      take(await api<Versions>("GET", `/v1/venues/${venueId}/site-versions`));
      setWording(
        (await api<{ value: WebsiteSettings }>("GET", `/v1/venues/${venueId}/settings/website`))
          .value,
      );
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId, take]);
  useEffect(() => {
    if (venueId) void load();
  }, [venueId, load, draft.version]);

  const refused = (error: unknown) => {
    if (error instanceof ApiCallError) setProblem(error.message);
    else setFailed(true);
  };
  const save = async () => {
    if (!content) return;
    setNote(null);
    if (content.photos.some((p) => !p.alt.trim())) {
      setProblem(t("website.altNeeded"));
      return;
    }
    try {
      take(await api<Versions>("PUT", `/v1/venues/${venueId}/site-versions/draft`, content));
      setProblem(null);
      setNote(t("website.saved"));
    } catch (error) {
      refused(error);
    }
  };
  const publish = async (path: string) => {
    try {
      const done = await api<{ version: number }>("POST", `/v1/venues/${venueId}${path}`);
      setProblem(null);
      setNote(t("website.published", { n: done.version }));
      await load();
    } catch (error) {
      refused(error);
    }
  };
  const addPhoto = async (file: File) => {
    if (!content) return;
    setUploading(true);
    try {
      const fileId = await uploadPhoto(venueId, "site_photo", file);
      setUrls((u) => ({ ...u, [fileId]: URL.createObjectURL(file) }));
      setContent({
        ...content,
        photos: [...content.photos, { file_id: fileId, alt: "", place: "hero" }],
      });
      setProblem(null);
    } catch {
      setProblem(t("website.uploadFailed"));
    } finally {
      setUploading(false);
    }
  };

  const edit = (next: Partial<SiteContent>) => content && setContent({ ...content, ...next });
  const setPhoto = (i: number, next: Partial<SitePhoto>) =>
    content && edit({ photos: content.photos.map((p, j) => (j === i ? { ...p, ...next } : p)) });
  const word = (
    label: Parameters<typeof t>[0],
    value: string,
    onChange: (v: string) => void,
    long = false,
  ) => (
    <label>
      <span>{t(label)}</span>
      {long ? (
        <textarea aria-label={t(label)} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input aria-label={t(label)} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
  const currentWording =
    (draft.values["website"] as WebsiteSettings | undefined) ?? wording ?? null;

  return (
    <section className="website">
      <h2>{t("admin.section.website")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {site === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : content === null ? (
        <p>{t("website.none")}</p>
      ) : (
        <>
          <p>
            {site.live_version !== null && t("website.live", { n: site.live_version })}
            {site.draft && <span className="small muted"> · {t("website.draftOpen")}</span>}
          </p>

          <h3>{t("website.words")}</h3>
          <div className="invite-fields">
            {word("website.hero.headline", content.hero.headline, (v) =>
              edit({ hero: { ...content.hero, headline: v } }),
            )}
            {word(
              "website.hero.lead",
              content.hero.lead,
              (v) => edit({ hero: { ...content.hero, lead: v } }),
              true,
            )}
            {word("website.rooms.heading", content.rooms.heading, (v) =>
              edit({ rooms: { ...content.rooms, heading: v } }),
            )}
            {word(
              "website.rooms.lead",
              content.rooms.lead,
              (v) => edit({ rooms: { ...content.rooms, lead: v } }),
              true,
            )}
            {word("website.parties.headline", content.parties.headline, (v) =>
              edit({ parties: { ...content.parties, headline: v } }),
            )}
            {word(
              "website.parties.lead",
              content.parties.lead,
              (v) => edit({ parties: { ...content.parties, lead: v } }),
              true,
            )}
            <label>
              <span>{t("website.songCount")}</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                aria-label={t("website.songCount")}
                value={content.songbook.songCount ?? ""}
                onChange={(e) =>
                  edit({
                    songbook: {
                      ...content.songbook,
                      songCount: e.target.value === "" ? null : Math.max(0, Number(e.target.value)),
                    },
                  })
                }
              />
              <span className="small muted">{t("website.songCount.hint")}</span>
            </label>
          </div>

          <h3>{t("website.sections")}</h3>
          <ul className="list">
            {site.sections.map((s) => (
              <li key={s.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={s.module_on && !content.hidden.includes(s.id)}
                    disabled={!s.module_on}
                    onChange={(e) =>
                      edit({
                        hidden: e.target.checked
                          ? content.hidden.filter((h) => h !== s.id)
                          : [...content.hidden, s.id],
                      })
                    }
                  />{" "}
                  {t(SECTION_KEYS[s.id])}
                </label>
                {!s.module_on && s.module && (
                  <span className="small muted">
                    {" "}
                    {t("website.moduleOff", { module: t(`module.${s.module}.name`) })}
                  </span>
                )}
              </li>
            ))}
          </ul>

          <h3>{t("website.photos")}</h3>
          <ul className="list">
            {content.photos.map((p, i) => (
              <li key={p.file_id} className="invite-fields">
                {urls[p.file_id] && <img src={urls[p.file_id]} alt={p.alt} width={160} />}
                <label>
                  <span>{t("website.alt")}</span>
                  <input
                    aria-label={t("website.alt")}
                    value={p.alt}
                    required
                    aria-invalid={!p.alt.trim()}
                    maxLength={200}
                    onChange={(e) => setPhoto(i, { alt: e.target.value })}
                  />
                </label>
                <label>
                  <span>{t("website.place")}</span>
                  <select
                    aria-label={t("website.place")}
                    value={p.place}
                    onChange={(e) => setPhoto(i, { place: e.target.value as SitePhoto["place"] })}
                  >
                    {SITE_PHOTO_PLACES.map((place) => (
                      <option key={place} value={place}>
                        {t(PLACE_KEYS[place])}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => edit({ photos: content.photos.filter((_, j) => j !== i) })}
                >
                  {t("website.removePhoto")}
                </button>
              </li>
            ))}
          </ul>
          <label className="button secondary">
            {uploading ? t("website.uploading") : t("website.addPhoto")}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label={t("website.addPhoto")}
              hidden
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void addPhoto(file);
                e.target.value = "";
              }}
            />
          </label>

          {currentWording && (
            <fieldset>
              <legend>{t("website.priceWording")}</legend>
              {(["plusTaxAndGratuity", "allIn"] as const).map((w) => (
                <label key={w}>
                  <input
                    type="radio"
                    name="priceWording"
                    checked={currentWording.priceWording === w}
                    onChange={() => draft.set("website", { ...currentWording, priceWording: w })}
                  />{" "}
                  {t(`website.priceWording.${w}`)}
                </label>
              ))}
              <span className="small muted">{t("website.priceWording.hint")}</span>
            </fieldset>
          )}

          {problem && (
            <p className="error" role="alert">
              {problem}
            </p>
          )}
          {note && <p role="status">{note}</p>}
          <div className="actions">
            <button type="button" className="secondary" onClick={() => void save()}>
              {t("website.save")}
            </button>
            <button
              type="button"
              disabled={!site.draft}
              onClick={() => void publish("/site-versions/draft/publish")}
            >
              {t("website.publish")}
            </button>
          </div>

          <h3>{t("website.versions")}</h3>
          <ul className="list">
            {site.versions.map((v) => (
              <li key={v.version}>
                <strong>{t("website.version", { n: v.version })}</strong> ·{" "}
                <span data-guest-text>{v.headline}</span> · {date(v.published_on)}
                {v.published_by && <> · {v.published_by}</>}{" "}
                {v.live ? (
                  <span className="tag">{t("website.liveTag")}</span>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void publish(`/site-versions/${v.version}/republish`)}
                  >
                    {t("website.republish")}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="small muted">{t("website.later")}</p>
        </>
      )}
    </section>
  );
}
