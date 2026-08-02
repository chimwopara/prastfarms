# Prast Farms

Marketing site and staff investment tracker for [prastfarms.com](https://prastfarms.com),
served as a static site from GitHub Pages.

## Layout

```
index.html            Public marketing site
portal.html           Staff portal — one dashboard, chat-driven entry
renew.html            Client-facing renewal page (opened from the reminder email)
migrate.html          One-time Google Sheet -> Firestore importer (delete after use)
privacy.html
terms.html
firestore.rules       Firestore security rules — paste into the Firebase console

assets/
  img/                All images and logos
  js/
    firebase-config.js  <- Firebase settings + feature switches
    agreement.js        <- YOUR AGREEMENT WORDING GOES HERE
    db.js               Shared Firestore data layer
    assistant.js        Chat + field extraction
    document.js         Invoice + agreement + receipt PDF

functions/
  index.js            Cloud Function proxying the AI assistant to DeepSeek

legacy/
  code.gs             The retired Google Apps Script, kept for reference
```

HTML pages stay at the repo root on purpose — moving them would change live
URLs like `prastfarms.com/portal.html` and break the renewal links already
sent out by email.

## Firebase

Already provisioned — nothing to set up.

| | |
|---|---|
| Project ID | `prastfarms` |
| Owner account | rwopara@gmail.com |
| Firestore location | `nam5` (multi-region US) |
| Console | https://console.firebase.google.com/project/prastfarms/overview |

The config lives in `assets/js/firebase-config.js` and the rules in
`firestore.rules`. Redeploy rules after editing them:

```sh
firebase deploy --only firestore:rules --project prastfarms
```

The values in `firebase-config.js` are project identifiers, not secrets — they
are designed to ship in client-side code. Access is controlled by
`firestore.rules`, not by hiding the API key.

### Running locally

The pages use ES modules, which browsers refuse to load over `file://`.
Serve the folder instead:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/portal.html
```

On GitHub Pages this is a non-issue — it's already served over HTTPS.

## Migrating from the Google Sheet

Open `migrate.html`, enter the old Apps Script access code, review the preview,
and import. It preserves each sheet row number as `legacyRow`, so renewal links
already emailed out (`renew.html?id=42`) still resolve after the move.

Delete `migrate.html` once the totals in the portal match the sheet.

## How the portal works

One screen. Overview at the top, investments below — tap any one for its
actions (send document, mark paid, change by chat, renew, delete).

**Adding an investment** is a conversation. It asks for a photo of the
investor's payment receipt first; Gemini reads the name, amount, date and type
off it, then DeepSeek asks only for whatever is still missing. Nothing is
written until she taps Save.

Two models, two jobs: Gemini reads images (DeepSeek has no vision model),
DeepSeek handles the conversation.

## The shareable document

`document.js` builds a single 3-page PDF — **invoice, agreement letter, payment
receipt** (with the investor's own receipt photo embedded). It shares via the
phone's share sheet, or downloads on desktop. Regenerate it any time from a
record's actions.

**The agreement wording in `assets/js/agreement.js` is a placeholder and has
not been reviewed by a lawyer.** While `IS_PLACEHOLDER = true` every generated
agreement page carries a visible "DRAFT — WORDING NOT FINALISED" band, so a
placeholder can't be mistaken for the real thing. Replace the `clauses` array
with your own text and set that flag to `false`.

Receipt photos live in a separate `receipts` collection so the dashboard's live
listener never downloads image data. Photos are resized client-side to 1400px
before upload, keeping them inside Firestore's 1 MiB document limit.

### Setup

Already deployed. Both `assistant` and `readReceipt` are live in `us-central1`,
with `DEEPSEEK_KEY` and `GEMINI_KEY` in Secret Manager.

Requires the **Blaze** plan. Cloud Functions on the free Spark plan cannot make
outbound calls to third-party APIs like DeepSeek — that restriction is Google's
and cannot be worked around. Blaze includes 2M free invocations/month, so this
workload costs effectively nothing.

To redeploy after editing `functions/index.js`:

```sh
firebase deploy --only functions
```

To rotate a key:

```sh
firebase functions:secrets:set DEEPSEEK_KEY   # or GEMINI_KEY
firebase deploy --only functions
```

`GEMINI_KEY` is an API key restricted to `generativelanguage.googleapis.com`
only, so it cannot be used against anything else in the project.

**Gemini model names move.** `gemini-2.0-flash` and `gemini-2.5-flash` were both
retired during development. `functions/index.js` therefore tries
`gemini-flash-latest` first and falls back to a pinned model, so a retirement
degrades instead of breaking.

**Where the key lives:** Google Secret Manager, injected into the function at
runtime. It is never in this repo and never reaches the browser. A DeepSeek key
is a billable secret — unlike the Firebase config, it cannot ship in
client-side JavaScript, or anyone could read it from the page source and spend
your balance.

To rotate it, re-run `functions:secrets:set` and redeploy.

### Cost controls

`functions/index.js` caps `maxInstances` at 3 and limits conversation length,
so a runaway loop cannot run up a bill.

**While `REQUIRE_AUTH` is `false` in `functions/index.js`, anyone who knows the
project id can invoke the function and spend your DeepSeek balance.** Set it to
`true` once staff sign in (see Access control below). For stronger protection,
enable Firebase App Check, which blocks calls that don't come from your app.

## Bookkeeping — bank statements

Upload a bank statement PDF from the dashboard ("Upload a bank statement") and
Gemini reads out every transaction, proposes a category set **from what is
actually in your statement** rather than a guessed chart of accounts, and shows
totals before anything is saved.

**Reconciliation check.** The importer adds opening balance + credits − debits
and compares it to the stated closing balance. If they don't match it says so
and by how much, because a silently-incomplete import would corrupt the books.
A clean import reports "Everything adds up".

**Re-importing is safe.** Each transaction's document id is a content hash of
date + direction + amount + description, so overlapping statements update rather
than duplicate. Re-importing the same month adds 0 rows.

**It learns who people are.** When a payee appears that it hasn't seen, it asks
"Who is this?" with one tap for investor / staff / supplier / buyer / owner /
bank. The answer is saved to the `payees` collection and it never asks again.

The saved answer is a *fallback*, not an override: the AI's own reading of the
narration wins when it is clear. That matters because one person can appear in
several categories — a farm hand paid a salary who is also reimbursed for feed.
Tested explicitly.

`legacy/code.gs` remains the only place any of this used to live; nothing here
touches the Google Sheet.

## Calendar & charts

"Calendar & charts" on the dashboard reads pre-computed monthly summaries
(~70 documents) rather than the ten thousand transactions, so it opens instantly.

- **Profit / Money in / Money out**, per account, per year.
- **Missing months are drawn as striped gaps, never as zero** — a month with no
  statement is not a month with no trade.
- Gaps are reported **per account**. With every account combined, one account's
  missing month can be hidden by another, so the view defaults to the UBA
  business account and says which account a gap belongs to.
- The **year filter** exists because the business grew about twentyfold: on a
  single 2023-2026 scale the early months collapse to slivers. Picking a year
  re-fits the scale to that year.
- The **calendar** shades each day by how far the money moved that day.

Series colours were validated with the data-viz palette checker against this
app's surface. Deliberately **not** green-versus-red: that is the pair most
common colour blindness cannot separate. Profit/loss uses blue/red with a
neutral midpoint, and every figure is labelled so colour never carries meaning
alone.

## Access control

`DEV_MODE` in `assets/js/firebase-config.js` is currently **`true`**, which is
what removes the access code: the portal opens straight to the dashboard.

**While `DEV_MODE` is true, anyone who opens `portal.html` has full read and
write access to client financial records.** The rules in `firestore.rules` are
correspondingly open, and expire on 2026-09-30 so they can't be left that way
silently.

To lock it down:

1. Console → Authentication → Sign-in method → enable **Email/Password**,
   then add each staff member as a user.
2. Set `DEV_MODE = false`.
3. Swap the testing rule in `firestore.rules` for the production block.

4. Set `REQUIRE_AUTH = true` in `functions/index.js` and redeploy, so the AI
   functions also refuse anonymous callers.

The email/password login screen is built into `portal.html` and appears
automatically once `DEV_MODE` is `false`.

## The website chatbot

A bubble in the corner of `index.html` answers questions from visitors. Client
in `assets/js/chat.js`, brain in the `ask` Cloud Function.

Turn it on:

```bash
firebase deploy --only functions:ask --project prastfarms
# then set CHATBOT_ENABLED = true in assets/js/firebase-config.js
```

While `CHATBOT_ENABLED` is `false` the bubble does not render and the site is
untouched.

**It can only say what it has been told.** Everything the bot may state as fact
lives in `FARM_FACTS` inside `functions/index.js` — branches, the five products,
the Academy, jobs, and the Prast Portal plans. Edit that block to change what it
knows; nothing in the browser holds any business facts, so the answers cannot
drift from it. It is explicitly forbidden from inventing a produce price, and
from quoting, estimating or hinting at an investment return, percentage or
payout — those go to a human. Anything it does not know ends with the phone
number.

**Languages.** It replies in whatever language it was asked in. Nigerian Pidgin
is treated as a first-class language, not broken English, and the prompt carries
a list of the phonetic spellings and shorthand people actually type ("chikn",
"hw much", "bole", "wrk"). Igbo, Yoruba and Hausa work reasonably. The Rivers
State languages — Ikwerre, Izon, Ogoni, Etche, Efik — are hit-and-miss with this
model, so the prompt tells it to fall back to Pidgin, which is understood across
Port Harcourt, rather than guess badly.

**Replies can carry actions.** The function returns up to three from a fixed
list (`call`, `whatsapp`, `buy`, `invest`, `academy`, `job`, `portal`,
`locations`, `products`) and the page renders them as buttons — "Place an order"
opens the order form with the right product already selected. Anything outside
that list is dropped, so a confused model cannot make the page do something odd.

### Cost and abuse

Unlike the portal assistant, this endpoint has **no sign-in wall** — anyone can
call it, and every call costs money. What bounds it:

| Control | Value |
|---|---|
| `maxInstances` | 2 — the hard ceiling on concurrent spend |
| `max_tokens` | 450 per reply |
| Messages per chat | 14, and 2,600 characters total |
| Per IP | 10/minute, 50/hour |

The per-IP limit is held in memory, so it is per instance and approximate — a
speed bump against a casual script, not a security control. **Firebase App Check
is the proper fix** and is worth adding before this gets any real traffic. Set a
billing budget alert on the project either way.

## Applications — `apply.html`

Everything someone applies *to us* for lives on one page, reached from **Work
With Us** in the nav and from the Academy section:

- **Work with us** — job applications. Saved as an inquiry with `kind: "job"`,
  the role they picked stored in `product`.
- **Prast Academy** — the summer class. `kind: "apply"`, `product: "Academy"`.

`apply.html#academy` opens straight onto the Academy form, which is what the
landing page's *Apply for Summer Class* button links to. Both forms are plain
single-screen forms rather than the one-question-at-a-time flow the product
enquiries use — an application is longer, and people want to see the whole thing.

"Apply" used to be a third button on every product, next to Buy and Invest,
where it read as a way to apply *for a pig*. Products now offer only the two
actions that are actually about the product.

In the portal these land in their own **New applications** block, separate from
purchase requests, and each card shows the applicant's email as well as phone.

## Selling the portal to other farms

The website's **Prast Portal for Your Farm** section (`#portal` in `index.html`)
sells access to this software. A farm picks a term, transfers the money, uploads
a photo of the receipt, and the request lands in the owner's dashboard as
*pending*. Nothing is granted automatically — she looks at the receipt against
her own account, then approves, and only that sets the start and expiry dates.

Prices and the receiving bank account live in `assets/js/firebase-config.js`:

```js
export const PORTAL_PLANS = { "1y": …, "3y": …, "10y": … };
export const PORTAL_PAYMENT = { bank, accountName, accountNumber, phone };
```

**`PORTAL_PAYMENT` ships empty.** Until `accountNumber` is filled in, the sign-up
form tells the farm to call for the account details instead of showing one that
does not exist. The three headline prices are also printed on the pricing cards
in `index.html` — change both if you change a price.

Two collections back it:

| Collection | Holds | Who can write |
|---|---|---|
| `licenses` | one document per farm that signed up | anyone may **create**, pinned to `status: "pending"`; only signed-in staff may read or change one |
| `licenseReceipts` | their payment photo, keyed by the licence id | create-only, and only against a `licenses` document that already exists |

The receipt is kept in its own collection so the dashboard's live listener never
downloads image data; it is fetched only when she opens a request. Photos are
shrunk in the browser to stay under Firestore's ~1 MiB document limit.

Approving records the sale and works out the expiry date. It does **not** create
their Firebase Auth user — do that once in the console, then use *Email them
their login* on the approved request to send them the sign-in link. Note that
every account today sees the same Firestore data; giving each farm its own
records is a separate piece of work (see below).

## Known follow-up

`legacy/code.gs` also ran `checkDueDateAndSendEmail`, a daily trigger that
emailed due-date reminders with renewal links. That trigger reads the Google
Sheet, so it stops reflecting reality once the portal writes to Firestore.
The dashboard surfaces the same information in-app (overdue and due-soon counts,
with those records sorted to the top); restoring automated email would need a
scheduled Cloud Function.

**Multi-tenancy.** Subscribing farms can be sold access and approved, but every
signed-in account currently reads the same `records`, `transactions` and
`settings`. Before a second farm is actually let in, each document needs a
`farmId`, the security rules need to compare it against a custom claim on the
user, and the queries in `db.js` need to filter by it. Expiry is likewise
recorded but not yet enforced at sign-in.
