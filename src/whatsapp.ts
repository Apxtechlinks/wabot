import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import path from "node:path";

import { generateSalesReply } from "./gemini.js";

import {
  addLog,
  getAccount,
  inc,
  lastMessage,
  setConnection,
  updateAccount,
  addConversationMessage,
  getConversationHistory,
  getContactAiEnabled,
  setContactAiEnabled,
  isHumanTakeover,
  searchKnowledge,
  searchProducts,
  getProduct,
  addToCart,
  updateCartItem,
  getCustomer,
  createCheckoutTokenForCart,
  getBusinessProfile,
  getOrders,
  updateContactCRM,
  getCart,
  cartTotal,
} from "./state.js";

/* =========================================================
   CONFIG
========================================================= */

const AUTH_ROOT = path.resolve(process.env.WA_AUTH_DIR || "./auth_info_baileys");

const sockets = new Map<
  string,
  WASocket
>();

const reconnectTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

const starting = new Set<string>();

const pairingRequests = new Set<string>();

// Baileys can redeliver a message during reconnects. Keep a bounded set of
// processed message IDs so one customer message cannot trigger two AI replies
// or two orders.
const processedMessageIds = new Set<string>();

// Serialize AI work per customer chat so rapid WhatsApp messages cannot race
// each other or produce conflicting carts/orders. Every message is preserved.
const chatQueues = new Map<string, Promise<void>>();

function enqueueChatMessage(accountId: string, message: WAMessage) {
  const jid = message.key.remoteJid;
  if (!jid) return;
  const key = `${accountId}:${jid}`;
  const run = (chatQueues.get(key) || Promise.resolve())
    .then(() => handleIncomingMessage(accountId, message))
    .catch(error => {
      addLog("error", `Queued WhatsApp message failed: ${error instanceof Error ? error.message : String(error)}`, accountId);
    });
  chatQueues.set(key, run);
  void run.finally(() => { if (chatQueues.get(key) === run) chatQueues.delete(key); });
}

const reconnectAttempts = new Map<string, number>();

/* =========================================================
   HELPERS
========================================================= */

function normalizePhone(
  phone: string
) {
  return phone.replace(/\D/g, "");
}

function extractText(
  message: WAMessage
): string | null {
  const content = message.message;

  if (!content) {
    return null;
  }

  if (content.conversation) {
    return (
      content.conversation.trim() ||
      null
    );
  }

  if (
    content.extendedTextMessage?.text
  ) {
    return (
      content.extendedTextMessage.text.trim() ||
      null
    );
  }

  const ephemeral =
    content.ephemeralMessage?.message;

  if (ephemeral?.conversation) {
    return (
      ephemeral.conversation.trim() ||
      null
    );
  }

  if (
    ephemeral?.extendedTextMessage?.text
  ) {
    return (
      ephemeral.extendedTextMessage.text.trim() ||
      null
    );
  }

  return null;
}


function extractQuantity(text: string, productTitle = "") {
  const lower = text.toLowerCase();

  // Prefer explicit quantity phrases. This avoids interpreting product model
  // numbers such as "iPhone 15" or "S24" as quantities.
  const explicitNumber = lower.match(/\b(?:qty|quantity|x|pcs?|pieces?|units?|items?|idadi|vipande)\s*[:=]?\s*(\d+)\b/i);
  if (explicitNumber) return Math.max(1, Number(explicitNumber[1]));

  const beforeProduct = productTitle
    ? lower.split(productTitle.toLowerCase())[0]
    : lower;
  const contextualNumber = beforeProduct.match(/\b(?:naomba|nataka|chukua|nipe|order|buy|take|nunulie)\s+(\d+)\b/i);
  if (contextualNumber) return Math.max(1, Number(contextualNumber[1]));

  const wordQuantities: Record<string, number> = {
    moja: 1, mbili: 2, matatu: 3, nne: 4, tano: 5, sita: 6, saba: 7,
    nane: 8, tisa: 9, kumi: 10, one: 1, two: 2, three: 3, four: 4, five: 5
  };
  const quantityWord = lower.match(/\b(?:idadi|quantity|qty|pieces?|units?|items?|naomba|nataka|chukua|nipe)\s+(moja|mbili|matatu|nne|tano|sita|saba|nane|tisa|kumi|one|two|three|four|five)\b/i);
  if (quantityWord) return wordQuantities[quantityWord[1].toLowerCase()] || 1;

  return 1;
}

function isExplicitPurchaseIntent(text: string) {
  const lower = text.toLowerCase();
  if (/(nataka kujua|nataka kuona|nataka kuangalia|show me|tell me|bei|price|how much)/i.test(lower)) return false;
  return /(naomba (?:ni)?order|naomba kuagiza|nataka kuagiza|ninaagiza|order\b|buy\b|i want to buy|i'll take|i will take|chukua|nitachukua|nitanunua|nununulie|reserve|book)/i.test(lower);
}

function parsePrice(value: string | null) {
  if (!value) return null;
  const normalized = value.replace(/,/g, "").replace(/[^0-9.]/g, "");
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatMoney(value: number, currency: string) {
  return `${currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)}`;
}


/* =========================================================
   RECONNECT
========================================================= */

function scheduleReconnect(
  accountId: string
) {
  if (reconnectTimers.has(accountId)) return;

  const attempt = (reconnectAttempts.get(accountId) || 0) + 1;
  reconnectAttempts.set(accountId, attempt);
  const delay = Math.min(60_000, 5_000 * 2 ** Math.min(attempt - 1, 4));

  addLog(
    "system",
    `Automatic reconnect scheduled in ${Math.round(delay / 1000)} seconds (attempt ${attempt}).`,
    accountId
  );

  const timer = setTimeout(() => {
    reconnectTimers.delete(accountId);
    void connectAccount(accountId).catch((error) => {
      addLog("error", `Reconnect attempt failed: ${error instanceof Error ? error.message : String(error)}`, accountId);
    });
  }, delay);

  reconnectTimers.set(
    accountId,
    timer
  );
}

/* =========================================================
   INCOMING MESSAGE
========================================================= */

async function handleIncomingMessage(
  accountId: string,
  message: WAMessage
) {
  const account = getAccount(accountId);
  if (!account) return;

  const jid = message.key.remoteJid;
  if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) return;

  const messageId = message.key.id;
  if (messageId) {
    if (processedMessageIds.has(messageId)) return;
    processedMessageIds.add(messageId);
    if (processedMessageIds.size > 5000) {
      const oldest = processedMessageIds.values().next().value;
      if (oldest) processedMessageIds.delete(oldest);
    }
  }

  const incomingText = extractText(message);
  if (!incomingText) return;

  /*
   * Owner chat commands.
   *
   * These are accepted only from the owner device (fromMe).
   * This prevents another WhatsApp contact from turning the
   * bot off for themselves.
   */
  const command = incomingText.trim().toLowerCase();

  if (message.key.fromMe && command.startsWith("/")) {
    if (command === "/off") {
      setContactAiEnabled(accountId, jid, false);
      addLog("system", `AI turned OFF for chat ${jid}.`, accountId);
      return;
    }

    if (command === "/on" || command === "/resume") {
      setContactAiEnabled(accountId, jid, true);
      addLog("system", `AI turned ON for chat ${jid}.`, accountId);
      return;
    }

    if (command === "/status") {
      addLog(
        "system",
        `Chat ${jid}: AI ${getContactAiEnabled(accountId, jid) ? "ON" : "OFF"}.`,
        accountId
      );
      return;
    }

    if (command === "/takeover" || command === "/human") {
      const state = setContactAiEnabled(accountId, jid, false);
      void state;
      const { setHumanTakeover } = await import("./state.js");
      setHumanTakeover(accountId, jid, true);
      addLog("system", `Human takeover enabled for ${jid}.`, accountId);
      return;
    }

    if (command === "/release" || command === "/ai") {
      setContactAiEnabled(accountId, jid, true);
      const { setHumanTakeover } = await import("./state.js");
      setHumanTakeover(accountId, jid, false);
      addLog("system", `AI control restored for ${jid}.`, accountId);
      return;
    }

    if (command === "/help") {
      addLog("system", "Commands: /on, /off, /status, /takeover, /release. Commands are owner-only.", accountId);
      return;
    }
  }

  /*
   * Never let our own normal messages enter the AI loop.
   */
  if (message.key.fromMe) return;

  if (!account.botEnabled) return;

  /*
   * Per-chat AI switch.
   */
  if (!getContactAiEnabled(accountId, jid)) {
    addLog("system", `AI is OFF for ${jid}; message ignored.`, accountId);
    return;
  }

  if (isHumanTakeover(accountId, jid)) {
    addLog("system", `Human takeover is active for ${jid}; AI reply skipped.`, accountId);
    return;
  }

  inc(accountId, "messagesReceived");
  lastMessage(accountId, incomingText);
  addConversationMessage(accountId, jid, "user", incomingText);

  addLog("incoming", `${jid}: ${incomingText}`, accountId);

  try {
    const history = getConversationHistory(accountId, jid, 20);
    const business = getBusinessProfile(accountId);
    const customer = getCustomer(accountId, jid);
    const knowledgeItems = searchKnowledge(accountId, incomingText, 8);
    const businessContext = [
      business.businessName ? `Business name: ${business.businessName}` : "",
      business.description ? `Business description: ${business.description}` : "",
      business.location ? `Location: ${business.location}` : "",
      business.phone ? `Phone: ${business.phone}` : "",
      business.workingHours ? `Working hours: ${business.workingHours}` : "",
      business.website ? `Website: ${business.website}` : "",
      `Currency: ${business.currency || "TZS"}`,
      `Sales behavior: ${business.salesBehavior}`,
      customer.name ? `Known customer name: ${customer.name}` : "",
      customer.area ? `Known delivery area: ${customer.area}` : "",
      `Current cart (live): ${(() => {
        const cart = getCart(accountId, jid);
        if (!cart || !cart.items.length) return "empty";
        return cart.items.map((item: any) => `${item.productId} | ${item.title} | quantity=${item.quantity} | unitPrice=${item.unitPrice}`).join("\n");
      })()}`,
      knowledgeItems.length ? `Relevant catalog context:\n${knowledgeItems.map(i => `${i.id} | ${i.title} | ${i.price || ""} | ${i.available ? "in stock" : "out of stock"} | stock=${i.stock ?? "unknown"}`).join("\n")}` : "",
    ].filter(Boolean).join("\n");

    inc(accountId, "aiRequests");
    const toolResults: any[] = [];
    const result = await generateSalesReply({
      message: incomingText, prompt: account.prompt, model: account.model,
      history: history.filter(i => i.text !== incomingText || i.role === "assistant").map(i => ({ role: i.role === "user" ? "user" as const : "model" as const, text: i.text })),
      context: businessContext,
      executeTool: async (name, args) => {
        try {
          if (name === "search_products") {
            const products = searchProducts(accountId, String(args.query || ""), Math.min(12, Math.max(1, Number(args.max_results || 8))));
            const payload = products.map(p => ({ id:p.id,title:p.title,description:p.description,price:p.price,available:p.available,stock:p.stock,sku:p.sku,variants:p.variants,category:p.category,tags:p.tags,imageUrl:p.imageUrl,imageUrls:p.imageUrls,productUrl:p.productUrl,fileUrl:p.fileUrl,actions:p.actions }));
            return { name, response: { ok:true, products:payload }, };
          }
          if (name === "get_product") {
            const p = getProduct(accountId, String(args.product_id || ""));
            return { name, response: p ? {ok:true,product:p} : {ok:false,error:"Product not found."} };
          }
          if (name === "get_cart") {
            const cart = getCart(accountId,jid);
            return { name, response: cart ? {ok:true,cart,total:cartTotal(cart),currency:business.currency} : {ok:true,cart:null,total:0,currency:business.currency} };
          }
          if (name === "add_to_cart") {
            const p = getProduct(accountId,String(args.product_id || ""));
            if (!p) return {name,response:{ok:false,error:"Product not found."}};
            const quantity = Number(args.quantity || 1);
            const variantId = args.variant_id ? String(args.variant_id) : null;
            const cart = addToCart(accountId,jid,customer.name || jid.split("@")[0],p,quantity,variantId);
            toolResults.push({type:"cart_add",product:p,cart,total:cartTotal(cart)});
            return {name,response:{ok:true,cart,total:cartTotal(cart),currency:business.currency,added:{id:p.id,title:p.title,quantity,variantId}}};
          }
          if (name === "update_cart") {
            const cart = updateCartItem(accountId,jid,String(args.product_id || ""),Number(args.quantity));
            return {name,response:cart ? {ok:true,cart,total:cartTotal(cart),currency:business.currency} : {ok:false,error:"Cart not found."}};
          }
          if (name === "remove_from_cart") {
            const cart = updateCartItem(accountId,jid,String(args.product_id || ""),0);
            return {name,response:cart ? {ok:true,cart,total:cartTotal(cart),currency:business.currency} : {ok:false,error:"Cart not found."}};
          }
          if (name === "create_checkout") {
            const cart = getCart(accountId,jid);
            if (!cart || !cart.items.length) return {name,response:{ok:false,error:"Cart is empty."}};
            const baseUrl=(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/,"");
            const url=`${baseUrl}/checkout/${encodeURIComponent(createCheckoutTokenForCart(cart))}`;
            toolResults.push({type:"checkout",url,cart});
            return {name,response:{ok:true,url,cart,total:cartTotal(cart),currency:business.currency}};
          }
          if (name === "get_order_status") {
            const orders=getOrders(accountId).filter(o=>o.jid===jid).slice(0,5);
            return {name,response:{ok:true,orders}};
          }
          if (name === "handoff_to_human") {
            setContactAiEnabled(accountId,jid,false);
            const {setHumanTakeover}=await import("./state.js");
            setHumanTakeover(accountId,jid,true);
            return {name,response:{ok:true,message:"Human takeover enabled."}};
          }
          return {name,response:{ok:false,error:"Unknown tool."}};
        } catch (error) {
          return {name,response:{ok:false,error:error instanceof Error?error.message:String(error)}};
        }
      }
    });

    const socket=sockets.get(accountId);
    if(!socket) throw new Error("WhatsApp socket is not available.");
    if(account.status!=="connected") throw new Error("WhatsApp account is no longer connected.");
    await socket.sendMessage(jid,{text:result.text});
    addConversationMessage(accountId,jid,"assistant",result.text);
    inc(accountId,"messagesSent");
    addLog("outgoing",`${jid}: ${result.text}`,accountId);

    for (const action of toolResults) {
      if (action.type === "cart_add" && action.product?.imageUrl) {
        try {
          await socket.sendMessage(jid,{image:{url:action.product.imageUrl},caption:`🛍️ ${action.product.title}\n\n💰 ${action.product.price || "Price on request"}\n📦 ${action.product.available ? "Available" : "Unavailable"}\n\n${action.product.description || ""}`.trim()});
          addLog("outgoing",`${jid}: Product image sent for ${action.product.title}.`,accountId);
        } catch(error) { addLog("error",`Product image failed: ${error instanceof Error?error.message:String(error)}`,accountId); }
      }
      if (action.type === "checkout") {
        const cartLines=action.cart.items.map((i:any)=>`• ${i.title} × ${i.quantity} — ${i.unitPrice}`).join("\n");
        const checkoutText=`🛒 CART READY\n\n${cartLines}\n\nTotal: ${formatMoney(cartTotal(action.cart),business.currency || "TZS")}\n\n🚚 Complete delivery details and place your order:\n${action.url}`;
        await socket.sendMessage(jid,{text:checkoutText});
        addConversationMessage(accountId,jid,"assistant",checkoutText);
        addLog("outgoing",`${jid}: Checkout link sent for cart ${action.cart.id}.`,accountId);
      }
    }

    // Render structured product results separately from AI text.
    // This prevents Gemini from needing to print URLs and allows several products.
    const renderedIds = new Set<string>();
    const candidates = [
      ...toolResults.filter((x: any) => x.type === "cart_add").map((x: any) => x.product),
      ...knowledgeItems.filter((x) => x.type === "product"),
    ].filter(Boolean);

    for (const product of candidates.slice(0, 8)) {
      if (renderedIds.has(product.id)) continue;
      renderedIds.add(product.id);
      try {
        const images = Array.isArray(product.imageUrls) && product.imageUrls.length ? product.imageUrls : (product.imageUrl ? [product.imageUrl] : []);
        const caption = [
          `🛍️ ${product.title}`,
          product.price ? `💰 ${product.price}` : "💰 Price on request",
          `📦 ${product.available ? "Available" : "Currently unavailable"}`,
          product.description || "",
        ].filter(Boolean).join("\n");

        if (images.length) {
          // Send the first image as the main product card. Additional images are sent
          // separately so this works across Baileys/WhatsApp versions.
          await socket.sendMessage(jid, { image: { url: images[0] }, caption });
          for (const extra of images.slice(1, 4)) {
            await socket.sendMessage(jid, { image: { url: extra }, caption: `📸 ${product.title}` });
          }
        } else {
          await socket.sendMessage(jid, { text: caption });
        }

        const actions = Array.isArray(product.actions) ? product.actions.filter((a: any) => a?.enabled) : [];
        const actionLines = actions.map((a: any, index: number) => {
          if (a.type === "view_product" && product.productUrl) return `${index + 1}. ${a.label}: ${product.productUrl}`;
          if (a.type === "more_photos" && images.length > 1) return `${index + 1}. ${a.label}`;
          if (a.type === "add_to_cart") return `${index + 1}. ${a.label}`;
          if (a.type === "buy_now") return `${index + 1}. ${a.label}`;
          if (a.type === "contact_seller") return `${index + 1}. ${a.label}`;
          return null;
        }).filter(Boolean);
        if (actionLines.length) {
          await socket.sendMessage(jid, { text: `⚡ Chagua hatua:\n${actionLines.join("\n")}` });
        }
      } catch(error) {
        addLog("error",`Product card delivery failed for ${product.title}: ${error instanceof Error?error.message:String(error)}`,accountId);
      }
    }

  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    addLog(
      "error",
      `AI/message handling failed: ${errorMessage}`,
      accountId
    );

    try {
      const socket = sockets.get(accountId);

      if (socket && account.status === "connected") {
        await socket.sendMessage(jid, {
          text:
            "Samahani, nimepata tatizo kidogo kuwasiliana na AI. Tafadhali jaribu tena baada ya muda mfupi.",
        });
      }
    } catch (sendError) {
      addLog(
        "error",
        `Could not send fallback message: ${String(sendError)}`,
        accountId
      );
    }
  }
}

/* =========================================================
   ATTACH SOCKET
========================================================= */

function attachSocket(
  accountId: string,
  socket: WASocket,
  saveCreds: () => Promise<void>
) {
  sockets.set(
    accountId,
    socket
  );

  /*
   * Save WhatsApp authentication
   * whenever credentials change.
   */
  socket.ev.on(
    "creds.update",
    saveCreds
  );

  /*
   * CONNECTION EVENTS
   */
  socket.ev.on(
    "connection.update",
    async (update) => {
      const {
        connection,
        lastDisconnect,
        qr,
      } = update;

      /*
       * QR FALLBACK
       */
      if (qr) {
        try {
          const qrDataUrl =
            await QRCode.toDataURL(
              qr,
              {
                width: 360,
                margin: 2,
              }
            );

          updateAccount(
            accountId,
            {
              qrDataUrl,
              pairingCode: null,
            }
          );

          addLog(
            "system",
            "WhatsApp QR code is ready.",
            accountId
          );
        } catch (error) {
          addLog(
            "error",
            `QR generation failed: ${String(
              error
            )}`,
            accountId
          );
        }
      }

      /*
       * CONNECTED
       */
      if (
        connection === "open"
      ) {
        setConnection(
          accountId,
          "connected"
        );

        updateAccount(
          accountId,
          {
            qrDataUrl: null,
            pairingCode: null,
          }
        );

        pairingRequests.delete(
          accountId
        );
        reconnectAttempts.delete(accountId);

        addLog(
          "system",
          "WhatsApp connected successfully.",
          accountId
        );

        return;
      }

      /*
       * DISCONNECTED
       */
      if (
        connection === "close"
      ) {
        setConnection(
          accountId,
          "disconnected"
        );

        sockets.delete(
          accountId
        );

        pairingRequests.delete(
          accountId
        );

        const statusCode =
          (
            lastDisconnect?.error as
              | Boom
              | undefined
          )?.output
            ?.statusCode;

        const loggedOut =
          statusCode ===
          DisconnectReason.loggedOut;

        /*
         * Authentication/session was
         * permanently logged out.
         */
        if (loggedOut) {
          updateAccount(
            accountId,
            {
              qrDataUrl: null,
              pairingCode: null,
            }
          );

          addLog(
            "error",
            "WhatsApp logged out. This number must be paired again.",
            accountId
          );

          return;
        }

        /*
         * Temporary disconnect.
         */
        addLog(
          "system",
          `WhatsApp disconnected. Status code: ${
            statusCode ?? "unknown"
          }. Reconnecting automatically...`,
          accountId
        );

        scheduleReconnect(
          accountId
        );
      }
    }
  );

  /*
   * INCOMING MESSAGES
   */
  socket.ev.on(
    "messages.upsert",
    async ({
      messages,
      type,
    }) => {
      if (
        type !== "notify"
      ) {
        return;
      }

      for (const message of messages) {
        enqueueChatMessage(accountId, message);
      }
    }
  );
}

/* =========================================================
   CONNECT ACCOUNT
========================================================= */

export async function connectAccount(
  accountId: string
) {
  const account =
    getAccount(accountId);

  if (!account) {
    throw new Error(
      "Account not found."
    );
  }

  /*
   * Prevent two sockets for the
   * same account.
   */
  if (
    starting.has(accountId)
  ) {
    return;
  }

  starting.add(
    accountId
  );

  try {
    const phone =
      normalizePhone(
        account.phone
      );

    if (!phone) {
      throw new Error(
        "Invalid WhatsApp phone number."
      );
    }

    const authDirectory =
      path.join(
        AUTH_ROOT,
        phone
      );

    const {
      state,
      saveCreds,
    } =
      await useMultiFileAuthState(
        authDirectory
      );

    /*
     * If socket already exists,
     * don't create another one.
     */
    const existingSocket =
      sockets.get(accountId);

    if (existingSocket) {
      return;
    }

    setConnection(
      accountId,
      "connecting"
    );

    addLog(
      "system",
      `Starting WhatsApp connection for ${phone}...`,
      accountId
    );

    const socket =
      makeWASocket({
        auth: state,

        /*
         * We don't need terminal QR.
         * Dashboard handles QR.
         */
        printQRInTerminal: false,

        markOnlineOnConnect: false,

        syncFullHistory: false,
      });

    attachSocket(
      accountId,
      socket,
      saveCreds
    );
  } catch (error) {
    setConnection(
      accountId,
      "disconnected"
    );

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    addLog(
      "error",
      `WhatsApp startup failed: ${message}`,
      accountId
    );

    scheduleReconnect(
      accountId
    );
  } finally {
    starting.delete(
      accountId
    );
  }
}

/* =========================================================
   REQUEST PAIRING CODE
========================================================= */

export async function requestPairingCode(
  accountId: string
) {
  const account =
    getAccount(accountId);

  if (!account) {
    throw new Error(
      "Account not found."
    );
  }

  const phone =
    normalizePhone(
      account.phone
    );

  if (!phone) {
    throw new Error(
      "Invalid WhatsApp phone number."
    );
  }

  /*
   * Prevent multiple pairing requests
   * at the same time.
   */
  if (
    pairingRequests.has(
      accountId
    )
  ) {
    throw new Error(
      "A pairing request is already in progress."
    );
  }

  pairingRequests.add(
    accountId
  );

  try {
    const authDirectory =
      path.join(
        AUTH_ROOT,
        phone
      );

    const {
      state,
      saveCreds,
    } =
      await useMultiFileAuthState(
        authDirectory
      );

    /*
     * If account is already registered,
     * no pairing code is necessary.
     */
    if (
      state.creds.registered
    ) {
      throw new Error(
        "This WhatsApp number is already authenticated. Disconnect/logout the existing session before pairing again."
      );
    }

    let socket =
      sockets.get(accountId);

    /*
     * Create socket if it doesn't exist.
     */
    if (!socket) {
      setConnection(
        accountId,
        "connecting"
      );

      addLog(
        "system",
        "Creating WhatsApp session for pairing...",
        accountId
      );

      socket =
        makeWASocket({
          auth: state,

          printQRInTerminal: false,

          markOnlineOnConnect: false,

          syncFullHistory: false,
        });

      attachSocket(
        accountId,
        socket,
        saveCreds
      );
    }

    /*
     * Give Baileys time to initialize
     * the connection.
     */
    await new Promise<void>(
      (resolve) => {
        setTimeout(
          resolve,
          4000
        );
      }
    );

    /*
     * Get the currently active socket.
     */
    const activeSocket =
      sockets.get(accountId);

    if (!activeSocket) {
      throw new Error(
        "WhatsApp connection closed before the pairing code could be generated."
      );
    }

    /*
     * Request the REAL WhatsApp
     * pairing code.
     */
    addLog(
      "system",
      `Requesting WhatsApp pairing code for ${phone}...`,
      accountId
    );

    const code =
      await activeSocket.requestPairingCode(
        phone
      );

    updateAccount(
      accountId,
      {
        pairingCode: code,
        qrDataUrl: null,
      }
    );

    addLog(
      "system",
      `Pairing code generated successfully for ${phone}.`,
      accountId
    );

    return code;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    addLog(
      "error",
      `Pairing code failed: ${message}`,
      accountId
    );

    throw new Error(
      `Could not generate pairing code: ${message}`
    );
  } finally {
    pairingRequests.delete(
      accountId
    );
  }
}

/* =========================================================
   DISCONNECT ACCOUNT
========================================================= */

export function disconnectAccount(
  accountId: string
) {
  const socket =
    sockets.get(accountId);

  try {
    socket?.end(
      undefined
    );
  } catch {
    // Ignore closing errors.
  }

  sockets.delete(
    accountId
  );

  const timer =
    reconnectTimers.get(
      accountId
    );

  if (timer) {
    clearTimeout(timer);

    reconnectTimers.delete(
      accountId
    );
  }

  pairingRequests.delete(
    accountId
  );
  reconnectAttempts.delete(accountId);

  setConnection(
    accountId,
    "disconnected"
  );

  updateAccount(
    accountId,
    {
      pairingCode: null,
      qrDataUrl: null,
    }
  );

  addLog(
    "system",
    "WhatsApp connection stopped by admin.",
    accountId
  );
}

/* =========================================================
   MANUAL HUMAN MESSAGE
========================================================= */

export async function sendManualMessage(
  accountId: string,
  jid: string,
  text: string
) {
  const account = getAccount(accountId);
  if (!account) throw new Error("Account not found.");

  const socket = sockets.get(accountId);
  if (!socket || account.status !== "connected") {
    throw new Error("WhatsApp account is not connected.");
  }

  await socket.sendMessage(jid, { text });
  inc(accountId, "messagesSent");
}

export async function sendCheckoutConfirmation(
  accountId: string,
  jid: string,
  checkoutId: string,
  total: number,
  currency: string,
  orderIds: string[]
) {
  const account = getAccount(accountId);
  const socket = sockets.get(accountId);
  if (!account || !socket || account.status !== "connected") return false;
  const text = `✅ ORDER RECEIVED\n\nOrder: #${checkoutId}\n💰 Total: ${formatMoney(total, currency)}\n📦 ${orderIds.length} item${orderIds.length === 1 ? "" : "s"}\n\nYour order has been received successfully. We will send updates here on WhatsApp.`;
  await socket.sendMessage(jid, { text });
  addConversationMessage(accountId, jid, "assistant", text);
  inc(accountId, "messagesSent");
  addLog("outgoing", `${jid}: Checkout confirmation ${checkoutId} sent.`, accountId);
  return true;
}
