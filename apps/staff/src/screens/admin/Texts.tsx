import { useCallback, useEffect, useState } from "react";
import type { MessageKey, MessageSettings } from "@west4/shared";
import { useAdminDraft } from "../../admin/draft.js";
import { api, type ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";

/**
 * Admin → Texts (M2-10; spec 11 · The automatic texts): exactly the 14 texts
 * in the spec's order, each with its wording, an example and whether it's on.
 * Wording and on or off save at once; the reminder time and the offer-expiring
 * minutes go through Save and publish. The two marketing texts stay off.
 */
interface Template {
  readonly key: string;
  readonly position: number;
  readonly category: "service" | "marketing";
  readonly body: string;
  readonly on: boolean;
  readonly example: string | null;
  readonly locked_off?: boolean;
}

export function Texts() {
  const { t } = useT();
  const { state } = useSession();
  const draft = useAdminDraft();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [rows, setRows] = useState<Template[] | null>(null);
  const [settings, setSettings] = useState<MessageSettings | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [note, setNote] = useState<{ key: string; text: string; error: boolean } | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const [list, messages] = await Promise.all([
      api<{ templates: Template[] }>("GET", `/v1/venues/${venueId}/message-templates`),
      api<{ value: MessageSettings }>("GET", `/v1/venues/${venueId}/settings/messages`),
    ]);
    setRows(list.templates);
    setSettings(messages.value);
  }, [venueId]);

  useEffect(() => {
    if (!venueId) return;
    load().catch(() => setFailed(true));
  }, [venueId, load, draft.version]);

  const patch = async (key: string, body: Record<string, unknown>) => {
    setNote(null);
    // The switch moves at once; a refused save puts it back when the list reloads.
    if (typeof body["on"] === "boolean")
      setRows((r) => r?.map((x) => (x.key === key ? { ...x, on: body["on"] as boolean } : x)) ?? r);
    try {
      await api("PATCH", `/v1/venues/${venueId}/message-templates/${key}`, body);
      setEdits((e) => {
        const next = { ...e };
        delete next[key];
        return next;
      });
      await load();
      setNote({ key, text: t("texts.saved"), error: false });
    } catch (e) {
      setNote({ key, text: (e as ApiCallError)?.message ?? t("texts.failed"), error: true });
      await load().catch(() => {});
    }
  };

  const current = (draft.values["messages"] as MessageSettings | undefined) ?? settings;

  return (
    <section className="texts">
      <h2>{t("admin.section.texts")}</h2>
      {failed && (
        <p className="error" role="alert">
          {t("shell.error.cantReach")}
        </p>
      )}
      {rows === null || current === null ? (
        !failed && <p role="status">{t("shell.loading")}</p>
      ) : (
        <>
          <div className="invite-fields">
            <label>
              <span>{t("texts.reminderAt")}</span>
              <input
                type="time"
                value={current.reminderAt ?? ""}
                onChange={(e) =>
                  draft.set("messages", {
                    ...current,
                    reminderAt: e.target.value === "" ? null : e.target.value,
                  })
                }
              />
              <span className="small muted">{t("texts.reminderAt.hint")}</span>
            </label>
            <label>
              <span>{t("texts.offerExpiringMin")}</span>
              <input
                type="number"
                min={1}
                value={current.offerExpiringMin}
                onChange={(e) =>
                  draft.set("messages", {
                    ...current,
                    offerExpiringMin: Math.max(1, Number(e.target.value) || 1),
                  })
                }
              />
            </label>
          </div>
          <p className="small muted">{t("texts.notTexts")}</p>
          <ol className="module-list text-list">
            {rows.map((row) => {
              const name = t(`texts.name.${row.key}` as MessageKey);
              const locked = row.category === "marketing" && (row.locked_off ?? true);
              const editing = edits[row.key];
              return (
                <li key={row.key} className="module" aria-label={name}>
                  <div className="module-head">
                    <div>
                      <h3>
                        {row.position}. {name}
                      </h3>
                      <p className="small muted">{t(`texts.kind.${row.category}` as MessageKey)}</p>
                    </div>
                    {locked ? (
                      <span className="pill muted">{t("texts.lockedOff")}</span>
                    ) : (
                      <label className="switch-line">
                        <input
                          type="checkbox"
                          aria-label={`${name} · ${t("texts.on")}`}
                          checked={row.on}
                          onChange={(e) => void patch(row.key, { on: e.target.checked })}
                        />
                        <span>{row.on ? t("texts.on") : t("texts.off")}</span>
                      </label>
                    )}
                  </div>
                  <label>
                    <span className="small">{t("texts.wording")}</span>
                    <textarea
                      data-guest-text
                      rows={3}
                      value={editing ?? row.body}
                      onChange={(e) => setEdits((x) => ({ ...x, [row.key]: e.target.value }))}
                    />
                  </label>
                  {editing !== undefined && editing !== row.body && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void patch(row.key, { body: editing })}
                    >
                      {t("texts.save")}
                    </button>
                  )}
                  {row.example && (
                    <p className="small">
                      <span className="muted">{t("texts.example")} · </span>
                      <span data-guest-text className="text-example">
                        {row.example}
                      </span>
                    </p>
                  )}
                  {note?.key === row.key && (
                    <p className={note.error ? "small error" : "small"} role="status">
                      {note.text}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
