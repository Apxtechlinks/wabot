import crypto from "node:crypto";

export type RateLimitOptions = { windowMs: number; max: number; prefix: string };

type Bucket = { count: number; resetAt: number };
const localBuckets = new Map<string, Bucket>();
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

export const hasSharedRateLimit = Boolean(redisUrl && redisToken);

async function redisCommand(command: string[]) {
  if (!redisUrl || !redisToken) return null;
  const response = await fetch(redisUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Rate-limit store error: ${response.status}`);
  return await response.json() as { result?: unknown };
}

function localConsume(key: string, windowMs: number, max: number) {
  const now = Date.now();
  let bucket = localBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    localBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return { count: bucket.count, resetAt: bucket.resetAt };
}

export async function consumeRateLimit(key: string, { windowMs, max, prefix }: RateLimitOptions) {
  if (hasSharedRateLimit) {
    try {
      const redisKey = `rl:${prefix}:${key}`;
      const result = await redisCommand(["INCR", redisKey]);
      const count = Number(result?.result ?? 0);
      if (count === 1) await redisCommand(["PEXPIRE", redisKey, String(windowMs)]);
      const ttl = await redisCommand(["PTTL", redisKey]);
      return { count, resetAt: Date.now() + Math.max(0, Number(ttl?.result ?? windowMs)), shared: true };
    } catch {
      // Fail open to local protection if the optional shared store is temporarily unavailable.
    }
  }
  const result = localConsume(`${prefix}:${key}`, windowMs, max);
  return { ...result, shared: false };
}

export function cleanupLocalRateLimitBuckets() {
  const now = Date.now();
  for (const [key, bucket] of localBuckets) if (bucket.resetAt <= now) localBuckets.delete(key);
}

export function requestFingerprint(ip: string, userAgent = "") {
  return crypto.createHash("sha256").update(`${ip}|${userAgent}`).digest("hex").slice(0, 32);
}

export function safeString(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export function validUuid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function validUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || (process.env.NODE_ENV !== "production" && u.protocol === "http:");
  } catch { return false; }
}
