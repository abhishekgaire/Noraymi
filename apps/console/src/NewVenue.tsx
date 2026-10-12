import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api.js";

/**
 * New venue and the owner's invite (O-01; spec 17 · Who runs it). Our staff
 * member types the venue's name, its short web name, a new organization's
 * legal name or picks one already there (a second venue of the same owner,
 * which shares its Stripe account), the owner's name and email, and why.
 * Nothing else: the owner enters the venue's facts in Set up your venue.
 * Internal tool: English only, like the rest of the Console.
 */
interface Organization {
  id: string;
  legal_name: string;
  stripe_account_id: string | null;
  venues: number;
}

export interface OwnerLine {
  status: "invited" | "active" | "deactivated";
  name: string;
  email: string | null;
  invite_expires_at: string | null;
}

/** The venue list's owner line: "Owner invited · not yet signed in" until the invite is finished. */
export function ownerLine(owner: OwnerLine | null | undefined): string | null {
  if (!owner) return null;
  if (owner.status === "active") return `Owner ${owner.name} · signed in`;
  if (owner.status === "deactivated") return `Owner ${owner.name} · deactivated`;
  return owner.invite_expires_at
    ? "Owner invited · not yet signed in"
    : "Owner not invited yet · send the owner's invite";
}

export function NewVenue({ onMade }: { onMade: (venueId: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [orgId, setOrgId] = useState("");
  const [legalName, setLegalName] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!open || orgs !== null) return;
    api<{ organizations: Organization[] }>("GET", "/v1/console/organizations")
      .then((r) => setOrgs(r.organizations))
      .catch((e: Error) => setMessage({ kind: "error", text: e.message }));
  }, [open, orgs]);

  const picked = orgs?.find((o) => o.id === orgId) ?? null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ venue: { id: string; name: string } }>("POST", "/v1/console/venues", {
        name,
        slug,
        ...(orgId ? { org_id: orgId } : { legal_name: legalName }),
        owner_name: ownerName,
        owner_email: ownerEmail,
        reason,
      });
      setMessage({
        kind: "ok",
        text: `${r.venue.name} made · send the owner's invite from the venue`,
      });
      setName("");
      setSlug("");
      setOwnerName("");
      setOwnerEmail("");
      setReason("");
      setLegalName("");
      setOrgId("");
      setOrgs(null);
      setOpen(false);
      await onMade(r.venue.id);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Refused" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="new-venue" aria-labelledby="new-venue-title">
      {!open ? (
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          New venue
        </button>
      ) : (
        <form className="grant-form" onSubmit={(e) => void submit(e)}>
          <h3 id="new-venue-title">New venue</h3>
          <p className="muted small">
            Makes the venue and invites its owner, nothing else. The owner enters the hours, rooms,
            prices and contacts in Set up your venue.
          </p>
          <label>
            <span>Venue name (what guests see)</span>
            <input value={name} required maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>Web name (lower-case letters, digits and dashes)</span>
            <input
              value={slug}
              required
              pattern="[a-z0-9][a-z0-9\-]{0,38}[a-z0-9]"
              maxLength={40}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
            />
          </label>
          <label>
            <span>Organization</span>
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              <option value="">A new organization</option>
              {(orgs ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.legal_name} · {o.venues} {o.venues === 1 ? "venue" : "venues"}
                </option>
              ))}
            </select>
          </label>
          {orgs === null && <p className="muted small">Loading organizations…</p>}
          {picked ? (
            <p className="muted small">
              {picked.stripe_account_id
                ? "Shares this organization's Stripe account"
                : "This organization has no Stripe account yet"}
            </p>
          ) : (
            <label>
              <span>Legal name</span>
              <input
                value={legalName}
                required
                maxLength={160}
                onChange={(e) => setLegalName(e.target.value)}
              />
            </label>
          )}
          <label>
            <span>Owner's name</span>
            <input
              value={ownerName}
              required
              maxLength={80}
              onChange={(e) => setOwnerName(e.target.value)}
            />
          </label>
          <label>
            <span>Owner's email</span>
            <input
              type="email"
              value={ownerEmail}
              required
              maxLength={254}
              onChange={(e) => setOwnerEmail(e.target.value)}
            />
          </label>
          <label>
            <span>Why (kept with the venue)</span>
            <input
              value={reason}
              required
              minLength={3}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Making…" : "Make the venue"}
            </button>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {message && (
        <p className={message.kind === "error" ? "error" : "ok"} role="status">
          {message.text}
        </p>
      )}
    </section>
  );
}

/** "Send the owner's invite", then "Send again", which ends the old link. */
export function OwnerInvite({
  venueId,
  owner,
  onSent,
}: {
  venueId: string;
  owner: OwnerLine | null | undefined;
  onSent: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  if (!owner || owner.status !== "invited") return null;
  const send = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ sent_to: string; expires_at: string }>(
        "POST",
        `/v1/console/venues/${venueId}/owner-invite`,
        {},
      );
      setMessage({
        kind: "ok",
        text: `Sent to ${r.sent_to} · the link works for 7 days`,
      });
      await onSent();
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : "Refused" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="owner-invite">
      <h3>Owner</h3>
      <p className="muted small">
        {owner.name}
        {owner.email ? ` · ${owner.email}` : ""} · {ownerLine(owner)}
      </p>
      <button type="button" disabled={busy} onClick={() => void send()}>
        {owner.invite_expires_at ? "Send again" : "Send the owner's invite"}
      </button>
      {owner.invite_expires_at && (
        <p className="muted small">Send again makes a new link and ends the old one.</p>
      )}
      {message && (
        <p className={message.kind === "error" ? "error" : "ok"} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
