// ── Google Drive: ТЗ в Google Docs ────────────────────────────────────────────
// отдельный OAuth-клиент Google Cloud (GOOGLE_DRIVE_CLIENT_ID/SECRET; там включён Drive API) + refresh-токен со scope drive.file
// (GOOGLE_DRIVE_REFRESH_TOKEN, получить: `node scripts/google-oauth.mjs --drive`). drive.file видит только файлы,
// созданные этим приложением — этого хватает: папка «Creative System · ТЗ», документы с appProperties для переиспользования.

const FOLDER_NAME = "Creative System · ТЗ";
const DOC_MIME = "application/vnd.google-apps.document";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const CLIENT_ID = () => process.env.GOOGLE_DRIVE_CLIENT_ID ?? process.env.GOOGLE_ADS_CLIENT_ID ?? "";
const CLIENT_SECRET = () => process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? process.env.GOOGLE_ADS_CLIENT_SECRET ?? "";
export function isDriveConfigured(): boolean {
  return !!(process.env.GOOGLE_DRIVE_REFRESH_TOKEN && CLIENT_ID() && CLIENT_SECRET());
}

let cached: { token: string; exp: number } | null = null;
async function accessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(),
      refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN ?? "", grant_type: "refresh_token",
    }).toString(),
  });
  const j = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(`Google OAuth: ${j.error ?? res.status}${j.error_description ? ` — ${j.error_description}` : ""} (перевыпусти токен: node scripts/google-oauth.mjs --drive)`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const tok = await accessToken();
  const res = await fetch(`https://www.googleapis.com${path}`, { ...init, headers: { Authorization: `Bearer ${tok}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Drive ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

let folderCache: string | null = null;
async function ensureFolder(): Promise<string> {
  if (folderCache) return folderCache;
  const q = encodeURIComponent(`name = '${FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const found = await api<{ files?: { id: string }[] }>(`/drive/v3/files?q=${q}&fields=files(id)&pageSize=1`);
  if (found.files?.[0]?.id) { folderCache = found.files[0].id; return folderCache; }
  const created = await api<{ id: string }>(`/drive/v3/files?fields=id`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  folderCache = created.id;
  return created.id;
}

function multipart(meta: Record<string, unknown>, buffer: Buffer): { body: Buffer; contentType: string } {
  const boundary = `cs_${Date.now().toString(36)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${DOCX_MIME}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--`);
  return { body: Buffer.concat([head, buffer, tail]), contentType: `multipart/related; boundary=${boundary}` };
}

/**
 * Загружает DOCX как Google Doc. Документ с тем же ключом (appProperties.key) ОБНОВЛЯЕТСЯ, а не создаётся заново —
 * ссылка стабильная. Доступ: любой по ссылке может редактировать (ТЗ уходит креаторам).
 */
export async function uploadDocxAsGoogleDoc(buffer: Buffer, name: string, key: string): Promise<{ id: string; url: string; created: boolean }> {
  const folderId = await ensureFolder();
  const q = encodeURIComponent(`appProperties has { key='key' and value='${key.replace(/'/g, "\\'")}' } and trashed = false`);
  const found = await api<{ files?: { id: string; webViewLink?: string }[] }>(`/drive/v3/files?q=${q}&fields=files(id,webViewLink)&pageSize=1`);
  const title = name.replace(/\.docx$/i, "");
  if (found.files?.[0]?.id) {
    const id = found.files[0].id;
    const { body, contentType } = multipart({ name: title, mimeType: DOC_MIME }, buffer);
    const upd = await api<{ id: string; webViewLink?: string }>(`/upload/drive/v3/files/${id}?uploadType=multipart&fields=id,webViewLink`, {
      method: "PATCH", headers: { "Content-Type": contentType }, body: new Uint8Array(body),
    });
    return { id, url: upd.webViewLink ?? `https://docs.google.com/document/d/${id}/edit`, created: false };
  }
  const { body, contentType } = multipart({ name: title, mimeType: DOC_MIME, parents: [folderId], appProperties: { key } }, buffer);
  const created = await api<{ id: string; webViewLink?: string }>(`/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink`, {
    method: "POST", headers: { "Content-Type": contentType }, body: new Uint8Array(body),
  });
  await api(`/drive/v3/permissions?fields=id`.replace("/permissions", `/files/${created.id}/permissions`), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "writer", type: "anyone" }),
  }).catch(() => { /* если домен запрещает anyone-доступ — документ останется приватным, ссылка всё равно вернётся */ });
  return { id: created.id, url: created.webViewLink ?? `https://docs.google.com/document/d/${created.id}/edit`, created: true };
}
