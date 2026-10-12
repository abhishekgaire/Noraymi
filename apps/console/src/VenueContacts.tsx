/**
 * The venue's own contacts on the Console's venue page (D115; spec 17 · Step details 9; O-11): the
 * first and second on-call responders our on-call calls when an incident touches the venue, with
 * the days and hours each answers (venue time), and the breach contact and backup who get our
 * breach notice with the owner. They aren't our platform rota (`oncall_rota`), which stays ours.
 */
export interface VenueContact {
  slot: "on_call_first" | "on_call_second" | "breach_primary" | "breach_backup";
  name: string;
  role: string;
  phone_e164: string | null;
  email: string | null;
  days: number[] | null;
  from: string | null;
  to: string | null;
}

const SLOT_NAMES: Record<VenueContact["slot"], string> = {
  on_call_first: "First on call",
  on_call_second: "Second on call",
  breach_primary: "Breach contact",
  breach_backup: "Breach backup",
};
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function VenueContacts({ contacts }: { contacts: VenueContact[] }) {
  return (
    <section className="venue-contacts">
      <h3>Venue contacts</h3>
      {contacts.length === 0 ? (
        <p className="muted small">Not named yet · the owner names them in Set up your venue.</p>
      ) : (
        <ul>
          {contacts.map((c) => (
            <li key={c.slot}>
              <strong>{SLOT_NAMES[c.slot]}</strong> · {c.name} ({c.role})
              {c.phone_e164 ? ` · ${c.phone_e164}` : ""}
              {c.email ? ` · ${c.email}` : ""}
              {c.days && (
                <span className="muted small">
                  {" "}
                  · {c.days.map((d) => DAY_NAMES[d]).join(", ")} {c.from}–{c.to}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
