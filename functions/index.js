/**
 * Prast Farms — Cloud Functions
 *
 * `assistant` proxies the portal's chat to DeepSeek. The API key is held in
 * Google Secret Manager and injected at runtime, so it never appears in this
 * repo or in anything the browser can read.
 *
 * Set the key once:
 *   firebase functions:secrets:set DEEPSEEK_KEY --project prastfarms
 *
 * Deploy:
 *   firebase deploy --only functions --project prastfarms
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const DEEPSEEK_KEY = defineSecret("DEEPSEEK_KEY");
const GEMINI_KEY = defineSecret("GEMINI_KEY");

const REGION = "us-central1";

/**
 * Allowed callers.
 *
 * Local development uses whatever port the editor's server picks, so any
 * localhost port is permitted rather than a hand-listed few — a missing port
 * shows up in the browser as a bare "internal" error with nothing in the
 * server logs, which is painful to diagnose.
 */
const CORS_ORIGINS = [
  "https://prastfarms.com",
  "https://www.prastfarms.com",
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/[a-z0-9-]+\.web\.app$/,
  /^https:\/\/[a-z0-9-]+\.firebaseapp\.com$/,
];

// Gemini reads the receipt photo.
//
// Model names here are a moving target: gemini-2.0-flash and gemini-2.5-flash
// were both retired out from under this code. The `-latest` alias survives
// those retirements, so it leads, with a pinned model behind it in case the
// alias itself ever moves somewhere unhelpful.
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.5-flash"];
const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

// This is a two-person tool, not a public chatbot. These bounds cap both abuse
// and cost — maxInstances is the hard ceiling on concurrent spend.
const MAX_MESSAGES = 24;
const MAX_CHARS = 6000;

/**
 * Set to true once staff sign in (DEV_MODE = false in firebase-config.js).
 * While it is false the function is callable by anyone who knows the project
 * id — acceptable for testing, not for production. See README.
 */
const REQUIRE_AUTH = true;

exports.assistant = onCall(
  {
    secrets: [DEEPSEEK_KEY],
    region: "us-central1",
    maxInstances: 3,
    timeoutSeconds: 60,
    memory: "256MiB",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    if (REQUIRE_AUTH && !request.auth) {
      throw new HttpsError("unauthenticated", "Please sign in first.");
    }

    const messages = request.data?.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      throw new HttpsError("invalid-argument", "No conversation was sent.");
    }
    if (messages.length > MAX_MESSAGES) {
      throw new HttpsError("invalid-argument", "This conversation is too long — start a new one.");
    }

    const totalChars = messages.reduce((n, m) => n + String(m?.content || "").length, 0);
    if (totalChars > MAX_CHARS) {
      throw new HttpsError("invalid-argument", "This conversation is too long — start a new one.");
    }

    let response;
    try {
      response = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DEEPSEEK_KEY.value()}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages,
          temperature: 0.2,
          max_tokens: 700,
          response_format: { type: "json_object" },
        }),
      });
    } catch (err) {
      logger.error("DeepSeek request failed", err);
      throw new HttpsError("unavailable", "Could not reach the assistant. Try again.");
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      // Log the detail server-side; hand the user something readable.
      logger.error("DeepSeek returned an error", {
        status: response.status,
        detail: data?.error?.message,
      });

      if (response.status === 402) {
        throw new HttpsError("failed-precondition", "The DeepSeek account is out of credit.");
      }
      if (response.status === 429) {
        throw new HttpsError("resource-exhausted", "Too many requests — wait a moment.");
      }
      throw new HttpsError("unavailable", "The assistant is unavailable right now.");
    }

    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new HttpsError("internal", "The assistant returned an empty reply.");
    }

    return { content };
  }
);

// =============================================================================
//  readReceipt — pull details off a photo of an investor's payment receipt
// =============================================================================

const RECEIPT_PROMPT = `You are reading a photo of a payment receipt, bank transfer slip or deposit teller for Prast Farms, a Nigerian farm and real-estate investment company.

Today's date is {{TODAY}}.

Return ONLY JSON in this exact shape:
{
  "firstName": "investor's first name",
  "lastName": "investor's surname",
  "investSum": 750000,
  "investDate": "2026-07-26",
  "type": "Farm Investment",
  "reference": "transaction reference or teller number",
  "bank": "bank name",
  "confidence": "high",
  "note": "one short sentence about what you could not read"
}

Rules:
- OMIT any key you cannot actually read. Never guess a name or an amount.
- "investSum" must be a plain JSON number: no currency symbol, no commas, no quotes. Read "750,000.00" as 750000.
- "investDate" must be YYYY-MM-DD. Nigerian receipts write dates DD/MM/YYYY, so 26/07/2026 is 2026-07-26.
- "type" must be EXACTLY "Farm Investment" or "Real Estate" — nothing else. A narration mentioning poultry, chicken, pig, plantain, turkey, egg, livestock or farm means "Farm Investment". Land, rent, property, house or estate means "Real Estate". If the narration says neither, omit "type" entirely.
- "confidence" must be EXACTLY "high", "medium" or "low" — not a number.
- The investor is the SENDER or depositor. Prast Farms is the beneficiary, never the investor. If the receipt shows money going TO Prast Farms, the investor is whoever sent it.
- Write names in Title Case, not capitals. Strip titles (Mr, Mrs, Miss, Chief, Alhaji, Dr, Engr).
- If this is not a payment receipt at all, return {"confidence":"low","note":"..."} explaining what the picture shows.`;

/** Everything the model might get subtly wrong, fixed once, server-side. */
function normalizeReceipt(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  const titleCase = (s) =>
    String(s)
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
      .trim();

  const TITLES = /^(mr|mrs|miss|ms|chief|alhaji|alhaja|dr|engr|prof)\.?\s+/i;

  if (raw.firstName) out.firstName = titleCase(String(raw.firstName).replace(TITLES, ""));
  if (raw.lastName) out.lastName = titleCase(String(raw.lastName).replace(TITLES, ""));

  // Models return this as 750000, 750000.0 or "750,000.00" depending on mood.
  if (raw.investSum !== undefined && raw.investSum !== null && raw.investSum !== "") {
    const n = Number(String(raw.investSum).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) out.investSum = Math.round(n);
  }

  if (raw.investDate) {
    const s = String(raw.investDate).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime())) {
      out.investDate = s;
    }
  }

  // Constrain to the two real categories; anything else (e.g. a narration
  // string like "POULTRY FARM INVESTMENT") is mapped or dropped.
  if (raw.type) {
    const t = String(raw.type).toLowerCase();
    if (/land|rent|property|house|estate|apartment|plot/.test(t)) out.type = "Real Estate";
    else if (/farm|poultry|chicken|pig|plantain|turkey|egg|livestock|agric/.test(t)) out.type = "Farm Investment";
  }

  if (raw.reference) out.reference = String(raw.reference).trim().slice(0, 60);
  if (raw.bank) out.bank = String(raw.bank).trim().slice(0, 60);

  // Accept "high"/"medium"/"low" or a 0-1 number.
  const c = raw.confidence;
  if (typeof c === "number") out.confidence = c >= 0.85 ? "high" : c >= 0.5 ? "medium" : "low";
  else if (typeof c === "string" && ["high", "medium", "low"].includes(c.toLowerCase())) {
    out.confidence = c.toLowerCase();
  } else out.confidence = "medium";

  if (raw.note) out.note = String(raw.note).trim().slice(0, 200);

  return out;
}

exports.readReceipt = onCall(
  {
    secrets: [GEMINI_KEY],
    region: REGION,
    maxInstances: 3,
    timeoutSeconds: 120,
    memory: "512MiB",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    if (REQUIRE_AUTH && !request.auth) {
      throw new HttpsError("unauthenticated", "Please sign in first.");
    }

    const { imageBase64, mimeType } = request.data || {};

    if (!imageBase64 || typeof imageBase64 !== "string") {
      throw new HttpsError("invalid-argument", "No photo was sent.");
    }
    // Client resizes before sending; this is only a backstop.
    if (imageBase64.length > 8_000_000) {
      throw new HttpsError("invalid-argument", "That photo is too large.");
    }

    const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic"];
    const mime = allowed.includes(mimeType) ? mimeType : "image/jpeg";
    const today = new Date().toISOString().slice(0, 10);

    const body = JSON.stringify({
      contents: [
        {
          parts: [
            { text: RECEIPT_PROMPT.replace("{{TODAY}}", today) },
            { inline_data: { mime_type: mime, data: imageBase64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    });

    let lastDetail = "";

    // Walk the model list so a retired model degrades to the next one instead
    // of taking the feature down.
    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(GEMINI_URL(model, GEMINI_KEY.value()), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        const data = await res.json().catch(() => null);

        if (!res.ok) {
          lastDetail = `${model}: ${res.status} ${data?.error?.message || ""}`.slice(0, 300);
          logger.warn("Gemini model unavailable, trying next", { detail: lastDetail });
          continue;
        }

        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          lastDetail = `${model}: empty response`;
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          const m = text.match(/\{[\s\S]*\}/);
          if (!m) {
            lastDetail = `${model}: non-JSON reply`;
            continue;
          }
          parsed = JSON.parse(m[0]);
        }

        return { fields: normalizeReceipt(parsed), model };
      } catch (err) {
        lastDetail = `${model}: ${err.message}`.slice(0, 300);
        logger.warn("Gemini call threw, trying next", { detail: lastDetail });
      }
    }

    logger.error("Receipt read failed on every model", { detail: lastDetail });
    throw new HttpsError(
      "unavailable",
      "Could not read that photo. Try a clearer picture, or just type the details."
    );
  }
);

// =============================================================================
//  readStatement — pull transactions off a bank statement PDF
//
//  Returns the raw transaction list plus a proposed category set derived from
//  what actually appears in the statement, rather than a guessed chart of
//  accounts. Categorising and learning happen client-side against saved rules.
// =============================================================================

const STATEMENT_PROMPT = `You are reading a Nigerian bank statement for Prast Farms, a pig farming and real-estate investment business.

Return ONLY JSON in this exact shape:
{
  "account": {
    "bank": "", "accountName": "", "accountNumber": "",
    "periodStart": "YYYY-MM-DD", "periodEnd": "YYYY-MM-DD",
    "openingBalance": 0, "closingBalance": 0
  },
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "exactly as printed",
      "amount": 0,
      "direction": "in",
      "balance": 0,
      "counterparty": "the person or business on the other side, cleaned up",
      "suggestedCategory": "",
      "note": ""
    }
  ],
  "proposedCategories": [
    { "name": "", "direction": "in", "examples": [""] }
  ]
}

Reading rules:
- Dates on Nigerian statements are DD/MM/YYYY. 02/06/2026 is 2026-06-02.
- Amounts have thousands separators. Return plain numbers: "318,500.00" is 318500.
- A Debit column entry is direction "out". A Credit column entry is direction "in".
- Include EVERY transaction row, including small bank charges. Do not summarise or skip any.
- "balance" is the running balance printed on that row, if shown.
- "counterparty": extract the human or business name from the narration and tidy it. "TRF FRM ADAEZE C OKORO/INVESTMENT PIG FARM" gives "Adaeze C Okoro". "POS PURCHASE ANIMAL CARE FEEDS LTD IBADAN" gives "Animal Care Feeds Ltd". For bank's own charges use "Bank". Title Case, no bank codes, no reference numbers.
- "note": only if something is genuinely unclear, one short phrase. Otherwise "".

House rules from the owner (apply these):
- ANY transaction above N500,000 is a BUSINESS transaction, full stop. The owner does not use these accounts to send family gifts at that size. This applies even when the counterparty is the owner's husband, son, brother or in-law.
- Below N500,000, a transfer to a known family member may be personal.
- A large amount with NO explanatory remark is still a BUSINESS transaction. Only treat it as personal when the narration says so.
- The relationship is not the category. Money from a family member marked "part payment for land" is property revenue, not a family transfer. Read the narration first.
- Movements to or from another company with "Prast" in the name are internal transfers between the owner's own companies, never revenue.
- "Pullets" means young hens for the chicken business, so pullet payments are livestock purchases and pullet refunds offset them.
- Two people can share a surname. Never merge counterparties unless the full name matches.

Categories:
- Build "proposedCategories" from what you ACTUALLY SEE in this statement. Do not invent categories for transactions that are not there.
- Give each a short plain-English name a non-accountant would understand, its "direction" ("in" or "out"), and up to three example descriptions from this statement.
- Then set "suggestedCategory" on every transaction to one of your proposed category names.
- If a transaction genuinely does not fit any category, set suggestedCategory to "Uncategorised".
- Money received from someone who looks like an individual investing is different from money received from selling livestock — keep those separate.
- Money paid to an individual could be a salary, an investor payout, or a supplier. If the narration does not make it clear, put it in "Uncategorised" and say so in "note" — do not guess.`;

exports.readStatement = onCall(
  {
    secrets: [GEMINI_KEY],
    region: REGION,
    maxInstances: 2,
    timeoutSeconds: 540,
    memory: "1GiB",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    if (REQUIRE_AUTH && !request.auth) {
      throw new HttpsError("unauthenticated", "Please sign in first.");
    }

    const { fileBase64, mimeType } = request.data || {};

    if (!fileBase64 || typeof fileBase64 !== "string") {
      throw new HttpsError("invalid-argument", "No statement was sent.");
    }
    // ~15MB of base64. Beyond this the inline request itself starts failing.
    if (fileBase64.length > 15_000_000) {
      throw new HttpsError(
        "invalid-argument",
        "That statement is too large. Upload one month at a time."
      );
    }

    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    const mime = allowed.includes(mimeType) ? mimeType : "application/pdf";

    const body = JSON.stringify({
      contents: [
        {
          parts: [
            { text: STATEMENT_PROMPT },
            { inline_data: { mime_type: mime, data: fileBase64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        maxOutputTokens: 32768,
      },
    });

    let lastDetail = "";

    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(GEMINI_URL(model, GEMINI_KEY.value()), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        const data = await res.json().catch(() => null);

        if (!res.ok) {
          lastDetail = `${model}: ${res.status} ${data?.error?.message || ""}`.slice(0, 300);
          logger.warn("Statement model unavailable, trying next", { detail: lastDetail });
          continue;
        }

        const candidate = data?.candidates?.[0];

        // A truncated reply silently loses transactions, which would quietly
        // corrupt the books. Refuse rather than return a partial statement.
        if (candidate?.finishReason === "MAX_TOKENS") {
          throw new HttpsError(
            "resource-exhausted",
            "That statement has too many transactions to read in one go. Please upload it one month at a time."
          );
        }

        const text = candidate?.content?.parts?.[0]?.text;
        if (!text) {
          lastDetail = `${model}: empty response`;
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          lastDetail = `${model}: reply was not valid JSON (likely truncated)`;
          continue;
        }

        return buildStatementResult(parsed);
      } catch (err) {
        if (err instanceof HttpsError) throw err;
        lastDetail = `${model}: ${err.message}`.slice(0, 300);
        logger.warn("Statement call threw, trying next", { detail: lastDetail });
      }
    }

    logger.error("Statement read failed on every model", { detail: lastDetail });
    throw new HttpsError(
      "unavailable",
      "Could not read that statement. Try a clearer PDF, or one month at a time."
    );
  }
);

/** Normalise the model's output and check the numbers add up. */
function buildStatementResult(parsed) {
  const num = (v) => {
    const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const isoDate = (v) => {
    const s = String(v ?? "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
  };
  const titleCase = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
      .replace(/\s+/g, " ")
      .trim();

  const account = {
    bank: String(parsed?.account?.bank || "").trim(),
    accountName: String(parsed?.account?.accountName || "").trim(),
    accountNumber: String(parsed?.account?.accountNumber || "").trim(),
    periodStart: isoDate(parsed?.account?.periodStart),
    periodEnd: isoDate(parsed?.account?.periodEnd),
    openingBalance: num(parsed?.account?.openingBalance),
    closingBalance: num(parsed?.account?.closingBalance),
  };

  const transactions = (Array.isArray(parsed?.transactions) ? parsed.transactions : [])
    .map((t) => ({
      date: isoDate(t?.date),
      description: String(t?.description || "").trim().slice(0, 300),
      amount: Math.abs(num(t?.amount)),
      direction: t?.direction === "in" ? "in" : "out",
      balance: num(t?.balance),
      counterparty: titleCase(t?.counterparty).slice(0, 80),
      suggestedCategory: String(t?.suggestedCategory || "Uncategorised").trim().slice(0, 60),
      note: String(t?.note || "").trim().slice(0, 160),
    }))
    // A row with no date or no amount is a parsing artefact, not a transaction.
    .filter((t) => t.date && t.amount > 0);

  const proposedCategories = (Array.isArray(parsed?.proposedCategories) ? parsed.proposedCategories : [])
    .map((c) => ({
      name: String(c?.name || "").trim().slice(0, 60),
      direction: c?.direction === "in" ? "in" : "out",
      examples: (Array.isArray(c?.examples) ? c.examples : []).slice(0, 3).map((e) => String(e).slice(0, 120)),
    }))
    .filter((c) => c.name);

  // Reconciliation: opening + credits - debits should equal closing. When it
  // doesn't, rows were probably missed, and the caller should say so rather
  // than quietly importing an incomplete month.
  const totalIn = transactions.filter((t) => t.direction === "in").reduce((s, t) => s + t.amount, 0);
  const totalOut = transactions.filter((t) => t.direction === "out").reduce((s, t) => s + t.amount, 0);

  const expected = account.openingBalance + totalIn - totalOut;
  const drift = Math.round((expected - account.closingBalance) * 100) / 100;
  const checkable = Boolean(account.openingBalance || account.closingBalance);

  return {
    account,
    transactions,
    proposedCategories,
    reconciliation: {
      checkable,
      totalIn: Math.round(totalIn * 100) / 100,
      totalOut: Math.round(totalOut * 100) / 100,
      expectedClosing: Math.round(expected * 100) / 100,
      statedClosing: account.closingBalance,
      drift,
      // Tolerate sub-naira rounding only.
      balances: checkable ? Math.abs(drift) < 1 : null,
      count: transactions.length,
    },
  };
}
