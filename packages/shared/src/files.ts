/**
 * What each kind of file may be (M2-13; spec 08 · Files). Storage enforces
 * these through the presigned POST's conditions, so a client can't upload a
 * bigger file, or a different type, than its kind allows.
 */
export type FileKind =
  | "damage_photo"
  | "slip_photo"
  | "paid_out_photo"
  | "lost_item_photo"
  | "license_copy"
  | "songbook"
  | "dispute_evidence"
  | "menu_pdf"
  | "receipt_pdf"
  | "site_photo";

const MB = 1024 * 1024;
const PHOTO = { types: ["image/jpeg", "image/png", "image/heic"], maxBytes: 10 * MB } as const;

export const FILE_RULES: Readonly<
  Record<FileKind, { readonly types: readonly string[]; readonly maxBytes: number }>
> = {
  damage_photo: PHOTO,
  slip_photo: PHOTO,
  paid_out_photo: PHOTO,
  lost_item_photo: PHOTO,
  license_copy: { types: ["application/pdf", "image/jpeg", "image/png"], maxBytes: 20 * MB },
  songbook: { types: ["text/csv"], maxBytes: 5 * MB },
  // Stripe's Files API takes dispute evidence as PDF, JPEG or PNG, up to 5 MB a file.
  dispute_evidence: { types: ["application/pdf", "image/jpeg", "image/png"], maxBytes: 5 * MB },
  menu_pdf: { types: ["application/pdf"], maxBytes: 20 * MB },
  receipt_pdf: { types: ["application/pdf"], maxBytes: 5 * MB },
  // Browsers show these on the guest site, so no HEIC.
  site_photo: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 10 * MB },
};

export const isFileKind = (k: string): k is FileKind => k in FILE_RULES;
