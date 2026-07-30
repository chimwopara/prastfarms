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
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";

import { firebaseConfig, RECORDS_COLLECTION } from "./firebase-config.js";
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
  await setDoc(doc(db, RECEIPTS_COLLECTION, recordId), {
    image: dataUrl,
    reference: meta.reference || "",
    bank: meta.bank || "",
    createdAt: serverTimestamp(),
  });
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

export async function savePayee(name, { role, defaultCategory, catIn, catOut, investorId, note, confirmed } = {}) {
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

  await setDoc(doc(db, PAYEE_COLLECTION, key), patch, { merge: true });
  return key;
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
  const byKey = new Map(payees.map((p) => [p.id, p]));
  const unknown = new Map();

  const out = transactions.map((t) => {
    const key = payeeKey(t.counterparty);
    const known = byKey.get(key);

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
function mergeSettings(stored) {
  const out = { ...DEFAULTS, ...(stored || {}) };
  out.company = { ...DEFAULTS.company, ...(stored?.company || {}) };
  // Arrays are replaced wholesale, not merged — a deleted clause must stay deleted.
  if (!Array.isArray(stored?.clauses) || !stored.clauses.length) out.clauses = DEFAULTS.clauses;
  if (!Array.isArray(stored?.termBands) || !stored.termBands.length) out.termBands = DEFAULTS.termBands;
  if (!Number(out.roiMultiplier)) out.roiMultiplier = DEFAULTS.roiMultiplier;
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

export function liveTermMonthsFor(amount) {
  const n = Number(amount) || 0;
  const bands = getSettings().termBands || [];
  const band = bands.find((b) => n >= Number(b.min) && n <= (b.max === null ? Infinity : Number(b.max)));
  return band ? Number(band.months) : (bands[0]?.months ?? 6);
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
