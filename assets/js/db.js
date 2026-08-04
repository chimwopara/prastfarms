// =============================================================================
//  PRAST FARMS — FIRESTORE DATA LAYER
//  Shared by portal.html, renew.html and migrate.html.
//  You should not need to edit this file — see firebase-config.js instead.
// =============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit as fsLimit,
  serverTimestamp,
  increment,
  writeBatch,
  getCountFromServer,
  getAggregateFromServer,
  sum as fsSum,
  count as fsCount,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";

import { firebaseConfig, RECORDS_COLLECTION, PORTAL_PLANS } from "./firebase-config.js";
import { DEFAULTS } from "./agreement.js";

// --- Init --------------------------------------------------------------------

if (String(firebaseConfig.projectId).startsWith("PASTE_")) {
  console.error(
    "[Prast] Firebase is not configured yet. Open assets/js/firebase-config.js " +
      "and paste your project's config values."
  );
}

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const recordsRef = collection(db, RECORDS_COLLECTION);

export const isConfigured = () =>
  !String(firebaseConfig.projectId).startsWith("PASTE_");

// --- Record shape ------------------------------------------------------------
//  { type, firstName, lastName, investDate, dueDate, investSum, dueSum,
//    renewDate, totalYears, createdAt, updatedAt }
//  Dates are stored as 'YYYY-MM-DD' strings so they sort lexicographically,
//  which means Firestore's orderBy() gives correct chronological order.

/** Coerce whatever came in (sheet import, form) into the canonical shape. */
export function normalize(raw = {}) {
  return {
    type: raw.type || "Farm Investment",
    firstName: String(raw.firstName || "").trim(),
    lastName: String(raw.lastName || "").trim(),
    investDate: raw.investDate || "",
    dueDate: raw.dueDate || "",
    investSum: Number(raw.investSum) || 0,
    dueSum: Number(raw.dueSum) || 0,
    renewDate: raw.renewDate || "",
    totalYears: Number(raw.totalYears) || 0,
  };
}

// --- Reads -------------------------------------------------------------------

/**
 * Live subscription to every record, soonest due date first.
 * Returns an unsubscribe function.
 */
export function listenRecords(onChange, onError) {
  const q = query(recordsRef, orderBy("dueDate", "asc"));
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => {
      console.error("[Prast] records listener failed:", err);
      if (onError) onError(err);
    }
  );
}

export async function fetchRecords() {
  const snap = await getDocs(query(recordsRef, orderBy("dueDate", "asc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getRecordById(id) {
  const snap = await getDoc(doc(db, RECORDS_COLLECTION, id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

export async function countRecords() {
  const snap = await getDocs(recordsRef);
  return snap.size;
}

/**
 * Resolve the `?id=` in a renewal link.
 *
 * Links emailed before the Firebase migration carry the old Google Sheet row
 * number, not a Firestore document id. Numeric ids are therefore matched
 * against the `legacyRow` field the importer preserved.
 */
export async function resolveRecord(id) {
  if (!id) return null;

  if (/^\d+$/.test(String(id).trim())) {
    const snap = await getDocs(
      query(recordsRef, where("legacyRow", "==", Number(id)))
    );
    if (!snap.empty) {
      const d = snap.docs[0];
      return { id: d.id, ...d.data() };
    }
    return null;
  }

  return getRecordById(id);
}

// --- Writes ------------------------------------------------------------------

export async function createRecord(data) {
  const ref = await addDoc(recordsRef, {
    ...normalize(data),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Update only the fields actually supplied.
 *
 * Deliberately does NOT run the patch through normalize(): normalize fills in
 * defaults for every field, so a partial patch (say, just a corrected amount)
 * would reset renewDate to "" and totalYears to 0 and quietly destroy a
 * client's renewal history.
 */
export async function updateRecord(id, patch) {
  const ALLOWED = [
    "type",
    "firstName",
    "lastName",
    "investDate",
    "dueDate",
    "investSum",
    "dueSum",
    "renewDate",
    "totalYears",
    "paidDate",
  ];

  const out = { updatedAt: serverTimestamp() };

  for (const key of ALLOWED) {
    const value = patch[key];
    if (value === undefined) continue;

    if (key === "investSum" || key === "dueSum" || key === "totalYears") {
      out[key] = Number(value) || 0;
    } else if (key === "firstName" || key === "lastName") {
      out[key] = String(value).trim();
    } else {
      out[key] = value;
    }
  }

  await updateDoc(doc(db, RECORDS_COLLECTION, id), out);
}

export async function deleteRecord(id) {
  await deleteDoc(doc(db, RECORDS_COLLECTION, id));
}

/**
 * Roll a matured investment into a new term.
 * Bumps totalYears by one and stamps the renewal date.
 *
 * Any other editable field passed in (name, type) is written through as well,
 * so the renew form can double as a correction opportunity.
 */
export async function renewRecord(id, data) {
  const { type, firstName, lastName, investDate, dueDate, investSum, dueSum } = data;

  const patch = {
    investDate,
    dueDate,
    investSum: Number(investSum) || 0,
    dueSum: Number(dueSum) || 0,
    renewDate: todayISO(),
    totalYears: increment(1),
    updatedAt: serverTimestamp(),
  };

  if (type !== undefined) patch.type = type;
  if (firstName !== undefined) patch.firstName = String(firstName).trim();
  if (lastName !== undefined) patch.lastName = String(lastName).trim();

  await updateDoc(doc(db, RECORDS_COLLECTION, id), patch);
}

/**
 * Bulk import, used once by migrate.html.
 * Firestore batches cap at 500 writes, so this chunks automatically.
 */
export async function importRecords(records, onProgress) {
  const CHUNK = 400;
  let written = 0;

  for (let i = 0; i < records.length; i += CHUNK) {
    const slice = records.slice(i, i + CHUNK);
    const batch = writeBatch(db);

    slice.forEach((rec) => {
      const ref = doc(recordsRef);
      batch.set(ref, {
        ...normalize(rec),
        legacyRow: rec.legacyRow ?? null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    });

    await batch.commit();
    written += slice.length;
    if (onProgress) onProgress(written, records.length);
  }

  return written;
}

// --- Date helpers ------------------------------------------------------------

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

/**
 * Parse 'YYYY-MM-DD' as a LOCAL calendar date.
 *
 * `new Date('2026-07-26')` is defined to parse as UTC midnight, so formatting
 * it in a timezone behind UTC renders the previous day — which put dates one
 * day early on every invoice. Building from parts keeps the calendar date the
 * user typed, regardless of timezone.
 */
export function parseDate(iso) {
  if (!iso || typeof iso !== "string") return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Format a local Date back to 'YYYY-MM-DD' without a UTC round-trip. */
export function toISO(date) {
  if (!date || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

/** Add whole years to a 'YYYY-MM-DD' string, staying in local time. */
export function addYearsISO(iso, years = 1) {
  const d = parseDate(iso);
  if (!d) return "";
  d.setFullYear(d.getFullYear() + years);
  return toISO(d);
}

/**
 * Add whole months to a 'YYYY-MM-DD' string, staying in local time.
 * Clamps the day when the target month is shorter (31 Jan + 1 month -> 28 Feb)
 * rather than rolling into the following month.
 */
export function addMonthsISO(iso, months = 0) {
  const d = parseDate(iso);
  if (!d) return "";
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return toISO(d);
}

/** Whole months between two 'YYYY-MM-DD' strings; falls back to 12. */
export function monthsBetween(startISO, endISO) {
  const a = parseDate(startISO);
  const b = parseDate(endISO);
  if (!a || !b) return 12;
  const n = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  return n > 0 ? n : 12;
}

/** Build 'YYYY-MM-DD' from the three-box date inputs. Returns null if incomplete. */
export function partsToISO(day, month, year) {
  if (!day || !month || !year || String(year).length < 4) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

export function isoToParts(iso) {
  if (!iso || typeof iso !== "string") return { day: "", month: "", year: "" };
  const [year, month, day] = iso.split("-");
  return { day: day || "", month: month || "", year: year || "" };
}

/** Human-readable date, safe against blank/garbage values. */
export function prettyDate(iso) {
  if (!iso) return "—";
  const d = parseDate(iso);
  if (!d) return String(iso);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Whole days from today until `iso`. Negative means it already passed. */
export function daysUntil(iso) {
  const target = parseDate(iso);
  if (!target) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

/** 'paid' | 'matured' | 'due-soon' (within 30 days) | 'active' */
export function statusOf(record) {
  // A settled investment is no longer outstanding, whatever its due date says.
  if (record.paidDate) return "paid";

  const days = daysUntil(record.dueDate);
  if (days === null) return "active";
  if (days < 0) return "matured";
  if (days <= 30) return "due-soon";
  return "active";
}

// --- Formatting --------------------------------------------------------------

export function naira(n) {
  return `₦${(Number(n) || 0).toLocaleString("en-NG")}`;
}

export function fullName(record) {
  return `${record.firstName || ""} ${record.lastName || ""}`.trim() || "Unnamed";
}

// --- Derived data ------------------------------------------------------------

export function computeStats(records) {
  const stats = {
    total: records.length,
    invested: 0,
    payout: 0,
    active: 0,
    dueSoon: 0,
    matured: 0,
    paid: 0,
    farm: 0,
    realEstate: 0,
    dueSoonValue: 0,
    outstanding: 0,
  };

  records.forEach((r) => {
    const investSum = Number(r.investSum) || 0;
    const dueSum = Number(r.dueSum) || 0;

    stats.invested += investSum;
    stats.payout += dueSum;

    const status = statusOf(r);

    if (status === "paid") {
      stats.paid++;
    } else {
      // Only unsettled investments count toward what is still owed.
      stats.outstanding += dueSum;

      if (status === "matured") stats.matured++;
      else if (status === "due-soon") {
        stats.dueSoon++;
        stats.dueSoonValue += dueSum;
      } else stats.active++;
    }

    if (r.type === "Real Estate") stats.realEstate++;
    else stats.farm++;
  });

  stats.profit = stats.payout - stats.invested;
  return stats;
}

export function recordsToCSV(records) {
  const headers = [
    "Type",
    "First Name",
    "Last Name",
    "Invest Date",
    "Due Date",
    "Invested",
    "Payout",
    "Renewed On",
    "Total Years",
    "Status",
  ];

  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = records.map((r) =>
    [
      r.type,
      r.firstName,
      r.lastName,
      r.investDate,
      r.dueDate,
      r.investSum,
      r.dueSum,
      r.renewDate,
      r.totalYears,
      statusOf(r),
    ]
      .map(escape)
      .join(",")
  );

  return [headers.join(","), ...rows].join("\n");
}

// --- Paid-early ---------------------------------------------------------------

/**
 * Settle an investment ahead of its due date.
 * The record stays in the books; it just stops counting as outstanding.
 */
export async function markPaid(id, paidDate) {
  await updateDoc(doc(db, RECORDS_COLLECTION, id), {
    paidDate: paidDate || todayISO(),
    updatedAt: serverTimestamp(),
  });
}

export async function unmarkPaid(id) {
  await updateDoc(doc(db, RECORDS_COLLECTION, id), {
    paidDate: "",
    updatedAt: serverTimestamp(),
  });
}

export const isPaid = (record) => Boolean(record?.paidDate);

// --- Receipt images ----------------------------------------------------------
//  Kept in their own collection so the dashboard's live record listener never
//  drags image data down with it.

const RECEIPTS_COLLECTION = "receipts";

/**
 * Bookkeeping policy, stated by the owner:
 *
 *   "She doesn't send us gift money using these accounts, it's strictly
 *    business, for anything more than N500,000 at a time."
 *
 * So a transfer to or from a family member is only treated as a personal or
 * family movement when it is at or below this amount. Above it, the family
 * relationship is irrelevant and the transaction belongs in the business books.
 */
export const FAMILY_PERSONAL_LIMIT = 500_000;

/** Roles where the limit applies — i.e. people who could plausibly be sent a gift. */
const PERSONAL_ROLES = new Set(["family", "owner"]);

export async function saveReceiptImage(recordId, dataUrl, meta = {}) {
  await setDoc(
    doc(db, RECEIPTS_COLLECTION, recordId),
    {
      image: dataUrl,
      reference: meta.reference || "",
      bank: meta.bank || "",
      createdAt: serverTimestamp(),
    },
    { merge: true }   // never wipe a payout proof already attached
  );
}

/**
 * Proof that WE paid the investor — the other half of the story.
 * Kept in the same document as the incoming receipt so one read gets both.
 */
export async function savePayoutProof(recordId, dataUrl, meta = {}) {
  await setDoc(
    doc(db, RECEIPTS_COLLECTION, recordId),
    {
      payoutImage: dataUrl,
      payoutReference: meta.reference || "",
      payoutBank: meta.bank || "",
      payoutAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function getReceiptImage(recordId) {
  const snap = await getDoc(doc(db, RECEIPTS_COLLECTION, recordId));
  return snap.exists() ? snap.data() : null;
}

export async function deleteReceiptImage(recordId) {
  await deleteDoc(doc(db, RECEIPTS_COLLECTION, recordId)).catch(() => {});
}

/**
 * Shrink a phone photo before it goes anywhere.
 *
 * Two reasons this matters: a Firestore document is capped at ~1 MiB, and
 * Gemini charges by image size. 1400px on the long edge stays readable for
 * receipt text while landing comfortably inside both limits.
 */
export function resizeImage(file, maxEdge = 1400, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file is not an image."));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({
          dataUrl,
          base64: dataUrl.split(",")[1],
          mimeType: "image/jpeg",
          width: w,
          height: h,
          bytes: Math.round((dataUrl.length - 22) * 0.75),
        });
      };
      img.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

// =============================================================================
//  BOOKKEEPING — statements, transactions, categories, learned payee rules
// =============================================================================

const TXN_COLLECTION = "transactions";
const CATEGORY_COLLECTION = "categories";
const PAYEE_COLLECTION = "payees";
const STATEMENT_COLLECTION = "statements";

/**
 * Stable key for a payee so "TUNDE BELLO", "Tunde  Bello" and "tunde bello"
 * are the same person. Also used as the Firestore document id, so it must be
 * safe in a path.
 */
export function payeeKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "-")
    .slice(0, 80);
}

/**
 * Content hash for a transaction, used as its document id.
 *
 * Statements overlap — the same month often turns up in two exports — so
 * writing by a deterministic id makes re-importing idempotent instead of
 * doubling the books.
 */
export function txnKey(t) {
  const raw = [t.date, t.direction, Math.round(Number(t.amount) * 100), String(t.description || "").trim().toLowerCase()].join("|");
  // djb2 — short, stable, and good enough to separate distinct rows.
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
  return `${t.date}-${(h >>> 0).toString(36)}`;
}

// --- Categories --------------------------------------------------------------

export async function fetchCategories() {
  const snap = await getDocs(collection(db, CATEGORY_COLLECTION));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function listenCategories(onChange) {
  return onSnapshot(collection(db, CATEGORY_COLLECTION), (snap) =>
    onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

/** Add categories that don't already exist. Returns how many were new. */
export async function ensureCategories(list) {
  const existing = new Set((await fetchCategories()).map((c) => c.name.toLowerCase()));
  const fresh = list.filter((c) => c.name && !existing.has(c.name.toLowerCase()));
  if (!fresh.length) return 0;

  const batch = writeBatch(db);
  fresh.forEach((c) => {
    batch.set(doc(db, CATEGORY_COLLECTION, payeeKey(c.name)), {
      name: c.name,
      direction: c.direction === "in" ? "in" : "out",
      createdAt: serverTimestamp(),
    });
  });
  await batch.commit();
  return fresh.length;
}

export async function renameCategory(id, name) {
  await updateDoc(doc(db, CATEGORY_COLLECTION, id), { name, updatedAt: serverTimestamp() });
}

export async function deleteCategory(id) {
  await deleteDoc(doc(db, CATEGORY_COLLECTION, id));
}

// --- Payees (the learned part) ----------------------------------------------
//  A payee record answers "who is this?" — role, and a default category. Role
//  is the durable fact; the category is only a fallback for when a narration
//  is ambiguous, because one person can legitimately appear under several
//  categories (a farm hand paid a salary who also gets reimbursed for feed).

export async function fetchPayees() {
  const snap = await getDocs(collection(db, PAYEE_COLLECTION));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function savePayee(name, { role, defaultCategory, catIn, catOut, investorId, note, confirmed, segment } = {}) {
  const key = payeeKey(name);
  if (!key) return null;

  const patch = { name: String(name).trim(), updatedAt: serverTimestamp() };
  if (role !== undefined) patch.role = role;
  // Money in and money out from the same person are often different categories
  // (an investor sends capital and receives a payout), so both are stored.
  if (catIn !== undefined) patch.catIn = catIn;
  if (catOut !== undefined) patch.catOut = catOut;
  if (defaultCategory !== undefined) patch.defaultCategory = defaultCategory;
  if (investorId !== undefined) patch.investorId = investorId;
  if (note !== undefined) patch.note = note;
  if (confirmed !== undefined) patch.confirmed = confirmed;
  if (segment !== undefined) patch.segment = segment;

  await setDoc(doc(db, PAYEE_COLLECTION, key), patch, { merge: true });
  return key;
}

/**
 * Names that are never a payee — the business's own name shows up in almost
 * every narration ("NIP transfer to PRAST FARM") and would otherwise capture
 * the whole statement.
 */
const NOT_A_PAYEE = new Set(["prast-farm", "prast-farms", "prast", "not-named", "bank", "self", "cash"]);

const NAME_STOPWORDS = new Set(["dr", "mrs", "mr", "miss", "chief", "alhaji", "and", "the", "ltd", "limited", "plc", "nigeria"]);

/** The meaningful words of a payee name, for matching inside a narration. */
function nameTokens(name) {
  return String(name || "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && !NAME_STOPWORDS.has(w));
}

/**
 * Find the payee rule that applies to a transaction.
 *
 * Matching is done against the NARRATION, not an extracted name: bank
 * descriptions are messy ("POS Pur @ 2057IIB2-OPay MICHVIN ENTERPRISEPort Ha")
 * and any extraction misses cases. Every word of the payee's name must appear,
 * so "Wali Clifford" never captures "Wali Kenneth", and the longest name wins
 * so "Kehinde Adenipekun" beats a bare "Adenipekun".
 */
export function matchPayee(txn, payees) {
  const hay = `${txn.description || ""} ${txn.counterparty || ""}`.toLowerCase();
  if (!hay.trim()) return null;

  let best = null, bestLen = 0;
  for (const p of payees) {
    if (NOT_A_PAYEE.has(p.id)) continue;
    const tk = nameTokens(p.name || p.id.replace(/-/g, " "));
    if (!tk.length) continue;
    if (!tk.every((w) => new RegExp(`\\b${w}`).test(hay))) continue;
    if (tk.length > bestLen) { best = p; bestLen = tk.length; }
  }
  return best;
}

/** Roles she can pick from when asked "who is this?" */
export const PAYEE_ROLES = [
  { id: "investor", label: "An investor" },
  { id: "staff", label: "Staff / farm hand" },
  { id: "supplier", label: "A supplier" },
  { id: "customer", label: "A buyer / customer" },
  { id: "family", label: "Family" },
  { id: "own-company", label: "Another of our companies" },
  { id: "owner", label: "Me / the business owner" },
  { id: "bank", label: "The bank" },
  { id: "other", label: "Something else" },
];

/**
 * Apply what we already know to a freshly-read statement.
 *
 * The model's own suggestion wins when it is confident, because it can read the
 * narration. A saved payee only fills the gap when the suggestion is missing or
 * "Uncategorised". Returns the transactions plus the list of payees we have
 * never seen, which is what she gets asked about.
 */
export function applyPayeeRules(transactions, payees) {
  const unknown = new Map();

  const out = transactions.map((t) => {
    // Matched on the narration, so a rule saved once catches every future
    // transaction from that person however the bank writes it.
    const known = matchPayee(t, payees);
    const key = known ? known.id : payeeKey(t.counterparty);

    let category = t.suggestedCategory || "Uncategorised";
    let source = "ai";

    // A saved payee only fills the gap the narration left. It never overrides a
    // confident reading — the same person can appear under several categories.
    const amount = Number(t.amount) || 0;
    const personalRole = known && PERSONAL_ROLES.has(known.role);
    const overLimit = amount > (known?.familyLimit ?? FAMILY_PERSONAL_LIMIT);

    // Above the limit, a family payee's personal default must NOT be applied —
    // the owner's rule is that such amounts are strictly business.
    const suppressPersonal = personalRole && overLimit;

    const learned = known && (t.direction === "in" ? known.catIn : known.catOut);
    const fallback = suppressPersonal ? null : (learned || known?.defaultCategory);

    if ((!category || category === "Uncategorised") && fallback) {
      category = fallback;
      source = "learned";
    }

    if (!known && key && t.counterparty && key !== "bank") {
      if (!unknown.has(key)) {
        unknown.set(key, { key, name: t.counterparty, count: 0, samples: [], direction: t.direction });
      }
      const u = unknown.get(key);
      u.count += 1;
      if (u.samples.length < 3) u.samples.push(t.description);
    }

    return {
      ...t,
      payeeKey: key,
      category,
      categorySource: source,
      payeeRole: known?.role || "",
      segment: known?.segment || t.segment || "",
      investorId: known?.investorId || "",
      overFamilyLimit: Boolean(suppressPersonal),
      needsReview: !category || category === "Uncategorised",
    };
  });

  return { transactions: out, unknownPayees: [...unknown.values()].sort((a, b) => b.count - a.count) };
}

/**
 * Suggest which existing investor a money-in transaction belongs to, by name.
 * Only offered as a suggestion — never linked automatically.
 */
export function matchInvestor(counterparty, records) {
  const key = payeeKey(counterparty);
  if (!key) return null;
  const parts = key.split("-").filter((p) => p.length > 2);
  if (!parts.length) return null;

  let best = null;
  for (const r of records) {
    const rk = payeeKey(fullName(r));
    if (!rk) continue;
    if (rk === key) return r;
    // Surname plus at least one other name part in common.
    const rParts = rk.split("-").filter((p) => p.length > 2);
    const shared = parts.filter((p) => rParts.includes(p));
    if (shared.length >= 2 && !best) best = r;
  }
  return best;
}

// --- Transactions ------------------------------------------------------------

export async function fetchTransactions(limitTo) {
  const q = limitTo
    ? query(collection(db, TXN_COLLECTION), orderBy("date", "desc"), fsLimit(limitTo))
    : query(collection(db, TXN_COLLECTION), orderBy("date", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export function listenTransactions(onChange, onError) {
  const q = query(collection(db, TXN_COLLECTION), orderBy("date", "desc"), fsLimit(500));
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { console.error("[Prast] transactions listener failed:", err); if (onError) onError(err); }
  );
}

/**
 * Write transactions, keyed by content hash so re-importing an overlapping
 * statement updates rather than duplicates. Returns counts of new vs repeat.
 */
export async function saveTransactions(transactions, statementId, onProgress) {
  const existing = new Set((await fetchTransactions()).map((t) => t.id));

  let added = 0;
  let repeated = 0;
  const CHUNK = 400;

  for (let i = 0; i < transactions.length; i += CHUNK) {
    const slice = transactions.slice(i, i + CHUNK);
    const batch = writeBatch(db);

    slice.forEach((t) => {
      const id = txnKey(t);
      if (existing.has(id)) repeated++;
      else added++;

      batch.set(
        doc(db, TXN_COLLECTION, id),
        {
          date: t.date,
          description: t.description,
          amount: Number(t.amount) || 0,
          direction: t.direction,
          balance: Number(t.balance) || 0,
          counterparty: t.counterparty || "",
          payeeKey: t.payeeKey || payeeKey(t.counterparty),
          category: t.category || "Uncategorised",
          categorySource: t.categorySource || "ai",
          investorId: t.investorId || "",
          note: t.note || "",
          statementId: statementId || "",
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    });

    await batch.commit();
    if (onProgress) onProgress(Math.min(i + CHUNK, transactions.length), transactions.length);
  }

  return { added, repeated, total: transactions.length };
}

export async function setTransactionCategory(id, category) {
  await updateDoc(doc(db, TXN_COLLECTION, id), {
    category,
    categorySource: "manual",
    updatedAt: serverTimestamp(),
  });
}

// --- Statements --------------------------------------------------------------

export async function saveStatement(account, reconciliation) {
  const ref = await addDoc(collection(db, STATEMENT_COLLECTION), {
    ...account,
    reconciliation,
    importedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function fetchStatements() {
  const snap = await getDocs(query(collection(db, STATEMENT_COLLECTION), orderBy("periodEnd", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Totals by category for a set of transactions. */
export function summariseByCategory(transactions) {
  const map = new Map();
  transactions.forEach((t) => {
    const k = t.category || "Uncategorised";
    if (!map.has(k)) map.set(k, { category: k, direction: t.direction, in: 0, out: 0, count: 0 });
    const row = map.get(k);
    row[t.direction] += Number(t.amount) || 0;
    row.count += 1;
  });
  return [...map.values()].sort((a, b) => b.in + b.out - (a.in + a.out));
}


// =============================================================================
//  SETTINGS — owner-editable agreement wording, rates and terms
//
//  Held in one Firestore document so a change applies to every document issued
//  afterwards, with agreement.js as the fallback if a field is blank.
// =============================================================================

const SETTINGS_DOC = ["settings", "agreement"];

let settingsCache = null;

/** Deep-ish merge: stored values win, defaults fill the gaps. */
// A band line as it used to be written into the wording, e.g.
// "₦500,000 to ₦5,000,000: 6 months" or "₦10,000,001 and above: 12 months".
const FROZEN_BAND_LINE = /^\s*₦[\d,]+\s*(?:to\s*₦[\d,]+|and above)\s*:\s*\d+\s*months\s*$/i;

/**
 * Wording saved before the rates were made live has the ROI and the band table
 * written into it as plain text, so editing a rate changed what the portal
 * worked out while the agreement carried on quoting the old figure. Swap those
 * fixed figures back to placeholders, which the document fills at build time.
 *
 * Only the exact phrasing this app shipped is touched — wording she wrote
 * herself is left alone.
 */
function unfreezeRates(clauses) {
  if (!Array.isArray(clauses)) return clauses;
  return clauses.map((c) => {
    const out = { ...c };

    if (typeof out.body === "string") {
      out.body = out.body
        // Keeps whichever form the wording used — "(ROI) of 140%" or "ROI of 140%".
        .replace(/(\(?ROI\)?)\s+of\s+\d+(?:\.\d+)?\s*%/gi, "$1 of {{roiPercent}}")
        .replace(/receive\s+\d+(?:\.\d+)?\s+times\s+the\s+invested/gi,
                 "receive {{roiTimes}} times the invested");
    }

    if (Array.isArray(out.lines) && out.lines.some((l) => FROZEN_BAND_LINE.test(String(l)))) {
      const kept = out.lines.filter((l) => !FROZEN_BAND_LINE.test(String(l)));
      out.lines = ["{{termTable}}", ...kept];
    }
    return out;
  });
}

function mergeSettings(stored) {
  const out = { ...DEFAULTS, ...(stored || {}) };
  out.company = { ...DEFAULTS.company, ...(stored?.company || {}) };
  // Arrays are replaced wholesale, not merged — a deleted clause must stay deleted.
  if (!Array.isArray(stored?.clauses) || !stored.clauses.length) out.clauses = DEFAULTS.clauses;
  if (!Array.isArray(stored?.termBands) || !stored.termBands.length) out.termBands = DEFAULTS.termBands;
  if (!Number(out.roiMultiplier)) out.roiMultiplier = DEFAULTS.roiMultiplier;
  out.clauses = unfreezeRates(out.clauses);
  return out;
}

/** Load once at boot. Safe to call again; later calls refresh the cache. */
export async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, ...SETTINGS_DOC));
    settingsCache = mergeSettings(snap.exists() ? snap.data() : null);
  } catch (err) {
    console.warn("[Prast] settings unavailable, using built-in defaults:", err.message);
    settingsCache = mergeSettings(null);
  }
  return settingsCache;
}

/** Synchronous access for renderers. Falls back to defaults before load(). */
export function getSettings() {
  return settingsCache || mergeSettings(null);
}

export async function saveSettings(patch) {
  await setDoc(doc(db, ...SETTINGS_DOC), { ...patch, updatedAt: serverTimestamp() }, { merge: true });
  await loadSettings();
  return settingsCache;
}

/** Restore the built-in wording, discarding stored overrides. */
export async function resetSettings() {
  await setDoc(doc(db, ...SETTINGS_DOC), {
    company: DEFAULTS.company,
    roiMultiplier: DEFAULTS.roiMultiplier,
    termBands: DEFAULTS.termBands,
    agreementTitle: DEFAULTS.agreementTitle,
    preamble: DEFAULTS.preamble,
    clauses: DEFAULTS.clauses,
    closing: DEFAULTS.closing,
    updatedAt: serverTimestamp(),
  });
  await loadSettings();
  return settingsCache;
}

// --- Live commercial terms (read from settings, not the constants) -----------

/** Bands as numbers, lowest first. An empty upper bound means "and above". */
function normalisedBands() {
  const open = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)))
    ? Infinity : Number(v);
  return (getSettings().termBands || [])
    .map((b) => ({ min: Number(b.min) || 0, max: open(b.max), months: Number(b.months) || 0 }))
    .sort((a, b) => a.min - b.min);
}

export function liveTermMonthsFor(amount) {
  const n = Number(amount) || 0;
  const bands = normalisedBands();
  const band = bands.find((b) => n >= b.min && n <= b.max);
  return band ? band.months : (bands[0]?.months ?? 6);
}

/**
 * Why an amount cannot be taken, or null if it can.
 *
 * A gap between two bands is a deliberate refusal, not an oversight: the farm
 * does not accept those amounts. Left unchecked, liveTermMonthsFor() quietly
 * hands such an amount the first band's term and it gets booked as normal.
 *
 *   { reason: "below", min }        under the smallest band
 *   { reason: "gap", from, to }     between two bands
 */
export function amountRejection(amount) {
  const n = Number(amount) || 0;
  const bands = normalisedBands();
  if (!n || !bands.length) return null;
  if (bands.some((b) => n >= b.min && n <= b.max)) return null;

  if (n < bands[0].min) return { reason: "below", min: bands[0].min };

  for (let i = 0; i < bands.length - 1; i++) {
    if (n > bands[i].max && n < bands[i + 1].min) {
      return { reason: "gap", from: bands[i].max + 1, to: bands[i + 1].min - 1 };
    }
  }
  return { reason: "gap", from: n, to: n };
}

export function liveExpectedPayout(amount) {
  return Math.round((Number(amount) || 0) * (Number(getSettings().roiMultiplier) || 1.4));
}

export function liveTermTableLines() {
  const naira0 = (n) => `₦${Number(n).toLocaleString("en-NG")}`;
  return (getSettings().termBands || []).map((b) =>
    b.max === null || !Number.isFinite(Number(b.max))
      ? `${naira0(b.min)} and above: ${b.months} months`
      : `${naira0(b.min)} to ${naira0(b.max)}: ${b.months} months`
  );
}

// =============================================================================
//  UNIVERSAL SEARCH
//
//  One box that searches everything: an investor's name, a word from a bank
//  narration, a category, a bank, or an amount.
//
//  Firestore has no text search, so the transactions are pulled once and
//  searched here. Ten thousand rows is a couple of seconds and a few megabytes
//  the first time, then instant — which beats a query per keystroke, and means
//  every figure on screen is counted from the real rows rather than guessed.
// =============================================================================

let corpus = null;          // all transactions, newest first
let corpusPromise = null;   // in-flight load, so two searches don't both fetch

/** True once the transactions are in memory and searching is instant. */
export const searchReady = () => corpus !== null;

export async function loadSearchCorpus({ force = false } = {}) {
  if (corpus && !force) return corpus;
  if (corpusPromise && !force) return corpusPromise;
  corpusPromise = fetchTransactions().then((rows) => {
    corpus = rows;
    corpusPromise = null;
    return corpus;
  }).catch((err) => {
    corpusPromise = null;
    throw err;
  });
  return corpusPromise;
}

/** Drop the cache so the next search re-reads (after an import, say). */
export function invalidateSearchCorpus() { corpus = null; corpusPromise = null; }

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Read an amount out of a search term.
 * Accepts "250000", "250,000", "₦250k", "3m". Returns null when the term is
 * not really a number — "3 bags" must search text, not amounts.
 */
export function searchAmount(term) {
  const s = norm(term).replace(/^[₦n]\s*/, "").replace(/,/g, "").replace(/\s/g, "");
  const m = s.match(/^(\d*\.?\d+)(b|bn|billion|m|mn|million|k|thousand)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (!m[2]) return n;                                    // exactly what she typed
  const mult = /^b/.test(m[2]) ? 1e9 : /^m/.test(m[2]) ? 1e6 : 1e3;
  return Math.round(n * mult);
}

/** The words of a transaction that a text search should look at. */
const txnHaystack = (t) => norm([
  t.description, t.counterparty, t.category, t.bank, t.account, t.segment, t.date,
].join(" "));

const recordHaystack = (r) => norm([
  r.firstName, r.lastName, r.type, r.investDate, r.dueDate, r.note,
].join(" "));

/** Every word must appear somewhere — "obasi 5000" finds Obasi's ₦5,000 rows. */
function matchesWords(haystack, words) {
  return words.every((w) => haystack.includes(w));
}

/**
 * Search records and transactions at once.
 *
 * A term that reads as a number matches amounts exactly AND is still tried as
 * text, so "5000" finds both ₦5,000 rows and a reference containing "5000".
 */
export function searchAll(term, { records = [], transactions = null, limit = 400 } = {}) {
  const q = norm(term);
  const empty = { term, words: [], amount: null, records: [], transactions: [],
                  totals: { in: 0, out: 0, net: 0, count: 0 }, truncated: false, matched: 0 };
  if (q.length < 2) return empty;

  const words = q.split(" ").filter(Boolean);
  const amount = searchAmount(term);
  const rows = transactions || corpus || [];

  const hitRecords = records.filter((r) => {
    if (amount !== null &&
        (Number(r.investSum) === amount || Number(r.dueSum) === amount)) return true;
    return matchesWords(recordHaystack(r), words);
  });

  const hitTxns = [];
  for (const t of rows) {
    const byAmount = amount !== null && Math.round(Number(t.amount) || 0) === Math.round(amount);
    if (byAmount || matchesWords(txnHaystack(t), words)) hitTxns.push(t);
  }

  const totals = hitTxns.reduce((acc, t) => {
    const n = Number(t.amount) || 0;
    if (t.direction === "in") acc.in += n; else acc.out += n;
    acc.count += 1;
    return acc;
  }, { in: 0, out: 0, count: 0 });
  totals.net = totals.in - totals.out;

  return {
    term, words, amount,
    records: hitRecords,
    transactions: hitTxns.slice(0, limit),
    totals,                                  // totals cover every hit, not the slice
    truncated: hitTxns.length > limit,
    matched: hitTxns.length,
  };
}

/**
 * Everything to do with one person or keyword, as a statement she can read or
 * hand to somebody: totals, the months it spans, and every line behind them.
 */
export function buildReport(term, { records = [], transactions = null } = {}) {
  const found = searchAll(term, { records, transactions, limit: Infinity });
  const rows = found.transactions;

  const byMonth = new Map();
  for (const t of rows) {
    const key = t.month || String(t.date || "").slice(0, 7);
    if (!key) continue;
    const m = byMonth.get(key) || { month: key, in: 0, out: 0, count: 0 };
    const n = Number(t.amount) || 0;
    if (t.direction === "in") m.in += n; else m.out += n;
    m.count += 1;
    byMonth.set(key, m);
  }

  const byCategory = new Map();
  for (const t of rows) {
    const key = t.category || "Not sorted yet";
    const c = byCategory.get(key) || { category: key, in: 0, out: 0, count: 0 };
    const n = Number(t.amount) || 0;
    if (t.direction === "in") c.in += n; else c.out += n;
    c.count += 1;
    byCategory.set(key, c);
  }

  const dates = rows.map((t) => t.date).filter(Boolean).sort();
  const banks = [...new Set(rows.map((t) => t.bank).filter(Boolean))];

  return {
    term,
    totals: found.totals,
    records: found.records,
    transactions: rows,
    months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    categories: [...byCategory.values()].sort((a, b) => (b.in + b.out) - (a.in + a.out)),
    first: dates[0] || null,
    last: dates[dates.length - 1] || null,
    banks,
  };
}

/** A report as a spreadsheet, for sending on. */
export function reportToCSV(report) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    [`Report for`, report.term].map(esc).join(","),
    [`Money in`, report.totals.in].map(esc).join(","),
    [`Money out`, report.totals.out].map(esc).join(","),
    [`Net`, report.totals.net].map(esc).join(","),
    [`Transactions`, report.totals.count].map(esc).join(","),
    [`From`, report.first || ""].map(esc).join(","),
    [`To`, report.last || ""].map(esc).join(","),
    "",
    ["Date", "Bank", "Account", "In or out", "Amount", "Category", "Narration"].map(esc).join(","),
  ];
  for (const t of report.transactions) {
    lines.push([
      t.date, t.bank, t.account, t.direction === "in" ? "In" : "Out",
      Number(t.amount) || 0, t.category, t.description,
    ].map(esc).join(","));
  }
  return lines.join("\n");
}

// --- Monthly summaries (pre-computed at import) -------------------------------

const SUMMARY_COLLECTION = "summaries";

/**
 * One document per account per month, each carrying a per-day breakdown.
 * The calendar and charts read these ~70 documents instead of ten thousand
 * transactions.
 */
export async function fetchSummaries() {
  const snap = await getDocs(query(collection(db, SUMMARY_COLLECTION), orderBy("month", "asc")));
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id,
      bank: x.bank,
      account: x.account,
      month: x.month,
      in: Number(x.in) || 0,
      out: Number(x.out) || 0,
      net: Number(x.net) || 0,
      count: Number(x.count) || 0,
      days: x.days || {},
      cats: x.cats || {},
    };
  });
}

/**
 * Every month between two YYYY-MM strings, so a month with no statement can be
 * drawn as a gap rather than silently skipped or shown as zero.
 */
export function monthRange(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m === 13) { y += 1; m = 1; }
  }
  return out;
}

export const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const prettyMonth = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
};

// =============================================================================
//  FINANCIAL PROJECTION
//
//  Fits a straight line through the months we actually hold and extends it
//  forward. Deliberately simple and explainable: the owner needs to see why a
//  number was predicted, and a model she cannot reason about is worse than a
//  rough one she can.
// =============================================================================

/** Least-squares fit of y = a + b·x over the supplied points. */
function fitLine(points) {
  const n = points.length;
  if (n < 2) return null;
  const sx = points.reduce((s, p) => s + p.x, 0);
  const sy = points.reduce((s, p) => s + p.y, 0);
  const sxx = points.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = points.reduce((s, p) => s + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;

  // R² tells her how much to trust the line.
  const mean = sy / n;
  const ssTot = points.reduce((s, p) => s + (p.y - mean) ** 2, 0);
  const ssRes = points.reduce((s, p) => s + (p.y - (a + b * p.x)) ** 2, 0);
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;

  return { a, b, r2 };
}

const monthIndex = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
};
const indexToMonth = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;

/**
 * Project `ahead` months of in / out / net.
 *
 * Only months we actually have are fitted — a missing statement is skipped, not
 * treated as a zero month, which would drag every trend toward the floor.
 */
export function project(rowsByMonth, { ahead = 6, window: win = 18 } = {}) {
  const months = [...rowsByMonth.keys()].sort();
  if (months.length < 3) {
    return { ok: false, reason: "Not enough months yet — at least three are needed.", points: [] };
  }

  const recent = months.slice(-win);
  const base = monthIndex(recent[0]);

  const series = {};
  for (const key of ["in", "out", "net"]) {
    const pts = recent.map((m) => ({ x: monthIndex(m) - base, y: rowsByMonth.get(m)[key] }));
    series[key] = { fit: fitLine(pts), pts };
  }

  const lastIdx = monthIndex(months[months.length - 1]);
  const points = [];
  for (let k = 1; k <= ahead; k++) {
    const x = lastIdx - base + k;
    const row = { month: indexToMonth(lastIdx + k) };
    for (const key of ["in", "out", "net"]) {
      const f = series[key].fit;
      row[key] = f ? Math.round(f.a + f.b * x) : 0;
    }
    points.push(row);
  }

  // Confidence comes from the profit fit, since that is what she reads.
  const r2 = series.net.fit ? series.net.fit.r2 : 0;
  const perMonth = series.net.fit ? series.net.fit.b : 0;

  return {
    ok: true,
    points,
    monthsUsed: recent.length,
    gapsSkipped: monthRange(recent[0], months[months.length - 1]).length - recent.length,
    r2,
    trendPerMonth: perMonth,
    confidence: r2 >= 0.5 ? "steady" : r2 >= 0.2 ? "rough" : "very rough",
  };
}

/** Plain-English observations about the months we hold. */
export function insights(rowsByMonth) {
  const months = [...rowsByMonth.keys()].sort();
  if (!months.length) return [];
  const rows = months.map((m) => ({ month: m, ...rowsByMonth.get(m) }));
  const out = [];

  const best = rows.reduce((a, b) => (b.net > a.net ? b : a));
  const worst = rows.reduce((a, b) => (b.net < a.net ? b : a));
  out.push({ icon: "arrow-trend-up", text: `Best month so far was ${prettyMonth(best.month)}, up ${naira(best.net)}.` });
  if (worst.net < 0) {
    out.push({ icon: "arrow-trend-down", text: `Hardest month was ${prettyMonth(worst.month)}, down ${naira(Math.abs(worst.net))}.` });
  }

  const losses = rows.filter((r) => r.net < 0).length;
  out.push({ icon: "scale-balanced", text: `${rows.length - losses} of ${rows.length} months on record ended up.` });

  const last6 = rows.slice(-6);
  if (last6.length >= 3) {
    const avg = last6.reduce((s, r) => s + r.net, 0) / last6.length;
    out.push({
      icon: "calendar-day",
      text: avg >= 0
        ? `Over the last ${last6.length} months you kept about ${naira(avg)} a month on average.`
        : `Over the last ${last6.length} months you were about ${naira(Math.abs(avg))} a month short on average.`,
    });
  }
  return out;
}

// =============================================================================
//  WHAT COUNTS AS PROFIT
//
//  Money arriving is not the same as money earned. An investor's deposit is a
//  DEBT — it must be paid back with a return on top — and moving money between
//  the family's own accounts is not trade at all. Counting either as profit
//  flatters the business, so both are excluded from the operating figures.
// =============================================================================

export const CATEGORY_KIND = {
  // earned
  "Farm & Produce Sales": "revenue",
  "Property Sales & Land Revenue": "revenue",
  "Rental Income": "revenue",

  // borrowed / repaid — never profit, never a cost of trading
  "Investor Capital & Business Loans": "financing",
  "Investor Payouts & Loan Repayments": "financing",

  // the same money in a different pocket
  "Family Internal Transfers (In)": "transfer",
  "Family Internal Transfers (Out)": "transfer",
  "Transfers Between Our Companies": "transfer",

  // the household, not the business
  "School Fees & Education": "personal",
  "Everyday Personal & Card Purchases": "personal",
  "Owner Drawings": "personal",

  // we genuinely do not know yet
  "Unidentified Bank Transfers (In)": "unknown",
  "Unidentified Bank Transfers (Out)": "unknown",
  Uncategorised: "unknown",
};

/** Anything not listed is a cost of running the farm. */
export const kindOf = (category) => CATEGORY_KIND[category] || "expense";

/**
 * Operating position across a set of monthly summaries.
 *
 * `unknownIn` / `unknownOut` are reported rather than buried: with a large
 * uncategorised tail the profit figure carries real uncertainty, and hiding
 * that would be worse than showing it.
 */
export function operatingSummary(rows) {
  const t = { revenue: 0, expenses: 0, financingIn: 0, financingOut: 0,
              transferIn: 0, transferOut: 0, personal: 0,
              unknownIn: 0, unknownOut: 0, cashIn: 0, cashOut: 0 };

  rows.forEach((m) => {
    t.cashIn += m.in;
    t.cashOut += m.out;
    Object.entries(m.cats || {}).forEach(([name, v]) => {
      const inn = Number(v.in) || 0, out = Number(v.out) || 0;
      switch (kindOf(name)) {
        case "revenue":   t.revenue += inn; break;
        case "financing": t.financingIn += inn; t.financingOut += out; break;
        case "transfer":  t.transferIn += inn; t.transferOut += out; break;
        case "personal":  t.personal += out; break;
        case "unknown":   t.unknownIn += inn; t.unknownOut += out; break;
        default:          t.expenses += out; if (inn) t.revenue += inn;
      }
    });
  });

  t.profit = t.revenue - t.expenses;
  t.margin = t.revenue ? (t.profit / t.revenue) * 100 : null;
  t.cashNet = t.cashIn - t.cashOut;
  // How much of the picture is still unclassified — the honesty figure.
  const known = t.revenue + t.expenses;
  t.unknownShare = (known + t.unknownIn + t.unknownOut)
    ? ((t.unknownIn + t.unknownOut) / (known + t.unknownIn + t.unknownOut)) * 100 : 0;
  return t;
}

/** The most recent `n` months present in the summaries. */
export function lastMonths(rows, n = 12) {
  const months = [...new Set(rows.map((r) => r.month))].sort().slice(-n);
  const keep = new Set(months);
  return { rows: rows.filter((r) => keep.has(r.month)), months };
}

// =============================================================================
//  REVIEW QUEUE — sorting the unknown pile
// =============================================================================

export const UNSORTED_CATEGORIES = [
  "Uncategorised",
  "Unidentified Bank Transfers (In)",
  "Unidentified Bank Transfers (Out)",
];

/**
 * The biggest unsorted transactions first, because sorting the largest ones
 * moves the profit figure fastest. One query per unsorted category, merged.
 */
export async function fetchUnsorted(perCategory = 40) {
  let batches;
  try {
    batches = await Promise.all(
      UNSORTED_CATEGORIES.map((c) =>
        getDocs(
          query(
            collection(db, TXN_COLLECTION),
            where("category", "==", c),
            orderBy("amount", "desc"),
            fsLimit(perCategory)
          )
        )
      )
    );
  } catch (err) {
    // A silently-empty list looks like "nothing to sort", which is the exact
    // opposite of the truth while the index is still being built.
    if (String(err?.message || "").includes("index")) {
      throw new Error("Still getting the list ready — try again in a minute.");
    }
    throw err;
  }
  return batches
    .flatMap((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })))
    .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
}

/**
 * How much is still unsorted.
 *
 * Counted and summed ON THE SERVER — reading every one of ~7,600 documents just
 * to count them made the button take seconds to appear, and cost a read per row.
 * Cached briefly because the dashboard re-renders on every snapshot.
 */
const UNSORTED_CACHE_KEY = "prast:unsorted";
let unsortedCache = null;
let unsortedAt = 0;

// Survive moving between screens, so the figure is instant after the first look.
try {
  const raw = sessionStorage.getItem(UNSORTED_CACHE_KEY);
  if (raw) { const c = JSON.parse(raw); unsortedCache = c.v; unsortedAt = c.t; }
} catch { /* private mode, no cache */ }

export async function countUnsorted({ maxAgeMs = 300_000 } = {}) {
  if (unsortedCache && Date.now() - unsortedAt < maxAgeMs) return unsortedCache;

  const results = await Promise.all(
    UNSORTED_CATEGORIES.map(async (c) => {
      const q = query(collection(db, TXN_COLLECTION), where("category", "==", c));
      try {
        const snap = await getAggregateFromServer(q, { n: fsCount(), total: fsSum("amount") });
        return { count: snap.data().n || 0, value: snap.data().total || 0 };
      } catch {
        // Older SDK or a blocked aggregation — a plain count still beats
        // downloading every document.
        try {
          const c2 = await getCountFromServer(q);
          return { count: c2.data().count || 0, value: 0 };
        } catch { return { count: 0, value: 0 }; }
      }
    })
  );

  unsortedCache = results.reduce(
    (a, r) => ({ count: a.count + r.count, value: a.value + r.value }),
    { count: 0, value: 0 }
  );
  unsortedAt = Date.now();
  try { sessionStorage.setItem(UNSORTED_CACHE_KEY, JSON.stringify({ v: unsortedCache, t: unsortedAt })); } catch {}
  return unsortedCache;
}

/** Force the next read to go back to the server — used after filing. */
export function invalidateUnsorted() {
  unsortedCache = null;
  unsortedAt = 0;
  try { sessionStorage.removeItem(UNSORTED_CACHE_KEY); } catch {}
}

/**
 * Adjust the cached figure locally after filing, instead of asking the server
 * again. Keeps the number moving as she works without a round trip per tap.
 */
export function nudgeUnsorted(countDelta, valueDelta) {
  if (!unsortedCache) return;
  unsortedCache = {
    count: Math.max(0, unsortedCache.count + countDelta),
    value: Math.max(0, unsortedCache.value + valueDelta),
  };
  try { sessionStorage.setItem(UNSORTED_CACHE_KEY, JSON.stringify({ v: unsortedCache, t: unsortedAt })); } catch {}
}

/**
 * File one transaction, and remember the decision against the payee so the
 * next one from the same person is already sorted.
 */
export async function fileTransaction(txn, category, { learn = true, segment = "" } = {}) {
  const patch = { category, categorySource: "manual", updatedAt: serverTimestamp() };
  // Which part of the farm this belongs to — kept beside the category rather
  // than multiplied into it, so profit per animal stays possible later.
  if (segment) patch.segment = segment;
  await updateDoc(doc(db, TXN_COLLECTION, txn.id), patch);
  nudgeUnsorted(-1, -(Number(txn.amount) || 0));

  const key = txn.payeeKey || payeeKey(txn.counterparty);
  if (!learn || !key || key === "bank" || !txn.counterparty) return;

  if (NOT_A_PAYEE.has(key)) return { alsoFiled: 0 };

  const rule = {
    name: txn.counterparty,
    [txn.direction === "in" ? "catIn" : "catOut"]: category,
    updatedAt: serverTimestamp(),
  };
  if (segment) rule.segment = segment;
  await setDoc(doc(db, PAYEE_COLLECTION, key), rule, { merge: true });

  // Apply the decision to everything else still unsorted from the same person,
  // so she only ever has to say it once.
  const alsoFiled = await applyRuleToUnsorted(
    { id: key, name: txn.counterparty, segment, role: "" },
    txn.direction,
    category
  );
  return { alsoFiled };
}

/** Categories that make sense for a given direction, for the quick chooser. */
export function categoriesFor(direction, categories) {
  return categories
    .filter((c) => c.direction === direction && !UNSORTED_CATEGORIES.includes(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}


/**
 * Sweep the unsorted pile for other transactions from the same person and file
 * them the same way. Bounded so one tap can never turn into a long wait.
 */
export async function applyRuleToUnsorted(payee, direction, category, max = 300) {
  const tk = nameTokens(payee.name || payee.id.replace(/-/g, " "));
  if (!tk.length || NOT_A_PAYEE.has(payee.id)) return 0;

  const pending = await fetchUnsorted(max);
  const hits = pending.filter(
    (t) =>
      t.direction === direction &&
      t.categorySource !== "manual" &&
      tk.every((w) => new RegExp(`\\b${w}`).test(`${t.description || ""} ${t.counterparty || ""}`.toLowerCase()))
  );
  if (!hits.length) return 0;

  const batch = writeBatch(db);
  hits.forEach((t) => {
    const patch = {
      category,
      categorySource: "learned",
      counterparty: payee.name,
      payeeKey: payee.id,
      updatedAt: serverTimestamp(),
    };
    if (payee.segment) patch.segment = payee.segment;
    batch.update(doc(db, TXN_COLLECTION, t.id), patch);
  });
  await batch.commit();
  nudgeUnsorted(-hits.length, -hits.reduce((a, t) => a + (Number(t.amount) || 0), 0));
  return hits.length;
}

// =============================================================================
//  ENQUIRIES from the public website
// =============================================================================

const INQUIRY_COLLECTION = "inquiries";

/** Live feed of everything not yet dealt with, newest first. */
export function listenInquiries(onChange, onError) {
  const q = query(collection(db, INQUIRY_COLLECTION), orderBy("createdAt", "desc"), fsLimit(100));
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { console.error("[Prast] inquiries listener failed:", err); if (onError) onError(err); }
  );
}

export async function setInquiryStatus(id, status) {
  await updateDoc(doc(db, INQUIRY_COLLECTION, id), { status, handledAt: serverTimestamp() });
}

export async function deleteInquiry(id) {
  await deleteDoc(doc(db, INQUIRY_COLLECTION, id));
}

export const INQUIRY_KINDS = {
  invest: { label: "Wants to invest", icon: "handshake" },
  buy: { label: "Wants to buy", icon: "basket-shopping" },
  apply: { label: "Academy application", icon: "graduation-cap" },
  job: { label: "Wants to work here", icon: "briefcase" },
};

/** The two that are people applying to us rather than customers. */
export const APPLICATION_KINDS = ["apply", "job"];

// =============================================================================
//  PORTAL SUBSCRIPTIONS — other farms paying to use this software
//
//  A farm fills the sign-up form on the website. It arrives here as "pending"
//  with a photo of their transfer. She checks the money actually landed, then
//  approves — which is the only thing that sets a start and an expiry date.
// =============================================================================

const LICENSE_COLLECTION = "licenses";
const LICENSE_RECEIPTS = "licenseReceipts";

export { PORTAL_PLANS };

/** Live feed of every farm that has ever signed up, newest first. */
export function listenLicenses(onChange, onError) {
  const q = query(collection(db, LICENSE_COLLECTION), orderBy("createdAt", "desc"), fsLimit(200));
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { console.error("[Prast] licences listener failed:", err); if (onError) onError(err); }
  );
}

/** Their payment receipt, fetched only when she asks to look at it. */
export async function getLicenseReceipt(licenseId) {
  const snap = await getDoc(doc(db, LICENSE_RECEIPTS, licenseId));
  return snap.exists() ? snap.data() : null;
}

/**
 * Turn a pending request into a live subscription.
 * The clock starts today, not on the day they paid, so a slow approval never
 * costs the farm days it paid for.
 */
export async function approveLicense(license) {
  const years = Number(license.years) || PORTAL_PLANS[license.plan]?.years || 1;
  const startsAt = todayISO();
  await updateDoc(doc(db, LICENSE_COLLECTION, license.id), {
    status: "active",
    startsAt,
    expiresAt: addYearsISO(startsAt, years),
    approvedAt: serverTimestamp(),
  });
}

/** Turn one down — the receipt did not check out, or they changed their mind. */
export async function declineLicense(id, reason = "") {
  await updateDoc(doc(db, LICENSE_COLLECTION, id), {
    status: "declined",
    declineReason: String(reason || "").slice(0, 300),
    handledAt: serverTimestamp(),
  });
}

export async function deleteLicense(id) {
  await deleteDoc(doc(db, LICENSE_COLLECTION, id));
  await deleteDoc(doc(db, LICENSE_RECEIPTS, id)).catch(() => {});
}

/** How many days a live subscription has left; negative once it has lapsed. */
export function licenseDaysLeft(license) {
  return license?.expiresAt ? daysUntil(license.expiresAt) : null;
}
