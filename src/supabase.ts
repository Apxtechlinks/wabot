import "dotenv/config";

const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseEnabled = Boolean(url && key);

async function request<T>(path: string, options: RequestInit = {}): Promise<T | null> {
  if (!supabaseEnabled) return null;
  const timeoutMs = Math.max(2000, Number(process.env.SUPABASE_TIMEOUT_MS || 10000));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs).unref();
    try {
      const response = await fetch(`${url}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          apikey: key!,
          Authorization: `Bearer ${key!}`,
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
      if (!response.ok) {
        const body = await response.text();
        if (response.status >= 500 && attempt < 2) { await new Promise(r => setTimeout(r, 250 * 2 ** attempt)); continue; }
        throw new Error(`Supabase ${response.status}: ${body}`);
      }
      if (response.status === 204) return null;
      const contentType = response.headers.get("content-type") || "";
      const raw = await response.text();
      if (!raw.trim()) return null;
      return contentType.includes("application/json") ? JSON.parse(raw) as T : null;
    } catch (error) {
      lastError = error;
      if (attempt < 2) { await new Promise(r => setTimeout(r, 250 * 2 ** attempt)); continue; }
    } finally { clearTimeout(timer); }
  }
  throw lastError instanceof Error ? lastError : new Error("Supabase request failed.");
}

export async function upsert(table: string, row: Record<string, unknown>, conflictColumn = "id") {
  if (!supabaseEnabled) return;
  await request(`/rest/v1/${table}?on_conflict=${encodeURIComponent(conflictColumn)}`, {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
}

export async function remove(table: string, id: string) {
  if (!supabaseEnabled) return;
  await request(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

export async function list<T>(table: string, query = "select=*") {
  return (await request<T[]>(`/rest/v1/${table}?${query}`)) || [];
}

export async function uploadStorage(
  bucket: string,
  pathName: string,
  bytes: Uint8Array,
  contentType: string
) {
  if (!supabaseEnabled) {
    throw new Error("Supabase is not configured.");
  }

  const normalizedBucket = bucket.trim();
  const normalizedPath = pathName.split("/").map(encodeURIComponent).join("/");
  if (!normalizedBucket) throw new Error("Storage bucket name is empty.");
  if (!normalizedPath) throw new Error("Storage object path is empty.");

  const response = await fetch(
    `${url}/storage/v1/object/${encodeURIComponent(normalizedBucket)}/${normalizedPath}`,
    {
      method: "POST",
      headers: {
        apikey: key!,
        Authorization: `Bearer ${key!}`,
        "Content-Type": contentType,
        "Cache-Control": "31536000",
        "x-upsert": "true",
      },
      body: bytes as BodyInit,
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase Storage ${response.status}: ${detail || "upload rejected"}`);
  }

  // This URL is only returned after Supabase confirms the object exists.
  return `${url}/storage/v1/object/public/${encodeURIComponent(normalizedBucket)}/${normalizedPath}`;
}

export function isSupabaseConfigured() {
  return supabaseEnabled;
}


export async function getSupabaseUser(accessToken: string) {
  if (!supabaseEnabled || !url || !key) return null;
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY || key, Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) return null;
  return await response.json() as { id:string; email?:string; user_metadata?:Record<string,unknown> };
}

export async function supabaseSelectOne<T>(table: string, query: string) {
  const rows = await list<T>(table, `${query}&limit=1`);
  return rows[0] || null;
}
