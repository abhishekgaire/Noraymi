import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { api } from "../api.js";

/**
 * "Save and publish" (screens.md · AdminDesk): a section changes settings
 * keys in a draft; nothing reaches the website or the room screens until the
 * owner or manager presses Save, which writes every changed key in one
 * transaction (`PUT /settings` is all or nothing). Team doesn't use the draft:
 * people, roles and languages change at once, each behind the passkey.
 */
export interface AdminDraft {
  readonly values: Readonly<Record<string, unknown>>;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly status: "idle" | "published" | "failed";
  /** Grows by one after each publish, so a section refetches what it shows. */
  readonly version: number;
  readonly set: (key: string, value: unknown) => void;
  readonly discard: () => void;
  readonly save: () => Promise<void>;
}

const DraftContext = createContext<AdminDraft | null>(null);

export function AdminDraftProvider({
  venueId,
  children,
}: {
  venueId: string;
  children: ReactNode;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<AdminDraft["status"]>("idle");
  const [version, setVersion] = useState(0);

  const set = useCallback((key: string, value: unknown) => {
    setStatus("idle");
    setValues((v) => ({ ...v, [key]: value }));
  }, []);
  const discard = useCallback(() => {
    setValues({});
    setStatus("idle");
  }, []);
  const save = useCallback(async () => {
    setSaving(true);
    try {
      await api("PUT", `/v1/venues/${venueId}/settings`, { values });
      setValues({});
      setStatus("published");
      setVersion((n) => n + 1);
    } catch {
      setStatus("failed");
    } finally {
      setSaving(false);
    }
  }, [venueId, values]);

  const draft = useMemo<AdminDraft>(
    () => ({
      values,
      dirty: Object.keys(values).length > 0,
      saving,
      status,
      version,
      set,
      discard,
      save,
    }),
    [values, saving, status, version, set, discard, save],
  );
  return <DraftContext.Provider value={draft}>{children}</DraftContext.Provider>;
}

export function useAdminDraft(): AdminDraft {
  const draft = useContext(DraftContext);
  if (!draft) throw new Error("useAdminDraft outside Admin");
  return draft;
}
