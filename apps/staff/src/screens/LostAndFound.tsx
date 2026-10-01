import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { uploadPhoto } from "../upload.js";

/**
 * N15 Lost and found (M2-19): "Found in Room 9 · kept at the bar · claimed by
 * …", with a photo where staff take one. Something found at the bar has no
 * room.
 */
interface Item {
  readonly id: string;
  readonly room_name: string | null;
  readonly description: string;
  readonly photo_file_id: string | null;
  readonly kept_at: string;
  readonly claimed_by_name: string | null;
}

function Photo({ venueId, fileId, alt }: { venueId: string; fileId: string; alt: string }) {
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

export function LostAndFound({
  venueId,
  rooms,
}: {
  venueId: string;
  rooms: readonly { room_id: string; name: string }[];
}) {
  const { t } = useT();
  const { subscribe } = useEvents();
  const [items, setItems] = useState<readonly Item[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [description, setDescription] = useState("");
  const [roomId, setRoomId] = useState("");
  const [keptAt, setKeptAt] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [claimName, setClaimName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(
        (await api<{ items: Item[] }>("GET", `/v1/venues/${venueId}/lost-items?all=1`)).items,
      );
    } catch {
      setError(t("lost.failed"));
    }
  }, [venueId, t]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "lost_item.updated")) void load();
      }),
    [subscribe, load],
  );

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const photoId = photo ? await uploadPhoto(venueId, "lost_item_photo", photo) : null;
      await api("POST", `/v1/venues/${venueId}/lost-items`, {
        description: description.trim(),
        kept_at: keptAt.trim(),
        room_id: roomId || null,
        ...(photoId ? { photo_file_id: photoId } : {}),
      });
      setAdding(false);
      setDescription("");
      setKeptAt("");
      setRoomId("");
      setPhoto(null);
      await load();
    } catch {
      setError(t("lost.failed"));
    }
  };

  const claim = async (e: FormEvent, id: string) => {
    e.preventDefault();
    try {
      await api("PATCH", `/v1/venues/${venueId}/lost-items/${id}`, {
        claimed_by_name: claimName.trim(),
      });
      setClaiming(null);
      setClaimName("");
      await load();
    } catch {
      setError(t("lost.failed"));
    }
  };

  const where = (i: Item) =>
    i.room_name
      ? t("lost.foundIn", { room: i.room_name, kept: i.kept_at })
      : t("lost.foundAtBar", { kept: i.kept_at });

  return (
    <section aria-labelledby="lost-title">
      <h2 id="lost-title">{t("lost.title")}</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {items === null && !error && <p role="status">{t("shell.loading")}</p>}
      {items?.length === 0 && <p className="empty">{t("lost.none")}</p>}
      <ul className="lost-items">
        {items?.map((i) => (
          <li key={i.id} aria-label={i.description}>
            {i.photo_file_id && (
              <Photo venueId={venueId} fileId={i.photo_file_id} alt={i.description} />
            )}
            <div>
              <div>{i.description}</div>
              <div className="small">
                {i.claimed_by_name
                  ? `${where(i)} · ${t("lost.claimedBy", { name: i.claimed_by_name })}`
                  : where(i)}
              </div>
              {!i.claimed_by_name &&
                (claiming === i.id ? (
                  <form className="actions" onSubmit={(e) => void claim(e, i.id)}>
                    <label>
                      {t("lost.claimName")}
                      <input
                        value={claimName}
                        onChange={(e) => setClaimName(e.target.value)}
                        required
                      />
                    </label>
                    <button type="submit" className="primary" disabled={!claimName.trim()}>
                      {t("lost.handOver")}
                    </button>
                  </form>
                ) : (
                  <button type="button" className="link" onClick={() => setClaiming(i.id)}>
                    {t("lost.claim")}
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ul>
      {adding ? (
        <form className="sheet" aria-label={t("lost.add")} onSubmit={(e) => void add(e)}>
          <label>
            {t("lost.what")}
            <input
              value={description}
              maxLength={300}
              onChange={(e) => setDescription(e.target.value)}
              required
            />
          </label>
          <label>
            {t("lost.where")}
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">{t("lost.atBar")}</option>
              {rooms.map((r) => (
                <option key={r.room_id} value={r.room_id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("lost.keptAt")}
            <input
              value={keptAt}
              maxLength={100}
              onChange={(e) => setKeptAt(e.target.value)}
              required
            />
          </label>
          <label>
            {t("lost.photo")}
            <input
              type="file"
              accept="image/jpeg,image/png,image/heic"
              capture="environment"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={!description.trim() || !keptAt.trim()}
            >
              {t("lost.log")}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              {t("checkIn.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="secondary" onClick={() => setAdding(true)}>
          {t("lost.add")}
        </button>
      )}
    </section>
  );
}
