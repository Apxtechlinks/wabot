import "dotenv/config";

import express from "express";

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import {
  addLog,
  createAccount,
  getAccount,
  getAccounts,
  getLogs,
  updateAccount,
  getKnowledge,
  createKnowledgeItem,
  updateKnowledgeItem,
  deleteKnowledgeItem,
  getConversationMessages,
  getContactAiEnabled,
  setContactAiEnabled,
  isHumanTakeover,
  setHumanTakeover,
  getContacts,
  addConversationMessage,
  syncExistingStateToSupabase,
  hydrateStateFromSupabase,
  getBusinessProfile,
  updateBusinessProfile,
  updateContactCRM,
  getOrders,
  getOrdersForAnyAccount,
  getKnowledgeForAnyAccount,
  createOrder,
  updateOrder,
  getCartByToken,
  createOrdersFromCart,
  buildCheckoutSummary,
  validateCart,
  getCustomer,
  updateCustomer,
  createCheckoutTokenForCart,
  cartTotal,
} from "./state.js";

import {
  connectAccount,
  disconnectAccount,
  requestPairingCode,
  sendCheckoutConfirmation,
} from "./whatsapp.js";

import { isSupabaseConfigured, getSupabaseUser, supabaseSelectOne, list as supabaseList, upsert as supabaseUpsert, uploadStorage } from "./supabase.js";
import { consumeRateLimit, cleanupLocalRateLimitBuckets, requestFingerprint, safeString, validUrl } from "./production.js";

/* =========================================================
   SERVER
========================================================= */

const app = express();

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";
const requireSupabase = (process.env.REQUIRE_SUPABASE ?? (isProduction ? "true" : "false")).toLowerCase() === "true";

const port =
  Number(
    process.env.PORT || 3000
  );

const publicDirectory = path.resolve("./public");

function assertProductionConfig() {
  const missing: string[] = [];
  if (!process.env.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  if (requireSupabase) {
    if (!process.env.SUPABASE_URL) missing.push("SUPABASE_URL");
    if (!process.env.SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  if (isProduction) {
    const baseUrl = (process.env.PUBLIC_BASE_URL || "").trim();
    if (!baseUrl) missing.push("PUBLIC_BASE_URL");
    else if (!/^https:\/\//i.test(baseUrl)) missing.push("PUBLIC_BASE_URL (must be HTTPS in production)");
  }
  if (missing.length) throw new Error(`Missing/invalid production configuration: ${missing.join(", ")}`);
}

assertProductionConfig();

/* =========================================================
   MIDDLEWARE
========================================================= */

app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "1");

app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/checkout/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  const requestId = crypto.randomUUID();
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' https: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self';");
  if (isProduction) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  (req as express.Request & { requestId?: string }).requestId = requestId;
  next();
});

app.use(express.json({ limit: "1mb", strict: true }));
app.use("/api/accounts", express.raw({ type: (req) => /^multipart\/form-data(?:;|$)/i.test(req.headers["content-type"] || ""), limit: "6mb" }));

app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const error = err as any;

  if (error?.type === "entity.too.large" || error?.status === 413) {
    return res.status(413).json({
      error: "Image is too large. Maximum upload size is 5MB.",
    });
  }

  if (err instanceof SyntaxError && "body" in (err as object)) {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  next(err);
});

app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  const contentLength = Number(req.headers["content-length"] || 0);
  const hasBody = Number.isFinite(contentLength) ? contentLength > 0 : Boolean(req.headers["transfer-encoding"]);
  const isApi = req.path.startsWith("/api/");
  const isMultipart = contentType.startsWith("multipart/form-data");

  // Only JSON requests carrying a body need a JSON Content-Type. Empty POST/PATCH
  // requests such as connect/disconnect/takeover are valid without a body.
  if (isApi && hasBody && !isMultipart && !contentType.includes("application/json")) {
    return res.status(415).json({ error: "Content-Type must be application/json." });
  }
  next();
});

// Static assets are served after security headers so they receive the same baseline protections.
app.use(express.static(publicDirectory, {
  index: "index.html",
  maxAge: isProduction ? "1h" : 0,
}));
app.use("/uploads", express.static(path.resolve("./data/uploads"), { maxAge: isProduction ? "1d" : 0, index: false }));

const rateWindowMs = Math.max(1000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000));
const rateLimit = (max: number, prefix: string) => async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const key = requestFingerprint(req.ip || "unknown", req.headers["user-agent"] as string || "");
  const current = await consumeRateLimit(key, { windowMs: rateWindowMs, max, prefix });
  res.setHeader("X-RateLimit-Limit", max);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, max - current.count));
  if (current.count > max) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((current.resetAt - Date.now()) / 1000))));
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }
  next();
};
app.use("/api", rateLimit(Number(process.env.RATE_LIMIT_MAX || 120), "api"));
app.use("/api/auth", rateLimit(Number(process.env.AUTH_RATE_LIMIT_MAX || 30), "auth"));
app.use("/checkout", rateLimit(Number(process.env.CHECKOUT_RATE_LIMIT_MAX || 20), "checkout"));
setInterval(cleanupLocalRateLimitBuckets, Math.max(rateWindowMs, 60_000)).unref();

/* =========================================================
   V5 AUTH / MULTI-TENANT
========================================================= */

async function authenticate(req: express.Request) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  const user = await getSupabaseUser(token);
  if (!user) return null;
  const profile = await supabaseSelectOne<any>("profiles", `select=id,role,full_name,email,phone,status&id=eq.${encodeURIComponent(user.id)}`);
  if (!profile || profile.status === "suspended") return null;
  const role = profile.role === "admin" ? "admin" : "owner";
  const membershipsRaw = await supabaseList<any>("business_members", `select=business_id,role,businesses(id,name,slug,status)&user_id=eq.${encodeURIComponent(user.id)}`);
  const memberships = membershipsRaw.filter((m:any) => m.businesses?.status !== "suspended");
  return { user, profile, role, memberships };
}

function deny(res: express.Response, status=401, message="Authentication required.") {
  return res.status(status).json({ error: message });
}

async function requireAuth(req: express.Request, res: express.Response) {
  const auth = await authenticate(req);
  if (!auth) { deny(res); return null; }
  return auth;
}

function membershipFor(auth: any, businessId?: string) {
  if (auth.role === "admin") return { role: "admin" };
  if (!businessId) return null;
  return auth.memberships.find((m:any) => m.business_id === businessId) || null;
}

function membershipRole(auth: any, businessId?: string) {
  return membershipFor(auth, businessId)?.role || null;
}

function canManageBusiness(auth: any, businessId?: string) {
  const role = membershipRole(auth, businessId);
  return auth.role === "admin" || role === "owner";
}

function canManageCatalog(auth: any, businessId?: string) {
  return canManageBusiness(auth, businessId);
}

function ownsBusiness(auth: any, businessId: string) {
  if (auth.role === "admin") return true;
  return membershipRole(auth, businessId) === "owner";
}

function accountAllowed(auth: any, accountId: string) {
  const account = getAccount(accountId);
  if (!account) return null;
  if (auth.role === "admin") return account;
  if (account.businessId && membershipFor(auth, account.businessId)) return account;
  return null;
}

function accountCanManage(auth: any, accountId: string) {
  const account = accountAllowed(auth, accountId);
  return account && canManageBusiness(auth, account.businessId ?? undefined);
}

app.get("/api/auth/me", async (req,res) => {
  const auth = await authenticate(req);
  if (!auth) return deny(res);
  res.json({ user: auth.user, profile: auth.profile, role: auth.role, businesses: auth.memberships });
});

app.post("/api/auth/bootstrap", async (req,res) => {
  const auth = await requireAuth(req,res); if (!auth) return;
  if (auth.role !== "admin") return deny(res,403,"Only the system admin can create businesses.");
  const name = safeString(req.body.name, 120);
  if (!name) return res.status(400).json({error:"Business name is required."});
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "-" + crypto.randomBytes(4).toString("hex");
  const businessId = crypto.randomUUID();
  await supabaseUpsert("businesses", { id:businessId, name, slug, status:"active", created_at:new Date().toISOString(), updated_at:new Date().toISOString() });
  res.json({ businessId, name, status:"active" });
});

app.get("/api/admin/businesses", async (req,res) => {
  const auth = await requireAuth(req,res); if (!auth) return;
  if (auth.role !== "admin") return deny(res,403,"Admin access required.");
  const businesses = await supabaseList<any>("businesses", "select=*&order=created_at.desc");
  const members = await supabaseList<any>("business_members", "select=business_id,user_id,role");
  const profiles = await supabaseList<any>("profiles", "select=id,full_name,email,phone,role");
  const accounts = getAccounts();
  res.json(businesses.map((b:any)=>({
    ...b,
    members: members.filter((m:any)=>m.business_id===b.id).map((m:any)=>({ ...m, profile: profiles.find((p:any)=>p.id===m.user_id) || null })),
    whatsappAccounts: accounts.filter((a)=>a.businessId===b.id).map((a)=>({id:a.id,phone:a.phone,status:a.status,botOnline:a.botOnline,customerName:a.customerName}))
  })));
});


app.get("/api/admin/users", async (req,res) => {
  const auth = await requireAuth(req,res); if (!auth) return;
  if (auth.role !== "admin") return deny(res,403,"Admin access required.");
  const [profiles, memberships] = await Promise.all([
    supabaseList<any>("profiles", "select=id,full_name,email,phone,role,created_at&order=created_at.desc"),
    supabaseList<any>("business_members", "select=business_id,user_id,role,businesses(id,name,slug)")
  ]);
  res.json(profiles.map((p:any) => ({ ...p, business: memberships.find((m:any) => m.user_id === p.id)?.businesses || null })));
});

app.post("/api/admin/businesses/:id/owner", async (req,res) => {
  const auth = await requireAuth(req,res); if (!auth) return;
  if (auth.role !== "admin") return deny(res,403,"Admin access required.");
  const businessId = String(req.params.id);
  const userId = String(req.body.userId || "").trim();
  if (!userId) return res.status(400).json({error:"userId is required."});
  const business = await supabaseSelectOne<any>("businesses", `select=id&id=eq.${encodeURIComponent(businessId)}`);
  if (!business) return res.status(404).json({error:"Business not found."});
  const profile = await supabaseSelectOne<any>("profiles", `select=id,role&id=eq.${encodeURIComponent(userId)}`);
  if (!profile) return res.status(404).json({error:"User not found."});
  if (profile.role === "admin") return res.status(400).json({error:"A system admin cannot be assigned as a business owner."});
  const businessOwner = await supabaseSelectOne<any>("business_members", `select=id,user_id&business_id=eq.${encodeURIComponent(businessId)}`);
  if (businessOwner && businessOwner.user_id !== userId) return res.status(409).json({error:"This business already has an owner."});
  const existing = await supabaseSelectOne<any>("business_members", `select=id,business_id,user_id&user_id=eq.${encodeURIComponent(userId)}`);
  if (existing && existing.business_id !== businessId) return res.status(409).json({error:"That user already owns another business. One owner account can manage one business only."});
  await supabaseUpsert("business_members", { id: existing?.id || crypto.randomUUID(), business_id: businessId, user_id: userId, role:"owner", created_at: existing ? undefined : new Date().toISOString() });
  await supabaseUpsert("profiles", { id:userId, role:"owner", status:"active", updated_at:new Date().toISOString() });
  res.json({ok:true,businessId,userId});
});

app.patch("/api/admin/businesses/:id/status", async (req,res) => {
  const auth = await requireAuth(req,res); if (!auth) return;
  if (auth.role !== "admin") return deny(res,403,"Admin access required.");
  const status = String(req.body.status || "").trim();
  if (!["active","suspended"].includes(status)) return res.status(400).json({error:"Status must be active or suspended."});
  const business = await supabaseSelectOne<any>("businesses", `select=id&id=eq.${encodeURIComponent(req.params.id)}`);
  if (!business) return res.status(404).json({error:"Business not found."});
  await supabaseUpsert("businesses", {id:req.params.id,status,updated_at:new Date().toISOString()});
  if (status === "suspended") {
    for (const account of getAccounts().filter(a => a.businessId === req.params.id)) {
      try { await disconnectAccount(account.id); } catch {}
    }
  }
  res.json({ok:true,status});
});

app.patch("/api/admin/users/:id/status", async (req,res) => {
  const auth = await requireAuth(req,res); if (!auth) return;
  if (auth.role !== "admin") return deny(res,403,"Admin access required.");
  const status = String(req.body.status || "").trim();
  if (!["active","suspended"].includes(status)) return res.status(400).json({error:"Status must be active or suspended."});
  if (req.params.id === auth.user.id) return res.status(400).json({error:"You cannot suspend your own admin account."});
  const profile = await supabaseSelectOne<any>("profiles", `select=id,role&id=eq.${encodeURIComponent(req.params.id)}`);
  if (!profile) return res.status(404).json({error:"User not found."});
  if (profile.role === "admin") return res.status(400).json({error:"System admin accounts cannot be suspended here."});
  await supabaseUpsert("profiles", {id:req.params.id,status,updated_at:new Date().toISOString()});
  res.json({ok:true,status});
});

app.get("/api/businesses", async (req,res)=>{
  const auth=await requireAuth(req,res); if(!auth)return;
  const businesses=auth.role==="admin"
    ? await supabaseList<any>("businesses","select=*&order=created_at.desc")
    : auth.memberships.map((m:any)=>m.businesses).filter(Boolean);
  res.json(businesses);
});

app.get("/api/businesses/:id", async (req,res)=>{
  const auth=await requireAuth(req,res); if(!auth)return;
  if(!ownsBusiness(auth,req.params.id)) return deny(res,403,"You do not have access to this business.");
  const business=await supabaseSelectOne<any>("businesses",`select=*&id=eq.${encodeURIComponent(req.params.id)}`);
  if(!business)return res.status(404).json({error:"Business not found."});
  res.json({business, accounts:getAccounts().filter(a=>a.businessId===req.params.id)});
});

app.patch("/api/admin/accounts/:id/business", async (req,res)=>{
  const auth=await requireAuth(req,res); if(!auth)return;
  if(auth.role!=="admin") return deny(res,403,"Admin access required.");
  const account=getAccount(req.params.id);
  const businessId=String(req.body.businessId||"").trim();
  if(!account)return res.status(404).json({error:"Account not found."});
  if(!businessId)return res.status(400).json({error:"businessId is required."});
  const business=await supabaseSelectOne<any>("businesses",`select=id,status&id=eq.${encodeURIComponent(businessId)}`);
  if(!business)return res.status(404).json({error:"Business not found."});
  if (business.status === "suspended") return res.status(409).json({error:"Cannot assign a WhatsApp account to a suspended business."});
  const existingTarget=getAccounts().find(a=>a.businessId===businessId && a.id!==account.id);
  if(existingTarget) return res.status(409).json({error:"That business already has a WhatsApp number."});
  const updated=updateAccount(account.id,{businessId});
  res.json(updated);
});

function getPublicBaseUrl(req: express.Request) {
  const configured = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  if (configured) return configured;

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0].trim();
  if (!host) return `http://localhost:${port}`;
  return `${protocol}://${host}`.replace(/\/$/, "");
}

function isProductionImageStorageReady() {
  return isSupabaseConfigured();
}

function detectImageType(buffer: Buffer): { mime: string; ext: string } | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return { mime: "image/png", ext: "png" };
  }

  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { mime: "image/gif", ext: "gif" };
    }
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  return null;
}

function parseMultipartImage(req: express.Request) {
  const contentType = String(req.headers["content-type"] || "");
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  if (!match || !raw) return null;

  const boundaryValue = (match[1] || match[2] || "").trim();
  if (!boundaryValue) return null;

  const boundary = Buffer.from(`--${boundaryValue}`);
  const delimiter = Buffer.from(`\r\n--${boundaryValue}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  const firstBoundary = raw.indexOf(boundary);
  if (firstBoundary < 0) return null;

  let cursor = firstBoundary;
  while (cursor < raw.length) {
    const start = raw.indexOf(boundary, cursor);
    if (start < 0) break;

    const afterBoundary = start + boundary.length;
    if (raw.subarray(afterBoundary, afterBoundary + 2).equals(Buffer.from("--"))) break;

    const headerStart = raw.subarray(afterBoundary, afterBoundary + 2).equals(Buffer.from("\r\n"))
      ? afterBoundary + 2
      : afterBoundary;
    const headerEnd = raw.indexOf(headerSeparator, headerStart);
    if (headerEnd < 0) break;

    const headers = raw.subarray(headerStart, headerEnd).toString("latin1");
    const dispositionLine = headers
      .split(/\r?\n/)
      .find((line) => /^content-disposition\s*:/i.test(line));

    if (!dispositionLine) {
      cursor = afterBoundary;
      continue;
    }

    const nameMatch = dispositionLine.match(/\bname\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    const filenameMatch =
      dispositionLine.match(/\bfilename\s*=\s*"([^"]*)"/i) ||
      dispositionLine.match(/\bfilename\s*=\s*([^;\s]+)/i);
    const filenameStarMatch = dispositionLine.match(/\bfilename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;\s]+)/i);
    const fieldName = nameMatch?.[1] || nameMatch?.[2] || "";

    const bodyStart = headerEnd + headerSeparator.length;
    const nextBoundary = raw.indexOf(delimiter, bodyStart);
    if (nextBoundary < 0) break;

    const bodyEnd = nextBoundary;
    const bytes = raw.subarray(bodyStart, bodyEnd);

    if (fieldName === "image") {
      const detected = detectImageType(bytes);
      if (detected) {
        let originalname = filenameMatch?.[1] || filenameMatch?.[0] || "";
        if (!originalname && filenameStarMatch?.[1]) {
          try { originalname = decodeURIComponent(filenameStarMatch[1]); } catch { originalname = filenameStarMatch[1]; }
        }
        return {
          originalname: originalname || "product-image",
          mimetype: detected.mime,
          buffer: bytes,
          size: bytes.length,
          detectedExt: detected.ext,
          clientMime: headers.match(/^content-type\s*:\s*([^\r\n]+)/im)?.[1]?.trim().toLowerCase() || "",
        };
      }
    }

    cursor = nextBoundary + 2;
  }

  return null;
}

app.post("/api/accounts/:id/product-image", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const account = accountAllowed(auth, req.params.id);
  if (!account) return deny(res, 403, "You do not have access to this account.");
  if (!canManageCatalog(auth, account.businessId ?? undefined)) {
    return deny(res, 403, "Only the business owner or system admin can manage this resource.");
  }

  const file = parseMultipartImage(req);

  if (!file) {
    return res.status(400).json({
      error: "Please upload a valid JPG, PNG, WEBP or GIF image (max 5MB).",
    });
  }

  if (file.size < 16) {
    return res.status(400).json({ error: "The uploaded image is empty or invalid." });
  }

  if (file.size > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "Image is too large. Maximum size is 5MB." });
  }

  try {
    const ext = file.detectedExt;
    const safeAccount = account.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const objectPath =
      `${account.businessId || "default"}/${safeAccount}/` +
      `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`;

    // Production uploads must use durable, publicly readable Supabase Storage.
    // Never silently fall back to local disk in production: a successful local write
    // would produce an image URL that may disappear after a restart or point at the
    // wrong host.
    if (isProduction && !isProductionImageStorageReady()) {
      return res.status(503).json({
        error: "Image storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then retry.",
      });
    }

    if (isSupabaseConfigured()) {
      const bucket = (process.env.SUPABASE_STORAGE_BUCKET || "product-images").trim();
      if (!bucket) return res.status(500).json({ error: "SUPABASE_STORAGE_BUCKET is empty." });

      const url = await uploadStorage(
        bucket,
        objectPath,
        file.buffer,
        file.mimetype
      );

      return res.status(201).json({
        url,
        storage: "supabase",
        bucket,
        path: objectPath,
        name: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
      });
    }

    // Local development fallback. The URL is built from the actual public request
    // host (or PUBLIC_BASE_URL), not localhost, so tunnels/reverse proxies work.
    const uploadDir = path.join(path.resolve("./data"), "uploads", "products");
    fs.mkdirSync(uploadDir, { recursive: true });

    const filename = path.basename(objectPath);
    const localPath = path.join(uploadDir, filename);
    fs.writeFileSync(localPath, file.buffer);

    const base = getPublicBaseUrl(req);
    const url = `${base}/uploads/products/${encodeURIComponent(filename)}`;

    return res.status(201).json({
      url,
      storage: "local",
      name: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
    });
  } catch (error) {
    console.error("Product image upload failed:", error);
    const message = error instanceof Error ? error.message : "Unknown upload error.";
    return res.status(502).json({
      error: `Could not upload product image. ${message}`,
    });
  }
});

app.get("/api/config", (_,res)=>res.json({url:process.env.SUPABASE_URL||"",anonKey:process.env.SUPABASE_ANON_KEY||""}));

/* =========================================================
   PUBLIC CUSTOMER CHECKOUT
   These routes intentionally do not require dashboard auth.
   Access is granted by a high-entropy checkout token.
========================================================= */

function checkoutPageHtml(token: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secure Checkout</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font-family:Inter,system-ui,sans-serif}.wrap{max-width:760px;margin:0 auto;padding:24px}.brand{font-weight:900;font-size:24px;margin-bottom:18px}.card{background:#fff;border:1px solid #e0e6ef;border-radius:18px;padding:20px;box-shadow:0 8px 30px rgba(20,35,60,.06);margin-bottom:14px}.item{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #edf0f5}.item:last-child{border-bottom:0}.item img{width:72px;height:72px;object-fit:cover;border-radius:10px;background:#eef2f7}.item-body{flex:1}.muted{color:#68758a;font-size:13px}.total{display:flex;justify-content:space-between;font-weight:900;font-size:18px;margin-top:15px}.field{display:grid;gap:6px;margin:12px 0}.field label{font-size:12px;font-weight:700;color:#5c687a}.field input,.field textarea,.field select{width:100%;padding:12px;border:1px solid #ccd5e2;border-radius:10px;font:inherit;background:#fff}.field textarea{min-height:90px;resize:vertical}.btn{width:100%;border:0;border-radius:11px;padding:13px;background:#315bd8;color:#fff;font-weight:800;font-size:15px;cursor:pointer}.btn:disabled{opacity:.55}.msg{padding:12px;border-radius:10px;background:#f1f5ff;margin-top:12px;display:none}.success{background:#eafaf0}.error{background:#fff0f0}.hidden{display:none}</style></head><body><div class="wrap"><div class="brand" id="brand">Checkout</div><div id="app">Loading your cart...</div></div><script>
const TOKEN=${JSON.stringify(token)}; const app=document.getElementById('app'); const brand=document.getElementById('brand'); const esc=s=>(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
async function load(){const r=await fetch('/checkout/'+encodeURIComponent(TOKEN)+'/data');const d=await r.json();if(!r.ok){app.innerHTML='<div class="card">'+esc(d.error||'Checkout unavailable.')+'</div>';return}brand.textContent=esc(d.business.businessName||'Secure Checkout');const items=d.cart.items.map(i=>'<div class="item">'+(i.imageUrl?'<img src="'+esc(i.imageUrl)+'" alt="">':'')+'<div class="item-body"><b>'+esc(i.title)+'</b><div class="muted">Qty: '+i.quantity+' · '+esc(i.unitPrice)+'</div></div></div>').join('');app.innerHTML='<div class="card"><h2>Your Cart</h2>'+items+'<div class="total"><span>Total</span><span>'+esc(d.currency)+' '+Number(d.total).toLocaleString()+'</span></div></div><form class="card" id="form"><h2>Delivery Details</h2><div class="field"><label>FULL NAME</label><input name="name" required value="'+esc(d.customer.name)+'"></div><div class="field"><label>PHONE NUMBER</label><input name="phone" required value="'+esc(d.customer.phone)+'"></div><div class="field"><label>DELIVERY AREA</label><input name="area" required value="'+esc(d.customer.area)+'"></div><div class="field"><label>ADDRESS</label><input name="address" required value="'+esc(d.customer.address)+'"></div><div class="field"><label>ADDITIONAL INSTRUCTIONS</label><textarea name="instructions">'+esc(d.customer.instructions)+'</textarea></div><div class="field"><label>PAYMENT METHOD</label><select name="paymentMethod"><option value="cash_on_delivery">Cash on Delivery</option></select></div><button class="btn" id="submit">Submit Order</button><div class="msg" id="msg"></div></form>';
document.getElementById('form').addEventListener('submit',submit)}
async function submit(e){e.preventDefault();const btn=document.getElementById('submit'),msg=document.getElementById('msg');btn.disabled=true;msg.style.display='block';msg.className='msg';msg.textContent='Placing your order...';const body=Object.fromEntries(new FormData(e.target).entries());const r=await fetch('/checkout/'+encodeURIComponent(TOKEN)+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok){msg.className='msg error';msg.textContent=d.error||'Could not place order.';btn.disabled=false;return}msg.className='msg success';msg.textContent='Order received successfully. Order reference: '+d.checkoutId;document.getElementById('form').remove()}load();</script></body></html>`;
}

app.get('/checkout/:token', (req,res) => { if (!getCartByToken(req.params.token)) return res.status(404).send('Checkout session not found or cart is empty.'); res.type('html').send(checkoutPageHtml(req.params.token)); });
app.get('/checkout/:token/data', (req,res) => { const summary=buildCheckoutSummary(req.params.token); if(!summary) return res.status(404).json({error:'Checkout session not found or cart is empty.'}); const fresh=validateCart(summary.accountId,summary.cart.jid); res.json({...summary,cart:fresh,total:cartTotal(fresh)}); });
app.post('/checkout/:token/submit', (req,res) => {
  try {
    const summary=buildCheckoutSummary(req.params.token); if(!summary) return res.status(404).json({error:'Checkout session not found or cart is empty.'});
    const name=String(req.body.name||'').trim(), phone=String(req.body.phone||'').replace(/\D/g,''), area=String(req.body.area||'').trim(), address=String(req.body.address||'').trim(), instructions=String(req.body.instructions||'').trim(), paymentMethod=String(req.body.paymentMethod||'cash_on_delivery').trim();
    if(!name||phone.length<7||!area||!address) return res.status(400).json({error:'Name, valid phone, delivery area and address are required.'});
    if(paymentMethod !== 'cash_on_delivery') return res.status(400).json({error:'This checkout currently supports Cash on Delivery only. Online and Mobile Money payments are not yet connected.'});
    updateCustomer(summary.accountId,summary.cart.jid,{name,phone,area,address,instructions});
    const fresh=validateCart(summary.accountId,summary.cart.jid);
    const idempotencyKey = safeString(req.headers["idempotency-key"] || req.body.idempotencyKey || "", 128) || crypto.createHash("sha256").update(`${req.params.token}:${name}:${phone}:${JSON.stringify(fresh.items)}`).digest("hex");
    const result=createOrdersFromCart(fresh,{name,phone,area,address,instructions,paymentMethod,idempotencyKey});
    const orderIds=result.orders.map(o=>o.id);
    void sendCheckoutConfirmation(summary.accountId, summary.cart.jid, result.checkoutId, result.total, summary.currency, orderIds).catch(error => console.error("WhatsApp checkout confirmation failed:", error));
    res.json({ok:true,checkoutId:result.checkoutId,total:result.total,orderIds});
  } catch(error) { res.status(400).json({error:error instanceof Error?error.message:String(error)}); }
});

app.use("/api", async (req,res,next)=>{
  if (req.path.startsWith("/auth/") || req.path === "/auth/me" || req.path === "/auth/bootstrap" || req.path === "/admin/businesses" || req.path === "/health") return next();
  const auth=await authenticate(req);
  if(!auth) return deny(res);
  (req as any).auth=auth;
  const match=req.path.match(/^\/accounts\/([^/]+)/);
  if(match) {
    const account = accountAllowed(auth, match[1]);
    if (!account) return deny(res,403,"You do not have access to this WhatsApp account.");
    const managementPath = /^(\/accounts\/[^/]+\/(?:pair|qr|disconnect|settings|business-profile)|\/accounts\/[^/]+$)/.test(req.path);
    if (managementPath && req.method !== "GET" && !canManageBusiness(auth, account.businessId ?? undefined)) return deny(res,403,"Only the business owner or system admin can manage this resource.");
  }
  next();
});

/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status",
  async (req, res) => {
    const auth = await requireAuth(req,res); if (!auth) return;
    const accounts = getAccounts().filter((a) => auth.role === "admin" || (a.businessId && auth.memberships.some((m:any)=>m.business_id===a.businessId)));

    const totals = {
      customers:
        accounts.length,

      connected:
        accounts.filter(
          (account) =>
            account.status ===
            "connected"
        ).length,

      onlineBots:
        accounts.filter(
          (account) =>
            account.botOnline
        ).length,

      messages:
        accounts.reduce(
          (total, account) =>
            total +
            account.messagesReceived +
            account.messagesSent,
          0
        ),

      aiRequests:
        accounts.reduce(
          (total, account) =>
            total +
            account.aiRequests,
          0
        ),
    };

    res.json({
      accounts,
      totals,
      supabase: isSupabaseConfigured(),
    });
  }
);

/* =========================================================
   ALL LOGS
========================================================= */

app.get(
  "/api/logs",
  async (req, res) => { const auth=await requireAuth(req,res); if(!auth)return; res.json(auth.role==="admin"?getLogs():getLogs().filter(l=>{const a=l.accountId?getAccount(l.accountId):null; return a?.businessId && auth.memberships.some((m:any)=>m.business_id===a.businessId)})); }
);

/* =========================================================
   ACCOUNT TENANT ACCESS
   Only system admin or the business owner may use account routes.
========================================================= */
app.use("/api/accounts", async (req, res, next) => {
  const auth = await authenticate(req);
  if (!auth) return deny(res);
  (req as any).auth = auth;

  const match = req.path.match(/^\/([^/]+)/);
  if (!match) return next();

  const account = accountAllowed(auth, match[1]);
  if (!account) return deny(res, 403, "You do not have access to this WhatsApp account.");
  if (!canManageBusiness(auth, account.businessId ?? undefined)) {
    return deny(res, 403, "Only the business owner or system admin can manage this WhatsApp account.");
  }
  next();
});

/* =========================================================
   CREATE ACCOUNT
========================================================= */

app.post(
  "/api/accounts",
  async (req, res) => {
    const auth = await requireAuth(req,res); if (!auth) return;
    try {
      const customerName =
        String(
          req.body.customerName ||
            ""
        ).trim();

      const phone =
        String(
          req.body.phone ||
            ""
        ).replace(
          /\D/g,
          ""
        );

      if (
        !customerName ||
        !phone
      ) {
        res
          .status(400)
          .json({
            error:
              "Customer name and WhatsApp number are required.",
          });

        return;
      }

      /*
       * Prevent duplicate numbers.
       */
      const duplicate =
        getAccounts().some(
          (account) =>
            account.phone ===
            phone
        );

      if (duplicate) {
        res
          .status(409)
          .json({
            error:
              "That WhatsApp number is already registered.",
          });

        return;
      }

      const requestedBusiness = String(req.body.businessId || "").trim();
      const businessId = auth.role === "admin" ? requestedBusiness : (auth.memberships[0]?.business_id || "");
      if (!businessId) return res.status(400).json({error:"Create or select a business first."});
      if (!ownsBusiness(auth,businessId)) return deny(res,403,"You do not have access to that business.");
      if (!canManageBusiness(auth,businessId)) return deny(res,403,"Only the business owner or system admin can add a WhatsApp account.");
      const businessAccount = getAccounts().find((a) => a.businessId === businessId);
      if (businessAccount) return res.status(409).json({error:"This business already has a WhatsApp account. Only one WhatsApp number is allowed per business."});
      const account = createAccount(customerName, phone, businessId);

      addLog(
        "system",
        `Customer account created: ${customerName} (${phone}).`,
        account.id
      );

      res.json(
        account
      );
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : String(error),
        });
    }
  }
);

/* =========================================================
   GENERATE PAIRING CODE
========================================================= */

app.post(
  "/api/accounts/:id/pairing-code",
  async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const account = accountAllowed(auth, req.params.id);
    if (!account) {
      return deny(res, 403, "You do not have access to this WhatsApp account.");
    }

    if (!canManageBusiness(auth, account.businessId ?? undefined)) {
      return deny(
        res,
        403,
        "Only the business owner or system admin can generate a pairing code."
      );
    }

    try {
      const code = await requestPairingCode(req.params.id);

      return res.json({ code });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Pairing code generation failed:", error);

      return res.status(500).json({
        error: message || "Could not generate pairing code.",
      });
    }
  }
);

/* =========================================================
   CONNECT / QR FALLBACK
========================================================= */

app.post(
  "/api/accounts/:id/connect",
  async (req, res) => {
    try {
      const account =
        getAccount(
          req.params.id
        );

      if (!account) {
        res
          .status(404)
          .json({
            error:
              "Account not found.",
          });

        return;
      }

      await connectAccount(
        req.params.id
      );

      res.json({
        ok: true,
      });
    } catch (error) {
      res
        .status(500)
        .json({
          error:
            error instanceof Error
              ? error.message
              : String(error),
        });
    }
  }
);

/* =========================================================
   DISCONNECT
========================================================= */

app.post(
  "/api/accounts/:id/disconnect",
  (req, res) => {
    disconnectAccount(
      req.params.id
    );

    res.json({
      ok: true,
    });
  }
);

/* =========================================================
   UPDATE ACCOUNT
========================================================= */

app.patch(
  "/api/accounts/:id",
  (req, res) => {
    const account =
      getAccount(
        req.params.id
      );

    if (!account) {
      res
        .status(404)
        .json({
          error:
            "Account not found.",
        });

      return;
    }

    const patch: Record<
      string,
      unknown
    > = {};

    if (
      typeof req.body
        .customerName ===
      "string"
    ) {
      patch.customerName =
        req.body.customerName.trim();
    }

    if (
      typeof req.body.prompt ===
      "string"
    ) {
      patch.prompt =
        req.body.prompt;
    }

    if (
      typeof req.body.model ===
      "string"
    ) {
      patch.model =
        req.body.model;
    }

    if (
      typeof req.body.botEnabled ===
      "boolean"
    ) {
      patch.botEnabled =
        req.body.botEnabled;

      patch.botOnline =
        req.body.botEnabled &&
        account.status ===
          "connected";
    }

    const updated =
      updateAccount(
        req.params.id,
        patch
      );

    res.json(
      updated
    );
  }
);

/* =========================================================
   ACCOUNT LOGS
========================================================= */

app.get(
  "/api/accounts/:id/logs",
  (req, res) => {
    const account =
      getAccount(
        req.params.id
      );

    if (!account) {
      res
        .status(404)
        .json({
          error:
            "Account not found.",
        });

      return;
    }

    res.json(
      getLogs(
        req.params.id
      )
    );
  }
);

/* =========================================================
   CONVERSATION HISTORY
========================================================= */

app.get(
  "/api/accounts/:id/conversations",
  (req, res) => {
    const account = getAccount(req.params.id);

    if (!account) {
      res.status(404).json({ error: "Account not found." });
      return;
    }

    res.json(
      getConversationMessages(
        req.params.id,
        typeof req.query.jid === "string" ? req.query.jid : undefined
      )
    );
  }
);

/* =========================================================
   PER-CHAT AI CONTROL
========================================================= */

app.get(
  "/api/accounts/:id/chat/:jid/ai",
  (req, res) => {
    const account = getAccount(req.params.id);

    if (!account) {
      res.status(404).json({ error: "Account not found." });
      return;
    }

    res.json({
      enabled: getContactAiEnabled(req.params.id, req.params.jid),
    });
  }
);

app.post(
  "/api/accounts/:id/chat/:jid/ai",
  (req, res) => {
    const account = getAccount(req.params.id);

    if (!account) {
      res.status(404).json({ error: "Account not found." });
      return;
    }

    if (typeof req.body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be boolean." });
      return;
    }

    const state = setContactAiEnabled(
      req.params.id,
      req.params.jid,
      req.body.enabled
    );

    if (req.body.enabled) {
      setHumanTakeover(req.params.id, req.params.jid, false);
    }

    res.json(state);
  }
);

/* =========================================================
   CONTACTS / HUMAN TAKEOVER
========================================================= */

app.get("/api/accounts/:id/contacts", (req, res) => {
  if (!getAccount(req.params.id)) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  res.json(getContacts(req.params.id));
});

app.get("/api/accounts/:id/chat/:jid/control", (req, res) => {
  if (!getAccount(req.params.id)) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  res.json({
    aiEnabled: getContactAiEnabled(req.params.id, req.params.jid),
    humanTakeover: isHumanTakeover(req.params.id, req.params.jid),
  });
});

app.post("/api/accounts/:id/chat/:jid/takeover", (req, res) => {
  if (!getAccount(req.params.id)) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  const state = setHumanTakeover(req.params.id, req.params.jid, true);
  res.json(state);
});

app.post("/api/accounts/:id/chat/:jid/release", (req, res) => {
  if (!getAccount(req.params.id)) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  const state = setHumanTakeover(req.params.id, req.params.jid, false);
  setContactAiEnabled(req.params.id, req.params.jid, true);
  res.json(state);
});



app.post("/api/accounts/:id/chat/:jid/send", async (req, res) => {
  const account = getAccount(req.params.id);
  if (!account) {
    res.status(404).json({ error: "Account not found." });
    return;
  }
  const text = String(req.body.text || "").trim();
  if (!text) {
    res.status(400).json({ error: "Message text is required." });
    return;
  }

  try {
    const { sendManualMessage } = await import("./whatsapp.js");
    await sendManualMessage(req.params.id, req.params.jid, text);
    addConversationMessage(req.params.id, req.params.jid, "assistant", text);
    addLog("outgoing", `${req.params.jid}: ${text} [human]`, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/* =========================================================
   BUSINESS PROFILE
========================================================= */

app.get("/api/accounts/:id/business-profile", (req, res) => {
  if (!getAccount(req.params.id)) return res.status(404).json({ error: "Account not found." });
  res.json(getBusinessProfile(req.params.id));
});

app.patch("/api/accounts/:id/business-profile", (req, res) => {
  const auth = (req as any).auth;
  const account = accountAllowed(auth, req.params.id);
  if (!account) return deny(res, 403, "You do not have access to this account.");
  if (!canManageBusiness(auth, account.businessId ?? undefined)) return deny(res, 403, "Only the business owner or system admin can manage this business.");
  const patch: Record<string, unknown> = {};
  for (const key of ["businessName","description","location","currency","phone","workingHours","website","salesBehavior"]) {
    if (req.body[key] !== undefined) patch[key] = String(req.body[key]);
  }
  if (!["helpful","minimal","proactive"].includes(String(patch.salesBehavior || getBusinessProfile(req.params.id).salesBehavior))) {
    return res.status(400).json({ error: "Invalid sales behavior." });
  }
  res.json(updateBusinessProfile(req.params.id, patch as never));
});

/* =========================================================
   CRM CONTACTS
========================================================= */

app.patch("/api/accounts/:id/chat/:jid/crm", async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  if (!accountAllowed(auth, req.params.id)) return deny(res, 403, "You do not have access to this account.");
  const stages = ["new","interested","ready_to_buy","ordered","completed","lost"];
  const patch: Record<string, string> = {};
  if (req.body.stage !== undefined) {
    if (!stages.includes(String(req.body.stage))) return res.status(400).json({ error: "Invalid CRM stage." });
    patch.stage = String(req.body.stage);
  }
  if (req.body.notes !== undefined) patch.notes = safeString(req.body.notes, 2000);
  res.json(updateContactCRM(req.params.id, req.params.jid, patch as never));
});

/* =========================================================
   ORDERS
========================================================= */

app.get("/api/accounts/:id/orders", async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  if (!accountAllowed(auth, req.params.id)) return deny(res, 403, "You do not have access to this account.");
  res.json(getOrders(req.params.id));
});

app.post("/api/accounts/:id/orders", async (req, res) => {
  const auth = await requireAuth(req, res); if (!auth) return;
  if (!accountAllowed(auth, req.params.id)) return deny(res, 403, "You do not have access to this account.");
  const product = String(req.body.product || "").trim();
  const customerName = String(req.body.customerName || "").trim();
  const jid = String(req.body.jid || "").trim();
  const quantity = Number(req.body.quantity || 1);
  if (!product || !customerName || !jid || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
    return res.status(400).json({ error: "Customer, WhatsApp JID, product and a valid quantity (1-10000) are required." });
  }
  res.json(createOrder(req.params.id, {
    jid, customerName, product, productId: req.body.productId ? String(req.body.productId) : null, quantity,
    unitPrice: String(req.body.unitPrice || ""),
    totalPrice: String(req.body.totalPrice || ""),
    status: "pending",
    paymentStatus: "pending",
    fulfillmentStatus: "unfulfilled",
    delivery: { name: customerName, phone: "", area: "", address: "", instructions: "" },
    notes: String(req.body.notes || ""),
    source: "manual",
  }));
});

/* =========================================================
   KNOWLEDGE BASE
========================================================= */

app.patch("/api/orders/:id", async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const existing = getOrdersForAnyAccount().find((order) => order.id === req.params.id);
  if (!existing) return res.status(404).json({ error: "Order not found." });

  const ownerAccount = getAccount(existing.accountId);
  if (!ownerAccount || !accountAllowed(auth, ownerAccount.id)) {
    return deny(res, 403, "You do not have access to this order.");
  }
  if (!canManageBusiness(auth, ownerAccount.businessId ?? undefined)) {
    return deny(res, 403, "Only the business owner or system admin can update orders.");
  }

  const allowed = ["pending","confirmed","processing","completed","cancelled"];
  const paymentAllowed = ["pending","paid","failed","refunded"];
  const fulfillmentAllowed = ["unfulfilled","processing","shipped","delivered","failed"];
  const patch: Record<string, unknown> = {};
  for (const key of ["customerName","product","unitPrice","totalPrice","notes","paymentStatus","fulfillmentStatus","delivery"]) if (req.body[key] !== undefined) patch[key] = req.body[key];
  if (req.body.quantity !== undefined) {
    const quantity = Number(req.body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) return res.status(400).json({ error: "Quantity must be an integer between 1 and 10000." });
    patch.quantity = quantity;
  }
  if (req.body.status !== undefined) {
    if (!allowed.includes(String(req.body.status))) return res.status(400).json({ error: "Invalid order status." });
    patch.status = String(req.body.status);
  }
  if (req.body.paymentStatus !== undefined) {
    if (!paymentAllowed.includes(String(req.body.paymentStatus))) return res.status(400).json({ error: "Invalid payment status." });
    patch.paymentStatus = String(req.body.paymentStatus);
  }
  if (req.body.fulfillmentStatus !== undefined) {
    if (!fulfillmentAllowed.includes(String(req.body.fulfillmentStatus))) return res.status(400).json({ error: "Invalid fulfillment status." });
    patch.fulfillmentStatus = String(req.body.fulfillmentStatus);
  }
  const updated = updateOrder(req.params.id, patch as never);
  if (!updated) return res.status(404).json({ error: "Order not found." });
  res.json(updated);
});

/* =========================================================
   KNOWLEDGE BASE
========================================================= */

app.get(
  "/api/accounts/:id/knowledge",
  async (req, res) => {
    const auth = await requireAuth(req, res); if (!auth) return;
    const account = accountAllowed(auth, req.params.id);

    if (!account) {
      res.status(404).json({ error: "Account not found." });
      return;
    }

    res.json(getKnowledge(req.params.id));
  }
);

app.post(
  "/api/accounts/:id/knowledge",
  async (req, res) => {
    const auth = await requireAuth(req, res); if (!auth) return;
    const account = accountAllowed(auth, req.params.id);

    if (!account) {
      res.status(404).json({ error: "Account not found." });
      return;
    }
    if (!canManageCatalog(auth, account.businessId ?? undefined)) return deny(res, 403, "Only the business owner or system admin can manage the catalog.");

    const title = String(req.body.title || "").trim();
    if (!title) {
      res.status(400).json({ error: "Knowledge item title is required." });
      return;
    }

    for (const [field, value] of [["imageUrl", req.body.imageUrl], ["productUrl", req.body.productUrl], ["fileUrl", req.body.fileUrl]] as const) {
      if (value && !validUrl(String(value).trim())) return res.status(400).json({ error: `Invalid ${field}. HTTPS URL required.` });
    }
    if (Array.isArray(req.body.imageUrls) && req.body.imageUrls.some((x: unknown) => !validUrl(String(x)))) return res.status(400).json({ error: "All image URLs must be valid HTTPS URLs." });

    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.map((x: unknown) => String(x).trim()).filter(Boolean)
      : String(req.body.tags || "")
          .split(",")
          .map((x: string) => x.trim())
          .filter(Boolean);

    const item = createKnowledgeItem(req.params.id, {
      type: ["product", "document", "link", "general"].includes(req.body.type)
        ? req.body.type
        : "product",
      title,
      description: String(req.body.description || "").trim(),
      price: req.body.price ? String(req.body.price).trim() : null,
      imageUrl: req.body.imageUrl ? String(req.body.imageUrl).trim() : null,
      imageUrls: Array.isArray(req.body.imageUrls) ? req.body.imageUrls.map((x: unknown) => String(x).trim()).filter(Boolean) : (req.body.imageUrl ? [String(req.body.imageUrl).trim()] : []),
      productUrl: req.body.productUrl ? String(req.body.productUrl).trim() : null,
      fileUrl: req.body.fileUrl ? String(req.body.fileUrl).trim() : null,
      actions: Array.isArray(req.body.actions) ? req.body.actions : undefined,
      category: req.body.category ? String(req.body.category).trim() : null,
      tags,
      available: req.body.available !== false,
      stock: req.body.stock === null || req.body.stock === undefined || req.body.stock === "" ? null : (Number.isFinite(Number(req.body.stock)) ? Math.max(0, Math.floor(Number(req.body.stock))) : null),
      sku: req.body.sku ? String(req.body.sku).trim() : null,
      variants: Array.isArray(req.body.variants) ? req.body.variants : [],
    });

    res.json(item);
  }
);

app.patch(
  "/api/knowledge/:id",
  async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const existing = getKnowledgeForAnyAccount().find((item) => item.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "Knowledge item not found." });
    const ownerAccount = getAccount(existing.accountId);
    if (!ownerAccount || !accountAllowed(auth, ownerAccount.id)) {
      return deny(res, 403, "You do not have access to this knowledge item.");
    }
    if (!canManageCatalog(auth, ownerAccount.businessId ?? undefined)) return deny(res, 403, "Only the business owner or system admin can manage the catalog.");

    const patch: Record<string, unknown> = {};

    for (const key of [
      "type",
      "title",
      "description",
      "price",
      "imageUrl",
      "imageUrls",
      "productUrl",
      "fileUrl",
      "actions",
      "category",
      "available",
      "stock",
      "sku",
      "variants",
    ]) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }

    if (req.body.tags !== undefined) {
      patch.tags = Array.isArray(req.body.tags)
        ? req.body.tags.map((x: unknown) => String(x).trim()).filter(Boolean)
        : String(req.body.tags)
            .split(",")
            .map((x: string) => x.trim())
            .filter(Boolean);
    }

    const updated = updateKnowledgeItem(req.params.id, patch);

    if (!updated) {
      res.status(404).json({ error: "Knowledge item not found." });
      return;
    }

    res.json(updated);
  }
);

app.delete(
  "/api/knowledge/:id",
  async (req, res) => {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const existing = getKnowledgeForAnyAccount().find((item) => item.id === req.params.id);
    if (!existing) return res.status(404).json({ error: "Knowledge item not found." });
    const ownerAccount = getAccount(existing.accountId);
    if (!ownerAccount || !accountAllowed(auth, ownerAccount.id)) {
      return deny(res, 403, "You do not have access to this knowledge item.");
    }
    if (!canManageCatalog(auth, ownerAccount.businessId ?? undefined)) return deny(res, 403, "Only the business owner or system admin can manage the catalog.");

    if (!deleteKnowledgeItem(req.params.id)) {
      res.status(404).json({ error: "Knowledge item not found." });
      return;
    }

    res.json({ ok: true });
  }
);

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get("/healthz", (_, res) => {
  res.status(200).json({ ok: true, service: "zetiora-whatsapp-ai", time: new Date().toISOString() });
});

app.get("/readyz", async (_, res) => {
  let database = isSupabaseConfigured() ? "configured" : "not_configured";
  let ready = !requireSupabase || isSupabaseConfigured();
  if (ready && requireSupabase) {
    try { await supabaseList("businesses", "select=id&limit=1"); database = "ok"; }
    catch { database = "unavailable"; ready = false; }
  }
  res.status(ready ? 200 : 503).json({ ok: ready, database });
});

app.get("/api/health", (_, res) => {
  const ready = !requireSupabase || isSupabaseConfigured();
  res.status(ready ? 200 : 503).json({
    ok: ready,
    service: "zetiora-whatsapp-ai",
    environment: nodeEnv,
    database: isSupabaseConfigured() ? "configured" : "not_configured",
    accounts: getAccounts().length,
    time: new Date().toISOString(),
  });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  const requestId = (req as express.Request & { requestId?: string }).requestId;
  addLog("error", `Unhandled request error${requestId ? ` [${requestId}]` : ""}: ${message}`);
  res.status(500).json({ error: isProduction ? "Internal server error." : message, requestId });
});

/* =========================================================
   FRONTEND FALLBACK
========================================================= */

app.get(
  "*splat",
  (_, res) => {
    res.sendFile(
      path.join(
        publicDirectory,
        "index.html"
      )
    );
  }
);

/* =========================================================
   START SERVER
========================================================= */

const server = app.listen(
  port,
  async () => {
    addLog(
      "system",
      `Admin dashboard running at http://localhost:${port}`
    );

    try {
      if (isSupabaseConfigured()) await hydrateStateFromSupabase();
      await syncExistingStateToSupabase();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addLog("error", `Initial Supabase sync failed: ${message}`);
      if (requireSupabase) {
        addLog("error", "Supabase is required in this deployment; refusing to start WhatsApp workers.");
        server.close(() => process.exit(1));
        return;
      }
    }

    const accounts =
      getAccounts();

    /*
     * IMPORTANT:
     *
     * Restore every previously registered
     * WhatsApp account after server restart.
     */
    if (accounts.length === 0) {
      addLog(
        "system",
        "No saved WhatsApp accounts found."
      );

      return;
    }

    addLog(
      "system",
      `Restoring ${accounts.length} WhatsApp account(s)...`
    );

    /*
     * Connect accounts one by one.
     */
    for (const account of accounts) {
      try {
        addLog(
          "system",
          `Restoring WhatsApp number +${account.phone}...`,
          account.id
        );

        await connectAccount(
          account.id
        );

        /*
         * Small delay between accounts
         * to avoid starting everything at
         * exactly the same moment.
         */
        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              1000
            )
        );
      } catch (error) {
        addLog(
          "error",
          `Failed to restore +${account.phone}: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`,
          account.id
        );
      }
    }
  }
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  addLog("system", `Received ${signal}; shutting down gracefully.`);
  server.close(() => process.exit(0));
  for (const account of getAccounts()) {
    try { await disconnectAccount(account.id); } catch { /* best effort */ }
  }
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => addLog("error", `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`));
process.on("uncaughtException", (error) => { addLog("error", `Uncaught exception: ${error.message}`); void shutdown("uncaughtException"); });
