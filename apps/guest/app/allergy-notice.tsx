/**
 * The allergy notice (K-08; spec 16 · The allergy notice): the owner's words from Admin → Kitchen,
 * never ours, shown on the room page, the room tablet and the website's menu page while Kitchen &
 * food is on. The guest web has no language switch yet, so both languages show, the Spanish
 * marked as Spanish for screen readers.
 */
export function AllergyNotice({
  notice,
  label,
}: {
  notice: { readonly en: string; readonly es: string } | null | undefined;
  label: string;
}) {
  if (!notice) return null;
  return (
    <aside className="notice allergy-notice" aria-label={label} data-allergy-notice>
      <p>{notice.en}</p>
      <p lang="es">{notice.es}</p>
    </aside>
  );
}
