import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

/**
 * Requests from Set up your venue (O-10; spec 17 · Step details 8): a menu the owner sent as a PDF
 * or a photo for our team to type in. Open the file, type the menu in (Admin → Menu under a
 * support grant, or the importer), then mark it done; the owner's step shows "typed in".
 */
interface SetupRequest {
  id: string;
  kind: "menu";
  file_id: string | null;
  note: string | null;
  state: "open" | "done";
  requested_by_name: string | null;
  requested_at: string;
  done_at: string | null;
}

const KIND_NAMES: Record<SetupRequest["kind"], string> = { menu: "Type in the menu" };

export function SetupRequests({ venue }: { venue: { id: string; name: string } }) {
  const [requests, setRequests] = useState<SetupRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/v1/console/venues/${venue.id}/setup-requests`;

  const load = useCallback(async () => {
    try {
      setRequests((await api<{ requests: SetupRequest[] }>("GET", base)).requests);
      setError(null);
    } catch {
      setError("Couldn't load the requests");
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  const openFile = async (id: string) => {
    try {
      const link = await api<{ url: string }>("GET", `${base}/${id}/file`);
      window.open(link.url, "_blank", "noopener");
    } catch {
      setError("Couldn't open the file");
    }
  };
  const done = async (id: string) => {
    setBusy(true);
    try {
      setRequests((await api<{ requests: SetupRequest[] }>("POST", `${base}/${id}/done`)).requests);
      setError(null);
    } catch {
      setError("Couldn't mark it done");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="setup-requests">
      <h3>Requests from setup</h3>
      {error && <p role="alert">{error}</p>}
      {requests === null ? (
        !error && <p role="status">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="muted small">None from {venue.name}.</p>
      ) : (
        <ul>
          {requests.map((r) => (
            <li key={r.id}>
              <span>
                {KIND_NAMES[r.kind]} · {r.requested_by_name ?? "the owner"} ·{" "}
                {new Date(r.requested_at).toLocaleString()}
                {r.state === "done" ? " · done" : ""}
              </span>
              {r.note && <span className="muted small"> · {r.note}</span>}
              {r.file_id && (
                <button type="button" className="secondary" onClick={() => void openFile(r.id)}>
                  Open the file
                </button>
              )}
              {r.state === "open" && (
                <button type="button" disabled={busy} onClick={() => void done(r.id)}>
                  Mark done
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
