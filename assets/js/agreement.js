// =============================================================================
//  PRAST FARMS — AGREEMENT WORDING AND COMMERCIAL TERMS
//
//  Wording below is taken from the Prast Farms Investment Agreement supplied by
//  the company. Placeholders in {{double braces}} are filled from the record.
//
//  This is also the single source of truth for the commercial terms (term
//  length by amount, ROI). The portal reads them from here, so changing a rate
//  here changes it everywhere — the chat, the due dates and the document.
// =============================================================================

export const COMPANY = {
  name: "Prast Farms",
  legalName: "Prast Farms",
  business: "pig farming",
  address: "—",           // <- registered address
  email: "—",             // <- contact email
  phone: "—",             // <- contact phone
  rcNumber: "—",          // <- CAC registration number
  signatureImage: "assets/img/whitesignature.png",  // document prints on green
  signatoryName: "—",     // <- name to print under the signature
};

// -----------------------------------------------------------------------------
//  COMMERCIAL TERMS
// -----------------------------------------------------------------------------

/** Return on investment: 140% of capital, i.e. 1.4x. */
export const ROI_MULTIPLIER = 1.4;

/**
 * Term length by amount invested, per the agreement.
 * `min` is inclusive; the last band has no upper bound.
 */
export const TERM_BANDS = [
  { min: 500_000, max: 5_000_000, months: 6 },
  { min: 5_000_001, max: 10_000_000, months: 8 },
  { min: 10_000_001, max: Infinity, months: 12 },
];

/**
 * Months for a given amount.
 *
 * The agreement's table starts at ₦500,000. Anything below that is outside the
 * published bands, so it falls back to the shortest term (6 months) rather than
 * guessing — worth double-checking on the rare small placement.
 */
export function termMonthsFor(amount) {
  const n = Number(amount) || 0;
  const band = TERM_BANDS.find((b) => n >= b.min && n <= b.max);
  return band ? band.months : 6;
}

/** True when the amount sits below the agreement's published bands. */
export const isBelowBands = (amount) => (Number(amount) || 0) < TERM_BANDS[0].min;

/** Payout at maturity: capital x ROI. */
export function expectedPayout(amount) {
  return Math.round((Number(amount) || 0) * ROI_MULTIPLIER);
}

/** Human summary of the bands, for prompts and the document. */
export const termTableLines = () => [
  "₦500,000 to ₦5,000,000: 6 months",
  "₦5,000,001 to ₦10,000,000: 8 months",
  "₦10,000,001 and above: 12 months",
];

// -----------------------------------------------------------------------------
//  DOCUMENT WORDING
// -----------------------------------------------------------------------------

export const AGREEMENT_TITLE = "PRAST FARMS INVESTMENT AGREEMENT";

/** Sits directly under the title. */
export const preamble =
  'This Investment Agreement ("Agreement") is made and entered into on ' +
  '{{today}}, by and between {{company}} ("Company"), a registered business ' +
  'engaged in {{business}}, and {{investorName}} ("Investor"), who agrees to ' +
  "invest in the pig farming business under the following terms:";

/**
 * Numbered clauses.
 *   body   — paragraph text, may contain {{placeholders}}
 *   lines  — optional list rendered beneath the body
 *   blanks — optional fill-in-by-hand lines
 */
export const clauses = [
  {
    heading: "Investment Amount",
    body:
      "The Investor agrees to invest and confirms that they have invested a " +
      "total amount of {{amount}}.",
  },
  {
    heading: "Terms of Investment",
    body:
      "The Company will use the funds to purchase, raise, and sell livestock " +
      "within its farm operations.\n\n" +
      "Upon sale of the livestock, the Company will pay the Investor a return " +
      "on investment (ROI) of {{roiPercent}}, meaning the Investor will receive " +
      "{{roiTimes}} times the invested amount at the end of the term.\n\n" +
      "In this case, an investment of {{amount}} results in a total payout of " +
      "{{payout}} ({{amount}} capital plus {{profit}} profit), payable at the " +
      "end of the {{termMonths}} month term on {{dueDate}}.",
    // Expanded from the live bands when the document is built — writing the
    // table out here froze it at whatever the rates were on the day.
    lines: ["{{termTable}}"],
    linesHeading: "Investment terms:",
    after: "Payment will be made to the Investor at the end of the applicable investment term.",
  },
  {
    heading: "Payment Details",
    body: "Payment at maturity will be made to the account nominated by the Investor:",
    blanks: ["Bank Name", "Account Name", "Account Number"],
  },
  {
    heading: "Risk Acknowledgment",
    body:
      "The Investor acknowledges that this investment involves risks including " +
      "livestock loss, market fluctuations, and operational risks. The Company " +
      "will apply best practices but does not guarantee outcomes beyond the " +
      "agreed ROI.",
  },
  {
    heading: "Investor's Rights",
    body:
      "The Investor has the right to receive the agreed ROI and has no " +
      "ownership or control over the Company.",
  },
  {
    heading: "Termination",
    body:
      "This Agreement terminates upon full payment. Any issues will be " +
      "resolved mutually.",
  },
  {
    heading: "Dispute Resolution",
    body: "Disputes will be resolved amicably or via arbitration under Nigerian law.",
  },
  {
    heading: "Governing Law",
    body:
      "This Agreement is governed by the laws of the Federal Republic of Nigeria.",
  },
];

export const closing = "";

/**
 * Signature blocks. `image` prints above the line — used for the Company side,
 * which is pre-signed. The Investor signs by hand.
 */
export const signatures = [
  {
    label: "For {{company}}",
    name: "{{signatoryName}}",
    role: "",
    image: COMPANY.signatureImage,
  },
  {
    label: "For the Investor",
    name: "{{investorName}}",
    role: "",
  },
];

/**
 * The supplied wording is specific to pig farming and livestock. It does not
 * describe a Real Estate placement, so the document marks those as needing
 * their own wording rather than issuing an inaccurate agreement.
 */
export const APPLIES_TO_TYPE = "Farm Investment";

/**
 * Wording is now the company's own, so no draft band. Set back to true if you
 * are mid-edit and don't want documents going out.
 */
export const IS_PLACEHOLDER = false;


// =============================================================================
//  DEFAULTS BUNDLE
//
//  Everything above is the built-in fallback. The live values come from the
//  `settings/agreement` document in Firestore, which the owner edits from the
//  portal's Settings screen — so wording, rates and terms can change without
//  anyone touching this file. If that document is missing or a field is blank,
//  these defaults apply.
// =============================================================================

export const DEFAULTS = {
  company: { ...COMPANY },
  roiMultiplier: ROI_MULTIPLIER,
  termBands: TERM_BANDS.map((b) => ({ ...b })),
  agreementTitle: AGREEMENT_TITLE,
  preamble,
  clauses: clauses.map((c) => ({ ...c })),
  closing,
  appliesToType: APPLIES_TO_TYPE,
  isPlaceholder: IS_PLACEHOLDER,
};
