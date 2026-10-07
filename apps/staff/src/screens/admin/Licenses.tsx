import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { MessageKey } from "@west4/shared";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { uploadPhoto } from "../../upload.js";
import { dollarsToCents } from "./Prices.js";

/**
 * Admin → Licenses (M8-09; screens N35, AdminDesk note 20): the license
 * register. Each license with its number, holder, issuing agency, dates, fee,
 * conditions and a copy (PDF, JPEG or PNG up to 20 MB). Nothing is filled in
 * for the venue: an empty field says "Not entered", and the music and liquor
 * licenses not on file yet are named so the owner can add them from the paper
 * license. Every owner and manager is reminded 60, 30 and 7 days before an
 * expiry, by email and push.
 */
export const LICENSE_KINDS = [
  "liquor",
  "ascap",
  "bmi",
  "sesac",
  "gmr",
  "local",
  "health",
  "other",
] as const;
type Kind = (typeof LICENSE_KINDS)[number];
/** The music and liquor licenses the blueprint names; any missing is listed as not on file yet. */
const EXPECTED: readonly Kind[] = ["ascap", "bmi", "sesac", "gmr", "liquor"];
const COPY_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const COPY_MAX = 20 * 1024 * 1024;

export interface License {
  readonly id: string;
  readonly kind: Kind;
  readonly number: string | null;
  readonly holder: string | null;
  readonly authority: string | null;
  readonly starts_on: string | null;
  readonly expires_on: string | null;
  readonly fee_cents: number | null;
  readonly conditions: string | null;
  readonly file_id: string | null;
  readonly reminded_days: number | null;
  readonly days_left: number | null;
}

interface Draft {
  readonly id: string | null;
  readonly kind: Kind;
  readonly number: string;
  readonly holder: string;
  readonly authority: string;
  readonly starts_on: string;
  readonly expires_on: string;
  readonly fee: string;
  readonly conditions: string;
}

const kindKey = (k: Kind) => `licenses.kind.${k}` as MessageKey;
const centsText = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

function draftOf(l: License | null, kind: Kind = "ascap"): Draft {
  return {
    id: l?.id ?? null,
    kind: l?.kind ?? kind,
    number: l?.number ?? "",
    holder: l?.holder ?? "",
    authority: l?.authority ?? "",
    starts_on: l?.starts_on ?? "",
    expires_on: l?.expires_on ?? "",
    fee: l?.fee_cents == null ? "" : centsText(l.fee_cents),
    conditions: l?.conditions ?? "",
  };
}

export function Licenses() {
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const { t, tn, money, date } = useT();
  const [list, setList] = useState<readonly License[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [copy, setCopy] = useState<File | null>(null);
  const [problem, setProblem] = useState<"save" | "file" | "fee" | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!venueId) return;
    try {
      setList(
        (await api<{ licenses: License[] }>("GET", `/v1/venues/${venueId}/licenses`)).licenses,
      );
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (d: Draft) => {
    setDraft(d);
    setCopy(null);
    setProblem(null);
  };

  const viewCopy = async (fileId: string) => {
    try {
      const link = await api<{ url: string }>("GET", `/v1/venues/${venueId}/files/${fileId}`);
      window.open(link.url, "_blank", "noopener");
    } catch {
      setFailed(true);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const fee = draft.fee.trim() === "" ? null : dollarsToCents(draft.fee);
    if (draft.fee.trim() !== "" && fee === null) {
      setProblem("fee");
      return;
    }
    if (copy && (!COPY_TYPES.includes(copy.type) || copy.size > COPY_MAX)) {
      setProblem("file");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      let fileId: string | undefined;
      if (copy) {
        try {
          fileId = await uploadPhoto(venueId, "license_copy", copy);
        } catch {
          setProblem("file");
          return;
        }
      }
      const blank = (v: string) => (v.trim() === "" ? null : v.trim());
      const body = {
        number: blank(draft.number),
        holder: blank(draft.holder),
        authority: blank(draft.authority),
        starts_on: blank(draft.starts_on),
        expires_on: blank(draft.expires_on),
        fee_cents: fee,
        conditions: blank(draft.conditions),
        ...(fileId ? { file_id: fileId } : {}),
      };
      if (draft.id) await api("PATCH", `/v1/venues/${venueId}/licenses/${draft.id}`, body);
      else await api("POST", `/v1/venues/${venueId}/licenses`, { kind: draft.kind, ...body });
      setDraft(null);
      await load();
    } catch {
      setProblem("save");
    } finally {
      setBusy(false);
    }
  };

  const missing = list ? EXPECTED.filter((k) => !list.some((l) => l.kind === k)) : [];
  const expiry = (l: License) =>
    l.expires_on === null || l.days_left === null
      ? t("licenses.noExpiry")
      : l.days_left < 0
        ? t("licenses.expired", { date: date(l.expires_on) })
        : l.days_left === 0
          ? t("licenses.expiresToday", { date: date(l.expires_on) })
          : tn("licenses.expiresIn", l.days_left, { date: date(l.expires_on) });
  const or = (v: string | null) => v ?? t("licenses.notEntered");

  return (
    <section className="licenses" aria-labelledby="licenses-h">
      <h2 id="licenses-h">{t("licenses.title")}</h2>
      <p className="small">{t("licenses.intro")}</p>
      {failed && (
        <p className="error" role="alert">
          {t("licenses.failed")}
        </p>
      )}
      {list === null && !failed && <p role="status">{t("shell.loading")}</p>}
      {list !== null && missing.length > 0 && (
        <p className="hint" data-testid="licenses-missing">
          {t("licenses.missing", { kinds: missing.map((k) => t(kindKey(k))).join(", ") })}
        </p>
      )}
      {list?.length === 0 && <p>{t("licenses.none")}</p>}
      {list !== null && list.length > 0 && (
        <ul className="license-list">
          {list.map((l) => (
            <li key={l.id} aria-label={t(kindKey(l.kind))}>
              <h3>{t(kindKey(l.kind))}</h3>
              <dl>
                <dt>{t("licenses.number")}</dt>
                <dd>{or(l.number)}</dd>
                <dt>{t("licenses.holder")}</dt>
                <dd>{or(l.holder)}</dd>
                <dt>{t("licenses.authority")}</dt>
                <dd>{or(l.authority)}</dd>
                <dt>{t("licenses.startsOn")}</dt>
                <dd>{l.starts_on ? date(l.starts_on) : t("licenses.notEntered")}</dd>
                <dt>{t("licenses.expiresOn")}</dt>
                <dd className={l.days_left !== null && l.days_left <= 30 ? "warn" : undefined}>
                  {expiry(l)}
                  {l.reminded_days !== null && (
                    <span className="small">
                      {" "}
                      · {t("licenses.reminded", { days: l.reminded_days })}
                    </span>
                  )}
                </dd>
                <dt>{t("licenses.fee")}</dt>
                <dd>
                  {l.fee_cents === null ? t("licenses.notEntered") : money(l.fee_cents as never)}
                </dd>
                <dt>{t("licenses.conditions")}</dt>
                <dd>{or(l.conditions)}</dd>
              </dl>
              <div className="license-actions">
                {l.file_id ? (
                  <button type="button" onClick={() => void viewCopy(l.file_id!)}>
                    {t("licenses.viewCopy")}
                  </button>
                ) : (
                  <span className="small">{t("licenses.noCopy")}</span>
                )}
                <button type="button" onClick={() => open(draftOf(l))}>
                  {t("licenses.edit")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {list !== null && draft === null && (
        <button type="button" className="primary" onClick={() => open(draftOf(null, missing[0]))}>
          {t("licenses.add")}
        </button>
      )}
      {draft && (
        <form className="license-form" onSubmit={(e) => void save(e)}>
          <h3>{draft.id ? t(kindKey(draft.kind)) : t("licenses.add")}</h3>
          {!draft.id && (
            <label>
              <span>{t("licenses.kind")}</span>
              <select
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}
              >
                {LICENSE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(kindKey(k))}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(["number", "holder", "authority"] as const).map((field) => (
            <label key={field}>
              <span>{t(`licenses.${field}`)}</span>
              <input
                value={draft[field]}
                maxLength={field === "number" ? 100 : 200}
                onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
              />
            </label>
          ))}
          <label>
            <span>{t("licenses.startsOn")}</span>
            <input
              type="date"
              value={draft.starts_on}
              onChange={(e) => setDraft({ ...draft, starts_on: e.target.value })}
            />
          </label>
          <label>
            <span>{t("licenses.expiresOn")}</span>
            <input
              type="date"
              value={draft.expires_on}
              onChange={(e) => setDraft({ ...draft, expires_on: e.target.value })}
            />
          </label>
          <label>
            <span>{t("licenses.fee")}</span>
            <input
              inputMode="decimal"
              value={draft.fee}
              aria-invalid={problem === "fee"}
              onChange={(e) => setDraft({ ...draft, fee: e.target.value })}
            />
          </label>
          <label>
            <span>{t("licenses.conditions")}</span>
            <textarea
              value={draft.conditions}
              maxLength={2000}
              onChange={(e) => setDraft({ ...draft, conditions: e.target.value })}
            />
          </label>
          <label>
            <span>{t("licenses.copy")}</span>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              onChange={(e) => {
                setCopy(e.target.files?.[0] ?? null);
                setProblem(null);
              }}
            />
          </label>
          {problem && (
            <p className="error" role="alert">
              {t(
                problem === "file"
                  ? "licenses.fileRefused"
                  : problem === "fee"
                    ? "licenses.feeInvalid"
                    : "licenses.saveFailed",
              )}
            </p>
          )}
          <div className="license-actions">
            <button type="submit" className="primary" disabled={busy}>
              {t("licenses.save")}
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              {t("licenses.cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
