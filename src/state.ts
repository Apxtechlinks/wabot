import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { upsert as supabaseUpsert, remove as supabaseRemove, list as supabaseList } from "./supabase.js";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected";

export type LogType =
  | "system"
  | "incoming"
  | "outgoing"
  | "error";

export interface Account {
  id: string;
  businessId: string | null;
  customerName: string;
  phone: string;

  status: ConnectionStatus;

  botEnabled: boolean;
  botOnline: boolean;

  qrDataUrl: string | null;
  pairingCode: string | null;

  model: string;
  prompt: string;

  createdAt: string;
  lastSeenAt: string | null;

  messagesReceived: number;
  messagesSent: number;
  aiRequests: number;

  lastMessage: string | null;
}

export interface Activity {
  id: string;
  accountId: string | null;
  time: string;
  type: LogType;
  message: string;
}

const DATA_DIR = path.resolve("./data");

const ACCOUNTS_FILE = path.join(
  DATA_DIR,
  "accounts.json"
);

const LOGS_FILE = path.join(
  DATA_DIR,
  "logs.json"
);

fs.mkdirSync(DATA_DIR, {
  recursive: true,
});

const accounts = new Map<string, Account>();

let logs: Activity[] = [];

/* =========================================================
   LOAD SAVED DATA
========================================================= */

function loadData() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = fs.readFileSync(
        ACCOUNTS_FILE,
        "utf8"
      );

      const savedAccounts =
        JSON.parse(data) as Account[];

      for (const account of savedAccounts) {
        /*
         * Server restart haimaanishi WhatsApp ime-connect.
         * Baileys ita-reconnect yenyewe kupitia session yake.
         */
        account.status = "disconnected";
        account.botOnline = false;
        account.qrDataUrl = null;
        account.pairingCode = null;

        accounts.set(
          account.id,
          account
        );
      }
    }

    if (fs.existsSync(LOGS_FILE)) {
      const data = fs.readFileSync(
        LOGS_FILE,
        "utf8"
      );

      logs = JSON.parse(data) as Activity[];
    }

    console.log(
      `Loaded ${accounts.size} saved account(s).`
    );
  } catch (error) {
    console.error(
      "Failed to load saved data:",
      error
    );
  }
}

/* =========================================================
   SAVE DATA
========================================================= */

function saveAccounts() {
  try {
    fs.writeFileSync(
      ACCOUNTS_FILE,
      JSON.stringify(
        [...accounts.values()],
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.error(
      "Failed to save accounts:",
      error
    );
  }
}

function saveLogs() {
  try {
    fs.writeFileSync(
      LOGS_FILE,
      JSON.stringify(
        logs,
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.error(
      "Failed to save logs:",
      error
    );
  }
}

/* =========================================================
   DEFAULT AI PROMPT
========================================================= */

export function defaultPrompt() {
  return `
You are a friendly, helpful and natural WhatsApp AI assistant.

Personality:
- Friendly
- Helpful
- Natural
- Professional when necessary

Language:
- Mainly use Tanzanian Swahili.
- Understand English very well.
- Mix Swahili and English naturally when appropriate.
- Follow the language used by the customer.

Response style:
- Be concise by default.
- Give more detail when the customer asks for it.
- Do not unnecessarily repeat the customer's question.

You can help with:
- General conversations
- Questions
- Learning
- Coding
- Writing
- Explanations
- Ideas
- Problem solving

Never claim that you performed an action that you cannot actually perform.
`.trim();
}

/* =========================================================
   CREATE ACCOUNT
========================================================= */

export function createAccount(
  customerName: string,
  phone: string,
  businessId: string | null = null
) {
  const account: Account = {
    id: crypto.randomUUID(),

    businessId,

    customerName,

    phone,

    status: "disconnected",

    botEnabled: true,

    botOnline: false,

    qrDataUrl: null,

    pairingCode: null,

    model:
      process.env.GEMINI_MODEL ||
      "gemini-2.5-flash",

    prompt: defaultPrompt(),

    createdAt:
      new Date().toISOString(),

    lastSeenAt: null,

    messagesReceived: 0,

    messagesSent: 0,

    aiRequests: 0,

    lastMessage: null,
  };

  accounts.set(
    account.id,
    account
  );

  saveAccounts();
  void supabaseUpsert("wa_accounts", {
    id: account.id, business_id: account.businessId, customer_name: account.customerName, phone: account.phone, status: account.status,
    bot_enabled: account.botEnabled, bot_online: account.botOnline, model: account.model, prompt: account.prompt,
    created_at: account.createdAt, last_seen_at: account.lastSeenAt, messages_received: account.messagesReceived,
    messages_sent: account.messagesSent, ai_requests: account.aiRequests, last_message: account.lastMessage,
  }).catch((error) => console.error("Supabase account sync failed:", error));

  return account;
}

/* =========================================================
   ACCOUNT GETTERS
========================================================= */

export function getAccounts() {
  return [...accounts.values()];
}

export function getAccount(id: string) {
  return accounts.get(id);
}

/* =========================================================
   UPDATE ACCOUNT
========================================================= */

export function updateAccount(
  id: string,
  patch: Partial<Account>
) {
  const account = accounts.get(id);

  if (!account) {
    return null;
  }

  Object.assign(
    account,
    patch
  );

  saveAccounts();
  void supabaseUpsert("wa_accounts", {
    id: account.id, business_id: account.businessId, customer_name: account.customerName, phone: account.phone, status: account.status,
    bot_enabled: account.botEnabled, bot_online: account.botOnline, model: account.model, prompt: account.prompt,
    created_at: account.createdAt, last_seen_at: account.lastSeenAt, messages_received: account.messagesReceived,
    messages_sent: account.messagesSent, ai_requests: account.aiRequests, last_message: account.lastMessage,
  }).catch((error) => console.error("Supabase account update failed:", error));

  return account;
}

/* =========================================================
   CONNECTION STATUS
========================================================= */

export function setConnection(
  id: string,
  status: ConnectionStatus
) {
  const account = accounts.get(id);

  if (!account) {
    return;
  }

  account.status = status;

  account.botOnline =
    status === "connected" &&
    account.botEnabled;

  if (status === "connected") {
    account.lastSeenAt =
      new Date().toISOString();
  }

  saveAccounts();
  void syncAccount(account).catch(error => console.error("Supabase connection sync failed:", error));
}

/* =========================================================
   COUNTERS
========================================================= */

export function inc(
  id: string,
  key:
    | "messagesReceived"
    | "messagesSent"
    | "aiRequests"
) {
  const account = accounts.get(id);

  if (!account) {
    return;
  }

  account[key]++;

  saveAccounts();
}

/* =========================================================
   LAST MESSAGE
========================================================= */

export function lastMessage(
  id: string,
  message: string
) {
  const account = accounts.get(id);

  if (!account) {
    return;
  }

  account.lastMessage =
    message.slice(0, 500);

  saveAccounts();
}

/* =========================================================
   LOGGING
========================================================= */

export function addLog(
  type: LogType,
  message: string,
  accountId: string | null = null
) {
  const activity: Activity = {
    id: crypto.randomUUID(),

    accountId,

    time:
      new Date().toISOString(),

    type,

    message,
  };

  logs.unshift(activity);

  if (logs.length > 500) {
    logs.length = 500;
  }

  saveLogs();
  void supabaseUpsert("wa_logs", {
    id: activity.id, account_id: activity.accountId, business_id: activity.accountId ? getAccount(activity.accountId)?.businessId ?? null : null, time: activity.time, type: activity.type, message: activity.message,
  }).catch((error) => console.error("Supabase log sync failed:", error));

  console.log(
    `[${type.toUpperCase()}]${
      accountId
        ? ` [${accountId}]`
        : ""
    } ${message}`
  );
}

/* =========================================================
   GET LOGS
========================================================= */

export function getLogs(
  accountId?: string
) {
  return logs
    .filter(
      (log) =>
        !accountId ||
        log.accountId === accountId
    )
    .slice(0, 100);
}


/* =========================================================
   CONVERSATION MEMORY
========================================================= */

export type MessageRole = "user" | "assistant";

export interface ConversationMessage {
  id: string;
  accountId: string;
  jid: string;
  role: MessageRole;
  text: string;
  time: string;
}

export interface ContactState {
  id?: string;
  accountId: string;
  jid: string;
  aiEnabled: boolean;
  humanTakeover: boolean;
  stage: "new" | "interested" | "ready_to_buy" | "ordered" | "completed" | "lost";
  notes: string;
  updatedAt: string;
}

export interface BusinessProfile {
  accountId: string;
  businessName: string;
  description: string;
  location: string;
  currency: string;
  phone: string;
  workingHours: string;
  website: string;
  salesBehavior: "helpful" | "minimal" | "proactive";
  updatedAt: string;
}

export interface Order {
  id: string;
  accountId: string;
  jid: string;
  customerName: string;
  product: string;
  productId: string | null;
  quantity: number;
  unitPrice: string;
  totalPrice: string;
  status: "pending" | "confirmed" | "processing" | "completed" | "cancelled";
  paymentStatus: "pending" | "paid" | "failed" | "refunded";
  fulfillmentStatus: "unfulfilled" | "processing" | "shipped" | "delivered" | "failed";
  delivery: { name: string; phone: string; area: string; address: string; instructions: string };
  notes: string;
  source: "manual" | "ai";
  idempotencyKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductAction {
  type: "add_to_cart" | "view_product" | "more_photos" | "buy_now" | "contact_seller";
  label: string;
  enabled: boolean;
}

export interface KnowledgeItem {
  id: string;
  accountId: string;
  type: "product" | "document" | "link" | "general";
  title: string;
  description: string;
  price: string | null;
  imageUrl: string | null;
  imageUrls: string[];
  productUrl: string | null;
  fileUrl: string | null;
  actions: ProductAction[];
  category: string | null;
  tags: string[];
  available: boolean;
  stock: number | null;
  sku: string | null;
  variants: Array<{ id: string; name: string; price: string | null; stock: number | null; sku: string | null }>;
  createdAt: string;
  updatedAt: string;
}

const MEMORY_FILE = path.join(DATA_DIR, "memory.json");
const CONTACTS_FILE = path.join(DATA_DIR, "contact-states.json");
const KNOWLEDGE_FILE = path.join(DATA_DIR, "knowledge.json");
const BUSINESS_FILE = path.join(DATA_DIR, "business-profiles.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const CARTS_FILE = path.join(DATA_DIR, "carts.json");

export interface CartItem {
  productId: string;
  title: string;
  quantity: number;
  unitPrice: string;
  imageUrl: string | null;
  variantId?: string | null;
}

export interface Cart {
  id: string;
  accountId: string;
  jid: string;
  customerName: string;
  items: CartItem[];
  checkoutToken: string;
  checkoutTokenCreatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

const memory: ConversationMessage[] = [];
const contactStates = new Map<string, ContactState>();
const knowledge = new Map<string, KnowledgeItem>();
const businessProfiles = new Map<string, BusinessProfile>();
const orders = new Map<string, Order>();
const carts = new Map<string, Cart>();

function makeId() {
  return crypto.randomUUID();
}

function loadJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    console.error(`Failed to load ${file}:`, error);
    return fallback;
  }
}

function saveJson(file: string, value: unknown) {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
  } catch (error) {
    console.error(`Failed to save ${file}:`, error);
  }
}

function loadMemoryData() {
  const savedMessages = loadJson<ConversationMessage[]>(MEMORY_FILE, []);
  memory.push(...savedMessages.slice(-10000));

  const savedContacts = loadJson<ContactState[]>(CONTACTS_FILE, []);
  for (const item of savedContacts) {
    contactStates.set(`${item.accountId}:${item.jid}`, item);
  }

  const savedKnowledge = loadJson<KnowledgeItem[]>(KNOWLEDGE_FILE, []);
  for (const item of savedKnowledge) {
    item.imageUrls = Array.isArray(item.imageUrls) ? item.imageUrls : (item.imageUrl ? [item.imageUrl] : []);
    item.stock = typeof item.stock === "number" && Number.isFinite(item.stock) ? Math.max(0, Math.floor(item.stock)) : null;
    item.sku = item.sku ? String(item.sku) : null;
    item.variants = Array.isArray(item.variants) ? item.variants : [];
    item.actions = Array.isArray(item.actions) ? item.actions : defaultProductActions();
    knowledge.set(item.id, item);
  }

  const savedBusiness = loadJson<BusinessProfile[]>(BUSINESS_FILE, []);
  for (const item of savedBusiness) {
    businessProfiles.set(item.accountId, item);
  }

  const savedOrders = loadJson<Order[]>(ORDERS_FILE, []);
  for (const item of savedOrders) {
    item.paymentStatus = item.paymentStatus || "pending";
    item.fulfillmentStatus = item.fulfillmentStatus || "unfulfilled";
    item.delivery = item.delivery || { name: item.customerName || "", phone: "", area: "", address: "", instructions: "" };
    orders.set(item.id, item);
  }
  const savedCustomers = loadJson<CustomerProfile[]>(CUSTOMERS_FILE, []);
  for (const item of savedCustomers) customers.set(`${item.accountId}:${item.jid}`, item);
}

export function addConversationMessage(
  accountId: string,
  jid: string,
  role: MessageRole,
  text: string
) {
  const item: ConversationMessage = {
    id: makeId(),
    accountId,
    jid,
    role,
    text,
    time: new Date().toISOString(),
  };

  memory.push(item);

  // Keep the local memory bounded.
  if (memory.length > 10000) {
    memory.splice(0, memory.length - 10000);
  }

  saveJson(MEMORY_FILE, memory);
  void supabaseUpsert("wa_messages", {
    id: item.id, account_id: item.accountId, business_id: getAccount(item.accountId)?.businessId ?? null, jid: item.jid, role: item.role, text: item.text, time: item.time,
  }).catch((error) => console.error("Supabase message sync failed:", error));
  return item;
}

export function getConversationHistory(
  accountId: string,
  jid: string,
  limit = 20
) {
  return memory
    .filter((item) => item.accountId === accountId && item.jid === jid)
    .slice(-limit);
}

export function getConversationMessages(accountId: string, jid?: string) {
  return memory
    .filter((item) => item.accountId === accountId && (!jid || item.jid === jid))
    .slice(-100);
}

export function getContactAiEnabled(accountId: string, jid: string) {
  return contactStates.get(`${accountId}:${jid}`)?.aiEnabled ?? true;
}

export function setContactAiEnabled(
  accountId: string,
  jid: string,
  enabled: boolean
) {
  const item: ContactState = {
    id: `${accountId}:${jid}`,
    accountId,
    jid,
    aiEnabled: enabled,
    humanTakeover: contactStates.get(`${accountId}:${jid}`)?.humanTakeover ?? false,
    stage: contactStates.get(`${accountId}:${jid}`)?.stage ?? "new",
    notes: contactStates.get(`${accountId}:${jid}`)?.notes ?? "",
    updatedAt: new Date().toISOString(),
  };

  contactStates.set(`${accountId}:${jid}`, item);
  saveJson(CONTACTS_FILE, [...contactStates.values()]);
  void supabaseUpsert("wa_contact_states", {
    id: item.id, account_id: item.accountId, business_id: getAccount(item.accountId)?.businessId ?? null, jid: item.jid,
    ai_enabled: item.aiEnabled, human_takeover: item.humanTakeover, stage: item.stage, notes: item.notes, updated_at: item.updatedAt,
  }).catch((error) => console.error("Supabase contact sync failed:", error));
  return item;
}

export function isHumanTakeover(accountId: string, jid: string) {
  return contactStates.get(`${accountId}:${jid}`)?.humanTakeover ?? false;
}

export function setHumanTakeover(accountId: string, jid: string, enabled: boolean) {
  const key = `${accountId}:${jid}`;
  const previous = contactStates.get(key);
  const item: ContactState = {
    id: key,
    accountId,
    jid,
    aiEnabled: previous?.aiEnabled ?? true,
    humanTakeover: enabled,
    stage: previous?.stage ?? "new",
    notes: previous?.notes ?? "",
    updatedAt: new Date().toISOString(),
  };

  contactStates.set(key, item);
  saveJson(CONTACTS_FILE, [...contactStates.values()]);
  void supabaseUpsert("wa_contact_states", {
    id: item.id, account_id: item.accountId, business_id: getAccount(item.accountId)?.businessId ?? null, jid: item.jid,
    ai_enabled: item.aiEnabled, human_takeover: item.humanTakeover, stage: item.stage, notes: item.notes, updated_at: item.updatedAt,
  }).catch((error) => console.error("Supabase takeover sync failed:", error));
  return item;
}

export function getContacts(accountId: string) {
  const jids = new Set(memory.filter((m) => m.accountId === accountId).map((m) => m.jid));
  for (const item of contactStates.values()) if (item.accountId === accountId) jids.add(item.jid);
  return [...jids].map((jid) => {
    const messages = memory.filter((m) => m.accountId === accountId && m.jid === jid);
    const lastMessage = messages.at(-1) || null;
    const state = contactStates.get(`${accountId}:${jid}`);
    return {
      jid,
      aiEnabled: getContactAiEnabled(accountId, jid),
      humanTakeover: isHumanTakeover(accountId, jid),
      stage: state?.stage ?? "new",
      notes: state?.notes ?? "",
      messageCount: messages.length,
      lastActivityAt: lastMessage?.time || state?.updatedAt || null,
      lastMessage,
    };
  }).sort((a, b) => String(b.lastActivityAt || "").localeCompare(String(a.lastActivityAt || "")));
}

export function getKnowledge(accountId: string) {
  return [...knowledge.values()].filter((item) => item.accountId === accountId);
}

export function searchKnowledge(
  accountId: string,
  query: string,
  limit = 5
) {
  const stopWords = new Set([
    "na", "ya", "wa", "ni", "kwa", "hii", "hiyo", "ile", "hizi", "hizo",
    "mna", "mnazo", "ipo", "zipo", "bei", "gani", "ngapi", "tafadhali", "please",
    "show", "me", "the", "is", "are", "do", "you", "have", "your", "what", "how",
    "i", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "this", "that"
  ]);

  const aliases: Record<string, string[]> = {
    nguo: ["clothes", "dress", "shirt", "hoodie", "trouser", "fashion", "wear"],
    viatu: ["shoes", "sneakers", "boots", "sandals"],
    simu: ["phone", "smartphone", "iphone", "android"],
    bei: ["price", "cost", "tzs"],
    delivery: ["deliver", "shipping", "delivery"],
  };

  const rawTerms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && !stopWords.has(x));

  const expanded = new Set(rawTerms);
  for (const term of rawTerms) {
    for (const alias of aliases[term] || []) expanded.add(alias);
  }

  if (!expanded.size) return [];

  return getKnowledge(accountId)
    .map((item) => {
      const title = item.title.toLowerCase();
      const description = item.description.toLowerCase();
      const category = (item.category || "").toLowerCase();
      const tags = item.tags.join(" ").toLowerCase();
      const haystack = `${title} ${description} ${category} ${tags} ${item.price || ""}`;

      let score = 0;
      for (const term of expanded) {
        if (title.split(/\s+/).includes(term)) score += 5;
        else if (title.includes(term)) score += 4;
        else if (category.includes(term)) score += 3;
        else if (tags.includes(term)) score += 3;
        else if (description.includes(term)) score += 1;
        else if (haystack.includes(term)) score += 1;
      }

      // Strongly prefer products over generic documents/links for product-like questions.
      if (item.type === "product" && score > 0) score += 2;
      if (!item.available && item.type === "product") score -= 0.5;

      return { item, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item);
}

export function defaultProductActions(): ProductAction[] {
  return [
    { type: "add_to_cart", label: "🛒 Add to Cart", enabled: true },
    { type: "view_product", label: "🔗 View Product", enabled: true },
    { type: "more_photos", label: "📸 More Photos", enabled: true },
  ];
}

export function createKnowledgeItem(
  accountId: string,
  data: Omit<KnowledgeItem, "id" | "accountId" | "createdAt" | "updatedAt">
) {
  const now = new Date().toISOString();

  const item: KnowledgeItem = {
    ...data,
    imageUrls: Array.isArray(data.imageUrls) ? data.imageUrls : (data.imageUrl ? [data.imageUrl] : []),
    actions: Array.isArray(data.actions) ? data.actions : defaultProductActions(),
    stock: typeof data.stock === "number" && Number.isFinite(data.stock) ? Math.max(0, Math.floor(data.stock)) : null,
    sku: data.sku ? String(data.sku) : null,
    variants: Array.isArray(data.variants) ? data.variants : [],
    id: makeId(),
    accountId,
    createdAt: now,
    updatedAt: now,
  };

  knowledge.set(item.id, item);
  saveJson(KNOWLEDGE_FILE, [...knowledge.values()]);
  void supabaseUpsert("wa_knowledge", {
    id: item.id, account_id: item.accountId, business_id: getAccount(item.accountId)?.businessId ?? null, type: item.type, title: item.title, description: item.description,
    price: item.price, image_url: item.imageUrl, image_urls: item.imageUrls, product_url: item.productUrl, file_url: item.fileUrl, actions: item.actions,
    category: item.category, tags: item.tags, available: item.available, stock: item.stock, sku: item.sku, variants: item.variants, created_at: item.createdAt, updated_at: item.updatedAt,
  }).catch((error) => console.error("Supabase knowledge sync failed:", error));
  return item;
}

export function updateKnowledgeItem(
  id: string,
  patch: Partial<Omit<KnowledgeItem, "id" | "accountId" | "createdAt" | "updatedAt">>
) {
  const item = knowledge.get(id);
  if (!item) return null;

  Object.assign(item, patch, {
    updatedAt: new Date().toISOString(),
  });

  saveJson(KNOWLEDGE_FILE, [...knowledge.values()]);
  void supabaseUpsert("wa_knowledge", {
    id: item.id, account_id: item.accountId, business_id: getAccount(item.accountId)?.businessId ?? null, type: item.type, title: item.title, description: item.description,
    price: item.price, image_url: item.imageUrl, image_urls: item.imageUrls, product_url: item.productUrl, file_url: item.fileUrl, actions: item.actions,
    category: item.category, tags: item.tags, available: item.available, stock: item.stock, sku: item.sku, variants: item.variants, created_at: item.createdAt, updated_at: item.updatedAt,
  }).catch((error) => console.error("Supabase knowledge sync failed:", error));
  return item;
}

export function deleteKnowledgeItem(id: string) {
  const deleted = knowledge.delete(id);
  if (deleted) {
    saveJson(KNOWLEDGE_FILE, [...knowledge.values()]);
    void supabaseRemove("wa_knowledge", id).catch((error) => console.error("Supabase knowledge delete failed:", error));
  }
  return deleted;
}

export function getBusinessProfile(accountId: string): BusinessProfile {
  return businessProfiles.get(accountId) || {
    accountId,
    businessName: getAccount(accountId)?.customerName || "",
    description: "",
    location: "",
    currency: "TZS",
    phone: getAccount(accountId)?.phone || "",
    workingHours: "",
    website: "",
    salesBehavior: "helpful",
    updatedAt: new Date().toISOString(),
  };
}

export function updateBusinessProfile(accountId: string, patch: Partial<Omit<BusinessProfile, "accountId" | "updatedAt">>) {
  const current = getBusinessProfile(accountId);
  const profile: BusinessProfile = { ...current, ...patch, accountId, updatedAt: new Date().toISOString() };
  businessProfiles.set(accountId, profile);
  saveJson(BUSINESS_FILE, [...businessProfiles.values()]);
  void supabaseUpsert("wa_business_profiles", {
    account_id: profile.accountId, business_id: getAccount(profile.accountId)?.businessId ?? null, business_name: profile.businessName, description: profile.description,
    location: profile.location, currency: profile.currency, phone: profile.phone, working_hours: profile.workingHours,
    website: profile.website, sales_behavior: profile.salesBehavior, updated_at: profile.updatedAt,
  }).catch((error) => console.error("Supabase business profile sync failed:", error));
  return profile;
}

export function updateContactCRM(accountId: string, jid: string, patch: Partial<Pick<ContactState, "stage" | "notes">>) {
  const key = `${accountId}:${jid}`;
  const previous = contactStates.get(key);
  const item: ContactState = {
    id: key,
    accountId,
    jid,
    aiEnabled: previous?.aiEnabled ?? true,
    humanTakeover: previous?.humanTakeover ?? false,
    stage: patch.stage ?? previous?.stage ?? "new",
    notes: patch.notes ?? previous?.notes ?? "",
    updatedAt: new Date().toISOString(),
  };
  contactStates.set(key, item);
  saveJson(CONTACTS_FILE, [...contactStates.values()]);
  void supabaseUpsert("wa_contact_states", {
    id: item.id, account_id: item.accountId, business_id: getAccount(item.accountId)?.businessId ?? null, jid: item.jid, ai_enabled: item.aiEnabled,
    human_takeover: item.humanTakeover, stage: item.stage, notes: item.notes, updated_at: item.updatedAt,
  }).catch((error) => console.error("Supabase CRM sync failed:", error));
  return item;
}

export function getOrders(accountId: string) {
  return [...orders.values()].filter((order) => order.accountId === accountId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getOrdersForAnyAccount() {
  return [...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getKnowledgeForAnyAccount() {
  return [...knowledge.values()];
}


function cartKey(accountId: string, jid: string) {
  return `${accountId}:${jid}`;
}

const CHECKOUT_TOKEN_TTL_MS = Math.max(5, Number(process.env.CHECKOUT_TOKEN_TTL_MINUTES || 60)) * 60 * 1000;

function makeCheckoutToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function getCart(accountId: string, jid: string): Cart | null {
  return carts.get(cartKey(accountId, jid)) || null;
}

export function getCartByToken(token: string): Cart | null {
  for (const cart of carts.values()) {
    if (cart.checkoutToken !== token || !cart.items.length) continue;
    const createdAt = cart.checkoutTokenCreatedAt ? Date.parse(cart.checkoutTokenCreatedAt) : Date.parse(cart.updatedAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > CHECKOUT_TOKEN_TTL_MS) {
      cart.checkoutToken = "";
      saveJson(CARTS_FILE, [...carts.values()]);
      void syncCart(cart).catch(error => console.error("Supabase cart expiry sync failed:", error));
      return null;
    }
    return cart;
  }
  return null;
}

export function createCheckoutTokenForCart(cart: Cart) {
  if (!cart.checkoutToken) { cart.checkoutToken = makeCheckoutToken(); cart.checkoutTokenCreatedAt = new Date().toISOString(); }
  cart.updatedAt = new Date().toISOString();
  carts.set(cartKey(cart.accountId, cart.jid), cart);
  saveJson(CARTS_FILE, [...carts.values()]);
  void syncCart(cart).catch(error => console.error("Supabase cart sync failed:", error));
  return cart.checkoutToken;
}

export function addToCart(
  accountId: string,
  jid: string,
  customerName: string,
  product: KnowledgeItem,
  quantity = 1,
  variantId: string | null = null
) {
  if (product.type !== "product" || !product.available) throw new Error("Product is unavailable.");
  const variant = variantId ? product.variants.find(v => v.id === variantId) : null;
  if (variantId && !variant) throw new Error("Selected product variant was not found.");
  const effectivePrice = variant?.price ?? product.price;
  const effectiveStock = variant?.stock ?? product.stock;
  if (effectiveStock !== null && effectiveStock < quantity) throw new Error(`Only ${effectiveStock} unit(s) are available.`);
  const unit = parseCartPrice(effectivePrice);
  if (unit === null) throw new Error("Product has no valid price.");
  quantity = Math.min(10000, Math.max(1, Math.floor(quantity)));

  const key = cartKey(accountId, jid);
  const existing = carts.get(key);
  const now = new Date().toISOString();
  const cart: Cart = existing || {
    id: makeId(), accountId, jid, customerName, items: [],
    checkoutToken: makeCheckoutToken(), checkoutTokenCreatedAt: now, createdAt: now, updatedAt: now
  };
  cart.customerName = customerName || cart.customerName;
  const line = cart.items.find((item) => item.productId === product.id);
  if (line) {
    const nextQty = line.quantity + quantity;
    if (effectiveStock !== null && nextQty > effectiveStock) throw new Error(`Only ${effectiveStock} unit(s) are available.`);
    line.quantity = Math.min(10000, nextQty);
  } else cart.items.push({
    productId: product.id, title: variant ? `${product.title} — ${variant.name}` : product.title, quantity,
    unitPrice: effectivePrice || "", imageUrl: product.imageUrl, variantId: variant?.id ?? null
  });
  cart.updatedAt = now;
  carts.set(key, cart);
  saveJson(CARTS_FILE, [...carts.values()]);
  void syncCart(cart).catch(error => console.error("Supabase cart sync failed:", error));
  return cart;
}

export function updateCartItem(accountId: string, jid: string, productId: string, quantity: number) {
  const cart = getCart(accountId, jid);
  if (!cart) return null;
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 10000) throw new Error("Quantity must be between 0 and 10000.");
  const line = cart.items.find((item) => item.productId === productId);
  if (!line) return cart;
  if (quantity === 0) cart.items = cart.items.filter((item) => item.productId !== productId);
  else {
    const product = getProduct(accountId, productId);
    if (!product || !product.available) throw new Error("Product is unavailable.");
    if (product.stock !== null && quantity > product.stock) throw new Error(`Only ${product.stock} unit(s) are available.`);
    line.quantity = quantity;
  }
  cart.updatedAt = new Date().toISOString();
  saveJson(CARTS_FILE, [...carts.values()]);
  void syncCart(cart).catch(error => console.error("Supabase cart sync failed:", error));
  return cart;
}

export function clearCart(accountId: string, jid: string) {
  const cart = getCart(accountId, jid);
  if (!cart) return null;
  cart.items = [];
  // Rotate the bearer token after checkout so a previously shared URL can never
  // become the token for a future cart on the same customer/account pair.
  cart.checkoutToken = makeCheckoutToken();
  cart.checkoutTokenCreatedAt = new Date().toISOString();
  cart.updatedAt = new Date().toISOString();
  saveJson(CARTS_FILE, [...carts.values()]);
  void syncCart(cart).catch(error => console.error("Supabase cart sync failed:", error));
  return cart;
}

function parseCartPrice(value: string | null) {
  if (!value) return null;
  const n = Number(value.replace(/,/g, "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function cartTotal(cart: Cart) {
  return cart.items.reduce((sum, item) => {
    const price = parseCartPrice(item.unitPrice) || 0;
    return sum + price * item.quantity;
  }, 0);
}

const checkoutLocks = new Set<string>();

export function createOrdersFromCart(
  cart: Cart,
  delivery: { name: string; phone: string; area: string; address: string; instructions: string; paymentMethod: string; idempotencyKey?: string }
) {
  if (!cart.items.length) throw new Error("Cart is empty.");
  const lockKey = `${cart.accountId}:${cart.jid}`;
  if (checkoutLocks.has(lockKey)) throw new Error("Checkout is already being processed. Please wait a moment.");
  checkoutLocks.add(lockKey);
  try {
    const freshCart = validateCart(cart.accountId, cart.jid);
    const idem = delivery.idempotencyKey?.trim().slice(0, 128) || null;
    if (idem) {
      const existing = [...orders.values()].filter(o => o.accountId === cart.accountId && o.idempotencyKey === idem && o.jid === cart.jid);
      if (existing.length) {
        return { checkoutId: existing[0].notes.match(/"checkoutId":"([^"]+)"/)?.[1] || `ZT-${Date.now().toString(36).toUpperCase()}`, orders: existing, total: existing.reduce((sum,o)=>sum + (parseCartPrice(o.unitPrice)||0)*o.quantity,0), duplicate: true };
      }
    }
    const created: Order[] = [];
    const checkoutId = `ZT-${Date.now().toString(36).toUpperCase()}`;
    const total = cartTotal(freshCart);

    // Validate every item before mutating stock, avoiding partial reservations.
    for (const item of freshCart.items) {
      const product = getProduct(freshCart.accountId, item.productId);
      if (!product || !product.available) throw new Error(`${item.title} is no longer available.`);
      const variant = item.variantId ? product.variants.find(v => v.id === item.variantId) : null;
      if (item.variantId && !variant) throw new Error(`${product.title} variant is no longer available.`);
      const availableStock = variant?.stock ?? product.stock;
      if (availableStock !== null && availableStock < item.quantity) throw new Error(`${product.title} only has ${availableStock} unit(s) left.`);
    }
    for (const item of freshCart.items) {
      const product = getProduct(freshCart.accountId, item.productId)!;
      const variant = item.variantId ? product.variants.find(v => v.id === item.variantId) : null;
      if (variant && variant.stock !== null) {
        variant.stock -= item.quantity;
        if (variant.stock === 0) product.variants = product.variants.map(v => v.id === variant.id ? { ...v, stock: 0 } : v);
        updateKnowledgeItem(product.id, { variants: product.variants });
      } else if (product.stock !== null) {
        product.stock -= item.quantity;
        if (product.stock === 0) product.available = false;
        updateKnowledgeItem(product.id, { stock: product.stock, available: product.available });
      }
    }
    for (const item of freshCart.items) {
      const unit = parseCartPrice(item.unitPrice) || 0;
      const order = createOrder(freshCart.accountId, {
        jid: cart.jid, customerName: delivery.name, product: item.title, productId: item.productId,
        quantity: item.quantity, unitPrice: item.unitPrice, totalPrice: formatCartMoney(unit * item.quantity),
        status: "pending", paymentStatus: "pending", fulfillmentStatus: "unfulfilled",
        delivery: { name: delivery.name, phone: delivery.phone, area: delivery.area, address: delivery.address, instructions: delivery.instructions },
        notes: JSON.stringify({ checkoutId, delivery: { name: delivery.name, phone: delivery.phone, area: delivery.area, address: delivery.address, instructions: delivery.instructions, paymentMethod: delivery.paymentMethod }, cartTotal: formatCartMoney(total) }),
        source: "ai", idempotencyKey: idem
      });
      created.push(order);
    }
    clearCart(freshCart.accountId, freshCart.jid);
    return { checkoutId, orders: created, total };
  } finally {
    checkoutLocks.delete(lockKey);
  }
}
function formatCartMoney(n: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

export function createOrder(accountId: string, data: Omit<Order, "id" | "accountId" | "createdAt" | "updatedAt">) {
  const now = new Date().toISOString();
  const order: Order = { ...data, id: makeId(), accountId, createdAt: now, updatedAt: now };
  orders.set(order.id, order);
  saveJson(ORDERS_FILE, [...orders.values()]);
  void supabaseUpsert("wa_orders", {
    id: order.id, account_id: order.accountId, business_id: getAccount(order.accountId)?.businessId ?? null, jid: order.jid, customer_name: order.customerName,
    product: order.product, product_id: order.productId, quantity: order.quantity, unit_price: order.unitPrice, total_price: order.totalPrice,
    status: order.status, payment_status: order.paymentStatus, fulfillment_status: order.fulfillmentStatus, delivery: order.delivery, notes: order.notes, source: order.source, idempotency_key: order.idempotencyKey ?? null, created_at: order.createdAt, updated_at: order.updatedAt,
  }).catch((error) => console.error("Supabase order sync failed:", error));
  return order;
}

export function updateOrder(id: string, patch: Partial<Omit<Order, "id" | "accountId" | "createdAt" | "updatedAt">>) {
  const order = orders.get(id);
  if (!order) return null;
  const nextStatus = patch.status || order.status;
  const transitions: Record<Order["status"], Order["status"][]> = {
    pending: ["pending", "confirmed", "cancelled"],
    confirmed: ["confirmed", "processing", "cancelled"],
    processing: ["processing", "completed", "cancelled"],
    completed: ["completed"],
    cancelled: ["cancelled"],
  };
  if (!transitions[order.status].includes(nextStatus)) throw new Error(`Invalid order status transition: ${order.status} -> ${nextStatus}`);
  Object.assign(order, patch, { updatedAt: new Date().toISOString() });
  saveJson(ORDERS_FILE, [...orders.values()]);
  void supabaseUpsert("wa_orders", {
    id: order.id, account_id: order.accountId, business_id: getAccount(order.accountId)?.businessId ?? null, jid: order.jid, customer_name: order.customerName,
    product: order.product, product_id: order.productId, quantity: order.quantity, unit_price: order.unitPrice, total_price: order.totalPrice,
    status: order.status, payment_status: order.paymentStatus, fulfillment_status: order.fulfillmentStatus, delivery: order.delivery, notes: order.notes, source: order.source, idempotency_key: order.idempotencyKey ?? null, created_at: order.createdAt, updated_at: order.updatedAt,
  }).catch((error) => console.error("Supabase order update failed:", error));
  return order;
}

async function syncAccount(account: Account) {
  await supabaseUpsert("wa_accounts", {
    id: account.id, business_id: account.businessId, customer_name: account.customerName, phone: account.phone, status: account.status,
    bot_enabled: account.botEnabled, bot_online: account.botOnline, model: account.model, prompt: account.prompt,
    created_at: account.createdAt, last_seen_at: account.lastSeenAt, messages_received: account.messagesReceived,
    messages_sent: account.messagesSent, ai_requests: account.aiRequests, last_message: account.lastMessage,
  });
}


export async function hydrateStateFromSupabase() {
  try {
    const [savedAccounts, savedKnowledge, savedOrders, savedCustomers, savedProfiles, savedContacts, savedMessages] = await Promise.all([
      supabaseList<any>("wa_accounts", "select=*&order=created_at.asc"),
      supabaseList<any>("wa_knowledge", "select=*&order=created_at.asc"),
      supabaseList<any>("wa_orders", "select=*&order=created_at.asc"),
      supabaseList<any>("wa_customers", "select=*&order=updated_at.asc"),
      supabaseList<any>("wa_business_profiles", "select=*&order=updated_at.asc"),
      supabaseList<any>("wa_contact_states", "select=*&order=updated_at.asc"),
      supabaseList<any>("wa_messages", "select=*&order=time.asc"),
    ]);

    for (const a of savedAccounts || []) {
      const account: Account = {
        id: String(a.id), businessId: a.business_id || null, customerName: String(a.customer_name || ""), phone: String(a.phone || ""),
        status: "disconnected", botEnabled: a.bot_enabled !== false, botOnline: false, qrDataUrl: null, pairingCode: null,
        model: String(a.model || process.env.GEMINI_MODEL || "gemini-2.5-flash"), prompt: String(a.prompt || defaultPrompt()),
        createdAt: String(a.created_at || new Date().toISOString()), lastSeenAt: a.last_seen_at || null,
        messagesReceived: Number(a.messages_received || 0), messagesSent: Number(a.messages_sent || 0), aiRequests: Number(a.ai_requests || 0), lastMessage: a.last_message || null,
      };
      accounts.set(account.id, account);
    }
    for (const k of savedKnowledge || []) {
      const item: KnowledgeItem = {
        id:String(k.id), accountId:String(k.account_id), type:k.type || "product", title:String(k.title||""), description:String(k.description||""), price:k.price||null,
        imageUrl:k.image_url||null, imageUrls:Array.isArray(k.image_urls)?k.image_urls:(k.image_url?[k.image_url]:[]), productUrl:k.product_url||null, fileUrl:k.file_url||null,
        actions:Array.isArray(k.actions)?k.actions:defaultProductActions(), category:k.category||null, tags:Array.isArray(k.tags)?k.tags:[], available:k.available !== false, stock:typeof k.stock === "number"?k.stock:null, sku:k.sku||null, variants:Array.isArray(k.variants)?k.variants:[],
        createdAt:String(k.created_at||new Date().toISOString()), updatedAt:String(k.updated_at||new Date().toISOString())
      };
      knowledge.set(item.id,item);
    }
    for (const o of savedOrders || []) {
      const order: Order = { id:String(o.id), accountId:String(o.account_id), jid:String(o.jid||""), customerName:String(o.customer_name||""), product:String(o.product||""), productId:o.product_id||null, quantity:Number(o.quantity||1), unitPrice:String(o.unit_price||""), totalPrice:String(o.total_price||""), status:o.status||"pending", paymentStatus:o.payment_status||"pending", fulfillmentStatus:o.fulfillment_status||"unfulfilled", delivery:o.delivery||{name:String(o.customer_name||""),phone:"",area:"",address:"",instructions:""}, notes:String(o.notes||""), source:o.source||"manual", idempotencyKey:o.idempotency_key||null, createdAt:String(o.created_at||new Date().toISOString()), updatedAt:String(o.updated_at||new Date().toISOString()) };
      orders.set(order.id,order);
    }
    for (const c of savedCustomers || []) customers.set(`${c.account_id}:${c.jid}`, { accountId:String(c.account_id), jid:String(c.jid), name:String(c.name||""), phone:String(c.phone||""), area:String(c.area||""), address:String(c.address||""), instructions:String(c.instructions||""), updatedAt:String(c.updated_at||new Date().toISOString()) });
    for (const c of savedContacts || []) contactStates.set(`${c.account_id}:${c.jid}`, { id:c.id, accountId:String(c.account_id), jid:String(c.jid), aiEnabled:c.ai_enabled !== false, humanTakeover:c.human_takeover === true, stage:c.stage||"new", notes:String(c.notes||""), updatedAt:String(c.updated_at||new Date().toISOString()) });
    for (const m of savedMessages || []) memory.push({ id:String(m.id), accountId:String(m.account_id), jid:String(m.jid), role:m.role === "user" ? "user" : "assistant", text:String(m.text||""), time:String(m.time||new Date().toISOString()) });
    for (const b of savedProfiles || []) businessProfiles.set(String(b.account_id), { accountId:String(b.account_id), businessName:String(b.business_name||""), description:String(b.description||""), location:String(b.location||""), currency:String(b.currency||"TZS"), phone:String(b.phone||""), workingHours:String(b.working_hours||""), website:String(b.website||""), salesBehavior:b.sales_behavior||"helpful", updatedAt:String(b.updated_at||new Date().toISOString()) });
    console.log(`Hydrated ${accounts.size} account(s), ${knowledge.size} product/knowledge item(s), ${orders.size} order(s) from Supabase.`);
  } catch (error) {
    console.error("Supabase state hydration failed:", error);
    throw error;
  }
}

export async function syncExistingStateToSupabase() {
  for (const account of accounts.values()) {
    await supabaseUpsert("wa_accounts", {
      id: account.id, business_id: account.businessId, customer_name: account.customerName, phone: account.phone, status: account.status,
      bot_enabled: account.botEnabled, bot_online: account.botOnline, model: account.model, prompt: account.prompt,
      created_at: account.createdAt, last_seen_at: account.lastSeenAt, messages_received: account.messagesReceived,
      messages_sent: account.messagesSent, ai_requests: account.aiRequests, last_message: account.lastMessage,
    });
  }
  for (const item of knowledge.values()) {
    await supabaseUpsert("wa_knowledge", {
      id: item.id, account_id: item.accountId, business_id: getAccount(item.accountId)?.businessId ?? null, type: item.type, title: item.title, description: item.description,
      price: item.price, image_url: item.imageUrl, product_url: item.productUrl, file_url: item.fileUrl,
      category: item.category, tags: item.tags, available: item.available, stock: item.stock, sku: item.sku, variants: item.variants, image_urls: item.imageUrls, actions: item.actions, created_at: item.createdAt, updated_at: item.updatedAt,
    });
  }
  for (const item of contactStates.values()) {
    await supabaseUpsert("wa_contact_states", {
      id: item.id || `${item.accountId}:${item.jid}`, account_id: item.accountId, business_id: getAccount(item.accountId)?.businessId ?? null, jid: item.jid,
      ai_enabled: item.aiEnabled, human_takeover: item.humanTakeover, stage: item.stage, notes: item.notes, updated_at: item.updatedAt,
    });
  }
  for (const item of memory) {
    await supabaseUpsert("wa_messages", {
      id: item.id, account_id: item.accountId, business_id: getAccount(item.accountId)?.businessId ?? null, jid: item.jid, role: item.role, text: item.text, time: item.time,
    });
  }
  for (const item of logs) {
    await supabaseUpsert("wa_logs", {
      id: item.id, account_id: item.accountId, business_id: item.accountId ? getAccount(item.accountId)?.businessId ?? null : null, time: item.time, type: item.type, message: item.message,
    });
  }
  for (const item of businessProfiles.values()) {
    await supabaseUpsert("wa_business_profiles", {
      account_id: item.accountId, business_id: getAccount(item.accountId)?.businessId ?? null, business_name: item.businessName, description: item.description,
      location: item.location, currency: item.currency, phone: item.phone, working_hours: item.workingHours,
      website: item.website, sales_behavior: item.salesBehavior, updated_at: item.updatedAt,
    }, "account_id");
  }
  for (const item of orders.values()) {
    await supabaseUpsert("wa_orders", {
      id: item.id, account_id: item.accountId, business_id: getAccount(item.accountId)?.businessId ?? null, jid: item.jid, customer_name: item.customerName,
      product: item.product, product_id: item.productId, quantity: item.quantity, unit_price: item.unitPrice, total_price: item.totalPrice,
      status: item.status, notes: item.notes, source: item.source, created_at: item.createdAt, updated_at: item.updatedAt,
    });
  }
  for (const item of customers.values()) await syncCustomer(item);
  for (const item of carts.values()) await syncCart(item);
}


async function syncCustomer(item: CustomerProfile) {
  await supabaseUpsert("wa_customers", { id:`${item.accountId}:${item.jid}`, account_id:item.accountId, business_id:getAccount(item.accountId)?.businessId ?? null, jid:item.jid, name:item.name, phone:item.phone, area:item.area, address:item.address, instructions:item.instructions, updated_at:item.updatedAt });
}

async function syncCart(item: Cart) {
  await supabaseUpsert("wa_carts", { id:item.id, account_id:item.accountId, business_id:getAccount(item.accountId)?.businessId ?? null, jid:item.jid, customer_name:item.customerName, items:item.items, checkout_token:item.checkoutToken, checkout_token_created_at:item.checkoutTokenCreatedAt ?? null, created_at:item.createdAt, updated_at:item.updatedAt });
}

export interface CustomerProfile {
  accountId: string;
  jid: string;
  name: string;
  phone: string;
  area: string;
  address: string;
  instructions: string;
  updatedAt: string;
}

const CUSTOMERS_FILE = path.join(DATA_DIR, "customers.json");
const customers = new Map<string, CustomerProfile>();

export function getCustomer(accountId: string, jid: string): CustomerProfile {
  return customers.get(`${accountId}:${jid}`) || { accountId, jid, name: "", phone: jid.split("@")[0] || "", area: "", address: "", instructions: "", updatedAt: new Date().toISOString() };
}

export function updateCustomer(accountId: string, jid: string, patch: Partial<Omit<CustomerProfile, "accountId"|"jid"|"updatedAt">>) {
  const current = getCustomer(accountId, jid);
  const next = { ...current, ...patch, accountId, jid, updatedAt: new Date().toISOString() };
  customers.set(`${accountId}:${jid}`, next);
  saveJson(CUSTOMERS_FILE, [...customers.values()]);
  void syncCustomer(next).catch(error => console.error("Supabase customer sync failed:", error));
  return next;
}

export function searchProducts(accountId: string, query: string, limit = 6) {
  return searchKnowledge(accountId, query, Math.min(8, Math.max(1, limit))).filter(x => x.type === "product");
}

export function getProduct(accountId: string, productId: string) {
  return getKnowledge(accountId).find(x => x.id === productId && x.type === "product") || null;
}

export function validateCart(accountId: string, jid: string) {
  const cart = getCart(accountId, jid);
  if (!cart || !cart.items.length) throw new Error("Cart is empty.");
  const refreshed: Cart = { ...cart, items: cart.items.map(item => ({...item})) };
  for (const item of refreshed.items) {
    const product = getProduct(accountId, item.productId);
    if (!product || !product.available) throw new Error(`${item.title} is no longer available.`);
    const variant = item.variantId ? product.variants.find(v => v.id === item.variantId) : null;
    if (item.variantId && !variant) throw new Error(`${product.title} variant is no longer available.`);
    const effectivePrice = variant?.price ?? product.price;
    const effectiveStock = variant?.stock ?? product.stock;
    const unit = parseCartPrice(effectivePrice);
    if (unit === null) throw new Error(`${product.title} has no valid price.`);
    if (effectiveStock !== null && item.quantity > effectiveStock) throw new Error(`${product.title} only has ${effectiveStock} unit(s) left.`);
    item.title = variant ? `${product.title} — ${variant.name}` : product.title; item.unitPrice = effectivePrice || ""; item.imageUrl = product.imageUrl;
  }
  refreshed.updatedAt = new Date().toISOString();
  carts.set(cartKey(accountId, jid), refreshed);
  saveJson(CARTS_FILE, [...carts.values()]);
  return refreshed;
}

export function buildCheckoutSummary(token: string) {
  const cart = getCartByToken(token);
  if (!cart) return null;
  const account = getAccount(cart.accountId);
  const business = getBusinessProfile(cart.accountId);
  return { cart, total: cartTotal(cart), currency: business.currency || "TZS", business, customer: getCustomer(cart.accountId, cart.jid), accountId: cart.accountId };
}

/* =========================================================
   INITIALIZE
========================================================= */
loadMemoryData();

loadData();