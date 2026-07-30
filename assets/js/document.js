// =============================================================================
//  PRAST FARMS — SHAREABLE INVESTMENT DOCUMENT
//
//  Builds one PDF containing three pages:
//     1. Invoice
//     2. Agreement letter   (wording from agreement.js)
//     3. Payment receipt    (with the investor's own receipt photo)
//
//  Rendered as off-screen HTML, captured with html2canvas, assembled by jsPDF.
//  Both libraries are loaded by portal.html.
// =============================================================================

import { naira, prettyDate, fullName, todayISO, monthsBetween, getSettings } from "./db.js";
import { signatures } from "./agreement.js";

// Live, owner-editable values. Read per render so a Settings change shows up in
// the very next document without a reload.
const S = () => getSettings();

// --- Theme -------------------------------------------------------------------
//  The document prints on brand green rather than white, so every colour below
//  is chosen for legibility on a dark ground.
const PAPER   = "#0d2716";   // page background
const PAPER_2 = "#123320";   // raised panels
const INK     = "#f4f1ea";   // body text
const INK_DIM = "#9fb8a6";   // labels
const ACCENT  = "#3fbf6c";   // green accent, lifted for contrast on dark
const GOLD    = "#d4af37";
const RULE    = "rgba(255,255,255,.16)";

// Faint product silhouettes, tiled behind the content.
const PATTERN = ["nbpig", "nbchicken", "nbturkey", "nbeggs", "nbplantain"];

/** Scattered watermark layer. Fixed positions so every page looks deliberate. */
function patternLayer() {
  const spots = [
    [ -2,  6,  38, 14], [ 62,  2,  32, -9], [ 26, 22,  30,  6],
    [ -6, 40,  34, -6], [ 68, 34,  30, 11], [ 20, 55,  33, -3],
    [ -4, 72,  32,  8], [ 64, 68,  34, -7], [ 30, 86,  29,  5],
  ];
  return `<div style="position:absolute;inset:0;overflow:hidden;pointer-events:none;">
    ${spots.map(([l, t, w, r], i) => `
      <img src="assets/img/pattern/${PATTERN[i % PATTERN.length]}.png"
           style="position:absolute;left:${l}%;top:${t}%;width:${w}%;
                  transform:rotate(${r}deg);opacity:.055;" crossorigin="anonymous">`).join("")}
  </div>`;
}

// --- Placeholder substitution ------------------------------------------------

function buildValues(record, receipt) {
  const invest = Number(record.investSum) || 0;
  const due = Number(record.dueSum) || 0;

  const termMonths = monthsBetween(record.investDate, record.dueDate);

  const bank = receipt?.bank || "";

  return {
    investorName: fullName(record),
    firstName: record.firstName || "",
    lastName: record.lastName || "",
    type: record.type || "Farm Investment",
    amount: naira(invest),
    payout: naira(due),
    profit: naira(due - invest),
    startDate: prettyDate(record.investDate),
    dueDate: prettyDate(record.dueDate),
    termMonths: String(termMonths),
    reference: receipt?.reference || "",
    bank,
    bankClause: bank ? ` via ${bank}` : "",
    today: prettyDate(todayISO()),
    docNumber: docNumber(record),
    company: S().company.name,
    legalName: S().company.legalName,
    business: S().company.business,
    signatoryName: S().company.signatoryName,
  };
}

function fill(text, values) {
  return String(text || "").replace(/\{\{(\w+)\}\}/g, (_, k) =>
    values[k] !== undefined ? values[k] : ""
  );
}

/** Stable, human-quotable document number derived from the record id. */
function docNumber(record) {
  const year = (record.investDate || todayISO()).slice(0, 4);
  const tail = String(record.id || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-4)
    .toUpperCase()
    .padStart(4, "0");
  return `PF-${year}-${tail}`;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --- Page chrome -------------------------------------------------------------

const A4 = { w: 794, h: 1123 }; // px at ~96dpi

function pageShell(inner, values, label) {
  const draft = S().isPlaceholder && label === "agreement";
  return `
  <div style="width:${A4.w}px;min-height:${A4.h}px;background:${PAPER};color:${INK};
              font-family:'Montserrat',Arial,sans-serif;box-sizing:border-box;
              padding:52px 52px 40px;position:relative;overflow:hidden;">

    ${patternLayer()}

    <div style="position:relative;">

      ${draft ? `
        <div style="position:absolute;top:-52px;left:-52px;right:-52px;background:#4a3708;
                    border-bottom:2px solid ${GOLD};color:#f5d97a;font-size:11px;
                    font-weight:700;letter-spacing:.08em;text-align:center;padding:7px;">
          DRAFT — AGREEMENT WORDING NOT FINALISED
        </div>` : ""}

      <div style="display:flex;justify-content:space-between;align-items:flex-start;
                  border-bottom:2px solid ${ACCENT};padding-bottom:16px;
                  margin-top:${draft ? "26px" : "0"};">
        <div style="display:flex;gap:14px;align-items:center;">
          <img src="assets/img/logo2.png" style="height:62px;object-fit:contain;" crossorigin="anonymous">
          <div>
            <div style="font-family:'Playfair Display',Georgia,serif;font-size:23px;font-weight:700;
                        color:${INK};line-height:1.1;">
              ${esc(String(S().company.name || "").toUpperCase())}
            </div>
            <div style="font-size:9px;letter-spacing:.16em;color:${ACCENT};text-transform:uppercase;margin-top:3px;">
              Generational Wealth Through Agriculture
            </div>
          </div>
        </div>
        <div style="text-align:right;font-size:10px;color:${INK_DIM};line-height:1.7;">
          ${S().company.address && S().company.address !== "—" ? esc(S().company.address) + "<br>" : ""}
          ${S().company.email && S().company.email !== "—" ? esc(S().company.email) + "<br>" : ""}
          ${S().company.phone && S().company.phone !== "—" ? esc(S().company.phone) + "<br>" : ""}
          ${S().company.rcNumber && S().company.rcNumber !== "—" ? "RC " + esc(S().company.rcNumber) : ""}
        </div>
      </div>

      ${inner}
    </div>

    <div style="position:absolute;bottom:20px;left:52px;right:52px;
                border-top:1px solid ${RULE};padding-top:10px;
                display:flex;justify-content:space-between;font-size:9px;color:${INK_DIM};">
      <span>${esc(values.docNumber)}</span>
      <span>${esc(values.investorName)}</span>
      <span>Issued ${esc(values.today)}</span>
    </div>
  </div>`;
}

function row(label, value, opts = {}) {
  return `
  <div style="display:flex;justify-content:space-between;padding:9px 0;
              border-bottom:1px dashed ${RULE};font-size:13px;">
    <span style="color:${INK_DIM};">${esc(label)}</span>
    <span style="font-weight:${opts.bold ? 700 : 600};color:${opts.color || INK};">${esc(value)}</span>
  </div>`;
}

// --- Page 1: Invoice ---------------------------------------------------------

function invoicePage(record, values) {
  return pageShell(
    `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin:30px 0 6px;">
      <div style="font-family:'Playfair Display',Georgia,serif;font-size:30px;font-weight:700;color:${INK};">Invoice</div>
      <div style="font-size:11px;color:${INK_DIM};">No. <strong style="color:${GOLD};">${esc(values.docNumber)}</strong></div>
    </div>
    <div style="font-size:11px;color:${INK_DIM};margin-bottom:26px;">Issued ${esc(values.today)}</div>

    <div style="background:${PAPER_2};border:1px solid ${RULE};border-radius:10px;padding:18px 20px;margin-bottom:26px;">
      <div style="font-size:9px;letter-spacing:.14em;color:${ACCENT};text-transform:uppercase;margin-bottom:6px;">Investor</div>
      <div style="font-size:19px;font-weight:700;color:${INK};">${esc(values.investorName)}</div>
      <div style="font-size:12px;color:${INK_DIM};margin-top:3px;">${esc(values.type)}</div>
    </div>

    <div style="margin-bottom:8px;">
      ${row("Placement type", values.type)}
      ${row("Start date", values.startDate)}
      ${row("Maturity date", values.dueDate)}
      ${row("Term", values.termMonths + " months")}
      ${values.reference ? row("Payment reference", values.reference) : ""}
      ${values.bank ? row("Received via", values.bank) : ""}
    </div>

    <div style="margin-top:26px;border-top:2px solid ${ACCENT};padding-top:14px;">
      ${row("Principal", values.amount, { bold: true })}
      ${row("Return", values.profit, { color: GOLD, bold: true })}
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;
                background:linear-gradient(135deg,${GOLD},#b89628);color:#0d2716;border-radius:10px;padding:16px 20px;margin-top:16px;">
      <span style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;">Total payable on maturity</span>
      <span style="font-size:23px;font-weight:700;">${esc(values.payout)}</span>
    </div>

    ${record.paidDate ? `
      <div style="margin-top:18px;border:2px solid ${ACCENT};border-radius:10px;padding:12px 16px;
                  background:rgba(63,191,108,.14);display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${ACCENT};font-weight:700;">Settled</span>
        <span style="font-size:13px;color:${INK};font-weight:600;">Paid ${esc(prettyDate(record.paidDate))}</span>
      </div>` : ""}
    `,
    values,
    "invoice"
  );
}

// --- Page 2: Agreement ------------------------------------------------------

/** Paragraph text: escape, then honour blank-line breaks. */
const para = (text, values) =>
  esc(fill(text, values)).replace(/\n\n/g, '<div style="height:8px;"></div>').replace(/\n/g, "<br>");

function agreementPage(record, values) {
  const body = (S().clauses || [])
    .map((c, i) => {
      const indent = c.heading ? "padding-left:15px;" : "";

      const lines = c.lines?.length
        ? `<div style="${indent}margin-top:7px;">
             ${c.linesHeading ? `<div style="font-size:11px;font-weight:600;color:${INK};margin-bottom:3px;">${esc(c.linesHeading)}</div>` : ""}
             ${c.lines.map((l) => `<div style="font-size:11.5px;line-height:1.75;color:${INK};">• ${esc(fill(l, values))}</div>`).join("")}
           </div>`
        : "";

      const blanks = c.blanks?.length
        ? `<div style="${indent}margin-top:9px;">
             ${c.blanks
               .map(
                 (b) => `
               <div style="display:flex;align-items:flex-end;gap:8px;margin-bottom:7px;">
                 <span style="font-size:11px;color:${INK_DIM};white-space:nowrap;">${esc(b)}:</span>
                 <span style="flex:1;border-bottom:1px solid ${RULE};height:13px;"></span>
               </div>`
               )
               .join("")}
           </div>`
        : "";

      const after = c.after
        ? `<div style="${indent}font-size:11.5px;line-height:1.75;color:${INK};margin-top:7px;">${para(c.after, values)}</div>`
        : "";

      return `
      <div style="margin-bottom:10px;">
        ${c.heading ? `<div style="font-size:12px;font-weight:700;color:${ACCENT};margin-bottom:3px;">${i + 1}. ${esc(fill(c.heading, values))}</div>` : ""}
        <div style="font-size:11.5px;line-height:1.65;color:${INK};${indent}">${para(c.body, values)}</div>
        ${lines}${after}${blanks}
      </div>`;
    })
    .join("");

  const sigs = signatures.map((x, i) => (i === 0 ? { ...x, image: S().company.signatureImage } : x))
    .map(
      (s) => `
    <div style="width:46%;">
      <div style="height:58px;display:flex;align-items:flex-end;">
        ${s.image ? `<img src="${s.image}" style="max-height:56px;max-width:190px;object-fit:contain;" crossorigin="anonymous">` : ""}
      </div>
      <div style="border-bottom:1px solid ${INK};"></div>
      <div style="font-size:10px;color:${INK_DIM};margin-top:6px;">${esc(fill(s.label, values))}</div>
      ${
        s.name && fill(s.name, values) !== "—"
          ? `<div style="font-size:11px;font-weight:700;color:${INK};margin-top:2px;">${esc(fill(s.name, values))}</div>`
          : `<div style="font-size:9px;color:${INK_DIM};margin-top:4px;">Name: ______________________</div>`
      }
      <div style="font-size:9px;color:${INK_DIM};margin-top:6px;">Date: ______________________</div>
    </div>`
    )
    .join("");

  // The supplied wording describes livestock. Saying so on the page is safer
  // than issuing a farm agreement for a property placement.
  const typeMismatch =
    S().appliesToType && record.type && record.type !== S().appliesToType
      ? `<div style="background:rgba(212,175,55,.14);border:1px solid ${GOLD};border-radius:8px;padding:10px 12px;
                   margin-bottom:16px;font-size:10.5px;color:#f5d97a;line-height:1.6;">
           <strong>Note:</strong> this record is a ${esc(record.type)} placement, but the wording
           below describes a livestock investment. Replace it with property wording before issuing.
         </div>`
      : "";

  return pageShell(
    `
    <div style="text-align:center;margin:22px 0 14px;">
      <div style="font-family:'Playfair Display',Georgia,serif;font-size:20px;font-weight:700;color:${INK};letter-spacing:.03em;">
        ${esc(fill(S().agreementTitle, values))}
      </div>
      <div style="font-size:9.5px;color:${INK_DIM};margin-top:4px;">Reference ${esc(values.docNumber)}</div>
    </div>

    ${typeMismatch}

    ${S().preamble ? `<div style="font-size:11.5px;line-height:1.7;color:${INK};margin-bottom:14px;">${para(S().preamble, values)}</div>` : ""}

    ${body}

    ${S().closing ? `<div style="font-size:11px;line-height:1.7;color:${INK_DIM};margin-top:16px;padding-top:12px;border-top:1px solid ${RULE};">${para(S().closing, values)}</div>` : ""}

    <div style="font-size:10px;font-weight:700;color:${ACCENT};letter-spacing:.1em;margin-top:16px;margin-bottom:8px;">SIGNATURES</div>
    <div style="display:flex;justify-content:space-between;">${sigs}</div>
    `,
    values,
    "agreement"
  );
}

// --- Page 3: Receipt --------------------------------------------------------

function receiptPage(record, values, receipt) {
  const photo = receipt?.image
    ? `<img src="${receipt.image}" style="max-width:100%;max-height:340px;display:block;margin:0 auto;
              border:3px solid #fff;border-radius:8px;">`
    : `<div style="border:2px dashed ${RULE};border-radius:10px;padding:40px;text-align:center;color:${INK_DIM};font-size:12px;">
         No receipt photo was attached to this record.
       </div>`;

  return pageShell(
    `
    <div style="margin:30px 0 22px;">
      <div style="font-family:'Playfair Display',Georgia,serif;font-size:28px;font-weight:700;color:${INK};">Payment Receipt</div>
      <div style="font-size:11px;color:${INK_DIM};margin-top:4px;">Acknowledgement of funds received</div>
    </div>

    <div style="background:${PAPER_2};border:1px solid ${ACCENT};border-radius:10px;padding:18px 20px;margin-bottom:22px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:9px;letter-spacing:.14em;color:${ACCENT};text-transform:uppercase;">Received from</div>
          <div style="font-size:18px;font-weight:700;color:${INK};margin-top:3px;">${esc(values.investorName)}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:9px;letter-spacing:.14em;color:${ACCENT};text-transform:uppercase;">Amount</div>
          <div style="font-size:22px;font-weight:700;color:${GOLD};margin-top:3px;">${esc(values.amount)}</div>
        </div>
      </div>
    </div>

    <div style="margin-bottom:24px;">
      ${row("Date received", values.startDate)}
      ${values.reference ? row("Reference", values.reference) : ""}
      ${values.bank ? row("Bank", values.bank) : ""}
      ${row("Applied to", values.type)}
      ${row("Maturity", values.dueDate)}
    </div>

    <div style="font-size:9px;letter-spacing:.14em;color:${INK_DIM};text-transform:uppercase;margin-bottom:10px;">
      Investor's payment evidence
    </div>
    ${photo}

    ${receipt?.payoutImage ? `
      <div style="font-size:9px;letter-spacing:.14em;color:${ACCENT};text-transform:uppercase;
                  margin:22px 0 10px;">
        Our payment to the investor${record.paidDate ? ` — ${esc(prettyDate(record.paidDate))}` : ""}
      </div>
      <img src="${receipt.payoutImage}" style="max-width:100%;max-height:300px;display:block;margin:0 auto;
           border:3px solid #fff;border-radius:8px;">` : ""}
    `,
    values,
    "receipt"
  );
}

// --- Assembly ---------------------------------------------------------------

/**
 * The three pages as raw HTML, in order.
 * Exported so the layout can be previewed or visually diffed without
 * generating a PDF first.
 */
export function renderPagesHTML(record, receipt) {
  const values = buildValues(record, receipt);
  return [
    { name: "Invoice", html: invoicePage(record, values) },
    { name: "Agreement", html: agreementPage(record, values) },
    { name: "Receipt", html: receiptPage(record, values, receipt) },
  ];
}

/**
 * Render the three pages into a single PDF.
 * Returns a { blob, filename } pair ready to share or download.
 */
export async function buildDocument(record, receipt, onProgress) {
  if (typeof window.html2canvas !== "function") {
    throw new Error("Document library did not load. Check your connection.");
  }
  const jsPDFCtor = window.jspdf?.jsPDF;
  if (!jsPDFCtor) {
    throw new Error("PDF library did not load. Check your connection.");
  }

  const values = buildValues(record, receipt);
  const pages = renderPagesHTML(record, receipt);

  // Off-screen host. Kept in the layout (not display:none) so html2canvas can
  // measure it, but pushed far outside the viewport.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:" + A4.w + "px;z-index:-1;";
  document.body.appendChild(host);

  const pdf = new jsPDFCtor({ unit: "pt", format: "a4", compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();

  try {
    for (let i = 0; i < pages.length; i++) {
      if (onProgress) onProgress(pages[i].name, i + 1, pages.length);

      host.innerHTML = pages[i].html;
      // Give the logo and receipt photo a moment to decode.
      await Promise.all(
        Array.from(host.querySelectorAll("img")).map(
          (img) =>
            img.complete ||
            new Promise((res) => {
              img.onload = img.onerror = res;
            })
        )
      );

      const canvas = await window.html2canvas(host.firstElementChild, {
        scale: 2,
        useCORS: true,
        backgroundColor: PAPER,
        logging: false,
      });

      if (i > 0) pdf.addPage();

      // Scale to fit the page rather than clipping. Editing the agreement
      // wording changes the page height, and losing the signature block off
      // the bottom edge would be far worse than a page rendered 4% smaller.
      const scale = Math.min(pw / canvas.width, ph / canvas.height);
      const w = canvas.width * scale;
      const h = canvas.height * scale;
      const x = (pw - w) / 2;

      pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", x, 0, w, h);
    }
  } finally {
    host.remove();
  }

  const safe = fullName(record).replace(/[^\w]+/g, "_") || "Investor";
  return {
    blob: pdf.output("blob"),
    filename: `PrastFarms_${safe}_${values.docNumber}.pdf`,
  };
}

/** Share via the OS sheet on mobile, fall back to a download on desktop. */
export async function shareDocument(record, receipt, onProgress) {
  const { blob, filename } = await buildDocument(record, receipt, onProgress);
  const file = new File([blob], filename, { type: "application/pdf" });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "Prast Farms investment document",
        text: `Investment document for ${fullName(record)}.`,
      });
      return "shared";
    } catch (err) {
      if (err.name === "AbortError") return "cancelled";
      // Fall through to download.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return "downloaded";
}
