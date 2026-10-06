import { api } from "./api.js";

/**
 * A photo straight to storage (M2-13's presigned POST): the API fixes the
 * kind's type and size, the browser sends the bytes to storage, and the row
 * that needs the file attaches it by id. The bytes never pass through the API.
 */
export async function uploadPhoto(
  venueId: string,
  kind: "lost_item_photo" | "damage_photo" | "site_photo" | "slip_photo" | "paid_out_photo",
  file: File,
): Promise<string> {
  const presigned = await api<{
    file_id: string;
    upload: { url: string; fields: Record<string, string> };
  }>("POST", `/v1/venues/${venueId}/files`, {
    kind,
    content_type: file.type,
    bytes: file.size,
  });
  const form = new FormData();
  for (const [k, v] of Object.entries(presigned.upload.fields)) form.append(k, v);
  form.append("file", file);
  const sent = await fetch(presigned.upload.url, { method: "POST", body: form });
  if (!sent.ok) throw new Error(`upload failed: ${sent.status}`);
  return presigned.file_id;
}
