import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api.js";
import { useT } from "../i18n.js";
import { uploadPhoto } from "../upload.js";

/**
 * The damage fee (M2-21; spec 10 · Damage fee): $150.00 on the room tab, only
 * with a photo (camera or upload) and a reason. The line shows the photo's
 * thumbnail; nothing says "photo attached" without a photo.
 */
interface Line {
  readonly id: number;
  readonly kind: string;
  readonly amount_cents: number;
  readonly reason: string | null;
  readonly file_id: string | null;
}
interface View {
  readonly tab_so_far_cents: number;
  readonly lines: readonly Line[];
}

function Thumb({ venueId, fileId, alt }: { venueId: string; fileId: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api<{ url: string }>("GET", `/v1/venues/${venueId}/files/${fileId}`)
      .then((r) => live && setUrl(r.url))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [venueId, fileId]);
  return url ? <img className="thumb" src={url} alt={alt} width={48} height={48} /> : null;
}

export function DamageSheet({
  venueId,
  checkId,
  roomName,
  onClose,
}: {
  venueId: string;
  checkId: string;
  roomName: string;
  onClose: () => void;
}) {
  const { t, money } = useT();
  const [photo, setPhoto] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [done, setDone] = useState<View | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!photo || !reason.trim()) return;
    setBusy(true);
    setError(false);
    try {
      const fileId = await uploadPhoto(venueId, "damage_photo", photo);
      setDone(
        await api<View>("POST", `/v1/venues/${venueId}/checks/${checkId}/lines`, {
          kind: "damage",
          file_id: fileId,
          reason: reason.trim(),
        }),
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const title = t("damage.title", { room: roomName });
  if (done) {
    const damage = done.lines.filter((l) => l.kind === "damage");
    return (
      <div className="sheet" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <ul className="lost-items">
          {damage.map((l) => (
            <li
              key={l.id}
              aria-label={t("damage.line", { amount: money(l.amount_cents as never) })}
            >
              {l.file_id && <Thumb venueId={venueId} fileId={l.file_id} alt={l.reason ?? ""} />}
              <div>
                <div>{t("damage.line", { amount: money(l.amount_cents as never) })}</div>
                {l.reason && <div className="small muted">{l.reason}</div>}
              </div>
            </li>
          ))}
        </ul>
        <p role="status">
          {t("damage.tabSoFar", { amount: money(done.tab_so_far_cents as never) })}
        </p>
        <div className="actions">
          <button type="button" className="primary" onClick={onClose}>
            {t("damage.close")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <form className="sheet" role="dialog" aria-label={title} onSubmit={(e) => void submit(e)}>
      <h2>{title}</h2>
      <label>
        {t("damage.photo")}
        <input
          type="file"
          accept="image/jpeg,image/png,image/heic"
          capture="environment"
          required
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
        />
      </label>
      <label>
        {t("damage.reason")}
        <input
          value={reason}
          maxLength={500}
          required
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {t("damage.failed")}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || !photo || !reason.trim()}>
          {t("damage.add")}
        </button>
        <button type="button" onClick={onClose}>
          {t("checkIn.cancel")}
        </button>
      </div>
    </form>
  );
}
