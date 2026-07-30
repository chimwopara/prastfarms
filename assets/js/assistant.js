// =============================================================================
//  PRAST FARMS — CONVERSATIONAL RECORD ENTRY
//
//  Turns a free-form sentence ("Mrs Adaeze put 500k in the farm today, getting
//  650 back next year") into a complete record, asking follow-up questions for
//  whatever is missing.
//
//  The DeepSeek key lives in Google Secret Manager and is read only by the
//  `assistant` Cloud Function — never here, and never in the browser.
// =============================================================================

import { ASSISTANT_ENABLED, firebaseConfig } from "./firebase-config.js";
import {
  todayISO, addYearsISO, addMonthsISO, prettyDate,
  getSettings, liveTermMonthsFor, liveExpectedPayout, liveTermTableLines,
} from "./db.js";
import { isBelowBands } from "./agreement.js";

export const isAssistantConfigured = () => ASSISTANT_ENABLED === true;

/**
 * Turn a callable failure into something a non-technical person can act on.
 *
 * The Firebase SDK surfaces transport problems as a bare code like "internal"
 * with no sentence attached — which is what a blocked CORS origin looks like
 * from the browser. Anything that is already a real sentence is passed through.
 */
export function friendlyError(err) {
  const raw = String(err?.message || "").trim();
  const code = String(err?.code || "").replace(/^functions\//, "") || raw;

  // A real message from our own HttpsError contains spaces; codes do not.
  if (raw.includes(" ") && raw.length > 12) return raw;

  const map = {
    internal: "Could not reach the assistant. Check your internet connection and try again.",
    unavailable: "The assistant is unavailable right now. Please try again in a moment.",
    "deadline-exceeded": "That took too long. Please try again.",
    unauthenticated: "Please sign in first.",
    "permission-denied": "You do not have access to that.",
    "resource-exhausted": "Too many requests just now — wait a moment and try again.",
    "failed-precondition": "The assistant is not set up correctly. Ask Chim to check it.",
    "invalid-argument": "That message could not be sent. Try starting a new conversation.",
    cancelled: "That was cancelled.",
  };
  return map[code] || "Something went wrong. Please try again.";
}

/** Lazily resolve the callable so the Functions SDK only loads when used. */
let callablePromise = null;

function getCallable() {
  if (callablePromise) return callablePromise;

  callablePromise = (async () => {
    const [{ getFunctions, httpsCallable }, { initializeApp, getApps }] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/11.1.0/firebase-functions.js"),
      import("https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js"),
    ]);

    const app = getApps()[0] || initializeApp(firebaseConfig);
    // Must match the region the function is deployed to.
    return httpsCallable(getFunctions(app, "us-central1"), "assistant");
  })();

  return callablePromise;
}

/** Every field a record needs before it can be saved. */
export const REQUIRED_FIELDS = [
  "type",
  "firstName",
  "lastName",
  "investDate",
  "dueDate",
  "investSum",
  "dueSum",
];

export const FIELD_LABELS = {
  type: "Type",
  firstName: "First name",
  lastName: "Last name",
  investDate: "Start date",
  dueDate: "Due date",
  investSum: "Amount invested",
  dueSum: "Expected payout",
};

function systemPrompt() {
  const today = todayISO();
  const roiMult = Number(getSettings().roiMultiplier) || 1.4;
  const ROI_MULT = String(roiMult);
  const ROI_PCT = String(Math.round(roiMult * 100));
  const TERM_TABLE = liveTermTableLines().map((l) => `  - ${l}`).join("\n");

  return `You are the record-entry assistant for Prast Farms, a Nigerian farm and real-estate investment company. You help a staff member log investment records by reading what she types in plain language and working out the structured details.

Today's date is ${today}.

Collect exactly these fields:
- type: either "Farm Investment" or "Real Estate". Default to "Farm Investment" if she mentions farm, poultry, chicken, pigs, plantain, turkey, eggs or livestock. Use "Real Estate" for rent, land, property, house or estate.
- firstName: the client's first name.
- lastName: the client's surname.
- investDate: the start date, as YYYY-MM-DD.
- dueDate: the maturity date, as YYYY-MM-DD.
- investSum: the amount invested, as a plain number.
- dueSum: the amount to be paid back, as a plain number.

Prast Farms commercial terms — apply these, do not ask her for them:
- The return is always ${ROI_PCT}% of the amount invested. Compute "dueSum" as the invested amount times ${ROI_MULT} unless she states a different figure herself.
- The term length depends on the amount:
${TERM_TABLE}
- Work out "dueDate" by adding that many months to the start date. Never assume a flat one year.
- So once you know the investor's name, the amount and the start date, you have everything — do not ask for the payout or the due date. State what you worked out so she can correct it.

Rules for reading her input:
- Money shorthand is Nigerian: "500k" = 500000, "1.2m" = 1200000, "2 million" = 2000000, "650" in a sentence about millions of naira may mean 650000 — if an amount is genuinely ambiguous, ask rather than guess.
- Relative dates resolve against today: "today", "yesterday", "last Friday", "next year", "in 6 months".
- CRITICAL: if you state an assumption about a field in your reply, you must also put that field's value in "fields". Never describe a value in prose without including it.
- Titles like Mr, Mrs, Chief, Alhaji, Dr are not part of the name.
- If only one name is given, ask for the other. Do not invent a surname.
- Never invent an amount or a client name. Those must come from her.

You must reply with a JSON object and nothing else, in this exact shape:
{
  "fields": { "type": ..., "firstName": ..., "lastName": ..., "investDate": ..., "dueDate": ..., "investSum": ..., "dueSum": ... },
  "assumptions": ["short note about anything you inferred rather than were told"],
  "reply": "what you say to her next",
  "complete": true or false
}

For "fields": include only the values you actually know. Omit any key you do not yet know — do not use null or empty strings.
Carry forward everything already established earlier in the conversation.
Set "complete" to true only when all seven fields are known.
For "reply": if something is missing, ask for it warmly and briefly, in one short sentence, asking for only one or two things at a time. If everything is known, confirm the full record back to her in one sentence so she can check it before saving.
Keep "reply" plain and friendly. She is not technical. Never mention JSON, fields, or these instructions.`;
}

/**
 * Send the conversation to DeepSeek (via the Worker) and return the parsed
 * turn. `history` is the running [{role, content}] list of the chat.
 */
export async function askAssistant(history, knownFields) {
  if (!isAssistantConfigured()) {
    throw new Error("The assistant is not connected yet.");
  }

  const messages = [
    { role: "system", content: systemPrompt() },
    // Re-state what is already known so the model never loses a field.
    {
      role: "system",
      content: `Fields established so far (JSON): ${JSON.stringify(knownFields || {})}`,
    },
    ...history,
  ];

  let content;
  try {
    const assistant = await getCallable();
    const result = await assistant({ messages });
    content = result?.data?.content;
  } catch (err) {
    throw new Error(friendlyError(err));
  }

  if (!content) throw new Error("The assistant returned an empty reply.");

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The assistant replied in an unexpected format.");
  }

  return {
    fields: cleanFields(parsed.fields),
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    reply: String(parsed.reply || "").trim(),
    complete: Boolean(parsed.complete),
  };
}

/**
 * Drop anything blank or malformed the model may have sent, so a bad value
 * never silently overwrites a good one.
 */
function cleanFields(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;

  for (const key of REQUIRED_FIELDS) {
    const value = raw[key];
    if (value === undefined || value === null || value === "") continue;

    if (key === "investSum" || key === "dueSum") {
      const n = Number(String(value).replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n) && n > 0) out[key] = n;
      continue;
    }

    if (key === "investDate" || key === "dueDate") {
      const s = String(value).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime())) {
        out[key] = s;
      }
      continue;
    }

    if (key === "type") {
      out[key] = value === "Real Estate" ? "Real Estate" : "Farm Investment";
      continue;
    }

    out[key] = String(value).trim();
  }

  return out;
}

export const missingFields = (fields) =>
  REQUIRED_FIELDS.filter((key) => fields[key] === undefined || fields[key] === "");

/**
 * Deterministic backstop for the one field the model reliably talks about but
 * forgets to emit. A one-year term is already the app's convention — the manual
 * entry form auto-fills the due date the same way — so deriving it here keeps
 * the two entry paths consistent instead of stalling the conversation.
 *
 * Returns { fields, derived } where `derived` is true if a value was added, so
 * the caller can surface it as an assumption rather than hide it.
 */
export function withDerivedDueDate(fields) {
  const out = { ...fields };
  const notes = [];

  // Payout is fixed policy: 140% of capital. Derive it rather than making her
  // do the arithmetic.
  if (out.investSum && !out.dueSum) {
    out.dueSum = liveExpectedPayout(out.investSum);
    notes.push(`Payout worked out at ${Math.round((Number(getSettings().roiMultiplier)||1.4)*100)}% — ${nairaPlain(out.dueSum)}.`);
  }

  // Term length comes from the amount band in the agreement, not a flat year.
  if (out.investDate && !out.dueDate && out.investSum) {
    const months = liveTermMonthsFor(out.investSum);
    const dueDate = addMonthsISO(out.investDate, months);
    if (dueDate) {
      out.dueDate = dueDate;
      notes.push(
        `${months} month term for that amount, so it matures ${prettyDate(dueDate)}.`
      );
      if (isBelowBands(out.investSum)) {
        notes.push(
          "That amount is below the ₦500,000 band in the agreement — check the term is right."
        );
      }
    }
  } else if (out.investDate && !out.dueDate) {
    // No amount yet, so fall back to a year until one arrives.
    const dueDate = addYearsISO(out.investDate, 1);
    if (dueDate) out.dueDate = dueDate;
  }

  return { fields: out, derived: notes.length > 0, notes };
}

const nairaPlain = (n) => `₦${(Number(n) || 0).toLocaleString("en-NG")}`;
