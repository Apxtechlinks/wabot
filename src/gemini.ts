import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";

const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY is missing. Add it to .env.");
const ai = new GoogleGenAI({ apiKey: key });

export interface GeminiHistoryItem { role: "user" | "model"; text: string; }
export interface AiToolResult { name: string; response: unknown; }

export const UNIVERSAL_SYSTEM_PROMPT = `
You are an AI commerce assistant operating inside a WhatsApp business automation system.

UNIVERSAL RULES (protected):
- Use live tools for products, prices, stock, carts and orders. Never invent business data.
- NEVER output raw image URLs, file URLs or media URLs as normal chat text.
- NEVER simulate buttons with Markdown, HTML or fake syntax. The application renders actions.
- When products are requested, retrieve MULTIPLE relevant products when useful (normally 3-8), not just one.
- Preserve structured product data such as images, multiple images, product links, files and configured actions.
- TEXT is conversation. PRODUCT_CARD/MEDIA/ACTION are rendered by the application.
- If a product has configured actions, do not invent different actions or labels.
- A cart is not an order. Never claim an order is placed until checkout submission succeeds.
- Follow the business owner's custom instructions unless they conflict with these universal rules.
- Respond mainly in natural Tanzanian Swahili when the customer uses Swahili.
- Keep WhatsApp responses concise and useful.
`;

export const SALES_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  { name: "search_products", description: "Search the catalog and return multiple relevant products. Prefer several results for comparison/discovery.", parametersJsonSchema: { type:"object", properties:{ query:{type:"string"}, max_results:{type:"integer",minimum:1,maximum:12} }, required:["query"] } },
  { name: "get_product", description: "Get one authoritative product including media and configured actions.", parametersJsonSchema: { type:"object", properties:{ product_id:{type:"string"} }, required:["product_id"] } },
  { name: "get_cart", description: "Get the current customer's cart.", parametersJsonSchema: { type:"object", properties:{} } },
  { name: "add_to_cart", description: "Add a catalog product to the current customer's cart.", parametersJsonSchema: { type:"object", properties:{ product_id:{type:"string"}, variant_id:{type:"string"}, quantity:{type:"integer",minimum:1,maximum:10000} }, required:["product_id","quantity"] } },
  { name: "update_cart", description: "Set the FINAL quantity of an existing cart item. Use 0 to remove it. IMPORTANT: phrases like 'ziwe tano', 'iwe tano', 'total iwe tano', 'make it five' mean SET the total quantity to 5. Phrases like 'ongeza mbili', 'ongeza 2', 'add two more' mean INCREASE the current quantity by 2, so first call get_cart to read the current quantity, calculate the new total, then call update_cart with that final quantity. Phrases like 'punguza moja', 'punguza 1', 'remove one' mean DECREASE the current quantity by 1, so first call get_cart and calculate the final quantity. Never pass a relative amount to update_cart; it always receives the final desired quantity.", parametersJsonSchema: { type:"object", properties:{ product_id:{type:"string"}, quantity:{type:"integer",minimum:0,maximum:10000} }, required:["product_id","quantity"] } },
  { name: "remove_from_cart", description: "Remove a product from the current customer's cart.", parametersJsonSchema: { type:"object", properties:{ product_id:{type:"string"} }, required:["product_id"] } },
  { name: "create_checkout", description: "Create/reuse checkout for the current cart. Do not create an order yet.", parametersJsonSchema: { type:"object", properties:{} } },
  { name: "get_order_status", description: "Find recent orders for the current customer.", parametersJsonSchema: { type:"object", properties:{} } },
  { name: "handoff_to_human", description: "Transfer the conversation to a human agent.", parametersJsonSchema: { type:"object", properties:{ reason:{type:"string"} }, required:["reason"] } },
];

export async function generateSalesReply(args: {
  message: string;
  prompt: string;
  model: string;
  history?: GeminiHistoryItem[];
  context?: string;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<AiToolResult>;
}) {
  const { message, prompt, model, history = [], context = "", executeTool } = args;
  const systemInstruction = `${UNIVERSAL_SYSTEM_PROMPT}

BUSINESS OWNER CUSTOM BOT INSTRUCTIONS:
${prompt}

You are the business's AI sales agent. You have tools connected to the live catalog, cart and orders.

CORE RULES:
- Use tools for real business data. Never invent prices, stock, product specifications, order IDs or delivery fees.
- If a product request is ambiguous, ask a clarifying question instead of selecting an arbitrary product.
- If the customer clearly wants to buy a product, search/inspect it and add it to cart when the product and quantity are sufficiently clear.
- Never invent stock; if stock is shown, respect it.
- Do not treat "add to cart" as a completed purchase.
- Do not create or imply payment success; payment status is controlled by the backend/provider.
- Ask for missing variant information (size/color/etc.) when variants are available.
- A cart is NOT an order. Never say an order was placed until checkout submission creates one.
- When the customer wants checkout, use create_checkout and give them the returned checkout URL.
- For cart questions, use get_cart.
- For any request to increase, decrease, set, change, make, or adjust a cart quantity, first use get_cart unless the current cart quantity is already explicitly available in the conversation/context.
- Quantity language has two meanings: "ongeza/punguza N" is RELATIVE arithmetic; "ongeza/punguza iwe/ziwe N", "iwe N", "ziwe N", "total iwe N", "make it N" is an ABSOLUTE final quantity.
- For relative changes, calculate from the current cart quantity and send the resulting FINAL quantity to update_cart.
- For absolute changes, send the requested FINAL quantity directly to update_cart.
- Examples: current quantity 2 + "ongeza 3" => update_cart quantity 5; current quantity 5 + "punguza 2" => update_cart quantity 3; current quantity 2 + "ongeza ziwe 5" => update_cart quantity 5; current quantity 5 + "punguza ziwe 3" => update_cart quantity 3.
- Never confuse "ongeza N" with "ziwe N". Do not add the requested number to the cart when the customer says "ziwe/iwe N".
- If the customer refers to a product already in the cart but the product is unclear, use get_cart and ask a concise clarification rather than changing the wrong item.
- For order tracking, use get_order_status.
- If the customer asks for a human, use handoff_to_human.
- Be concise, natural and mainly Tanzanian Swahili; follow the customer's language.
- You may mention image/media availability, but the WhatsApp media layer sends actual images separately.

${context}`;

  const contents: Content[] = [
    ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
    { role: "user", parts: [{ text: message }] },
  ];

  for (let turn = 0; turn < 6; turn++) {
    const response = await ai.models.generateContent({
      model,
      contents,
      config: { systemInstruction, temperature: 0.35, tools: [{ functionDeclarations: SALES_TOOL_DECLARATIONS }] },
    });

    const calls = response.functionCalls || [];
    if (!calls.length) {
      const text = response.text?.trim();
      if (!text) throw new Error("Gemini returned an empty response.");
      return { text, toolResults: [] as AiToolResult[] };
    }

    const results: AiToolResult[] = [];

    // IMPORTANT: Gemini 3 tool calls can contain an opaque thoughtSignature.
    // Never rebuild functionCall parts from response.functionCalls because that
    // strips the signature. Preserve the original response content parts
    // exactly as returned by Gemini when sending the tool-call turn back.
    const responseParts = response.candidates?.[0]?.content?.parts || [];
    const callParts = responseParts.filter((part: any) => part?.functionCall);

    if (!callParts.length) {
      throw new Error("Gemini returned tool calls without response content parts.");
    }

    contents.push({
      role: "model",
      parts: responseParts as any,
    });

    for (const part of callParts as any[]) {
      const call = part.functionCall;
      const result = await executeTool(
        call?.name || "",
        (call?.args || {}) as Record<string, unknown>
      );

      results.push(result);

      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: result.name,
              response: (result.response && typeof result.response === "object" && !Array.isArray(result.response) ? result.response as Record<string, unknown> : { value: result.response }),
              ...(call?.id ? { id: call.id } : {}),
            },
          },
        ],
      });
    }
  }

  throw new Error("AI tool loop exceeded its safety limit.");
}

export async function generateReply(message: string, prompt: string, model: string, history: GeminiHistoryItem[] = [], knowledgeContext = "") {
  const systemInstruction = `${prompt}\n\nKNOWLEDGE BASE INFORMATION:\n${knowledgeContext}\n\nUse this information when relevant. Do not invent business facts.\nContinue the WhatsApp conversation naturally.`;
  const contents = [...history.map(item => ({role:item.role,parts:[{text:item.text}]})), {role:"user" as const,parts:[{text:message}]}];
  const r = await ai.models.generateContent({ model, contents, config:{systemInstruction,temperature:0.7} });
  const text = r.text?.trim();
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}
