// =============================================================================
//  PRAST FARMS — PUBLIC ENQUIRY SENDER
//
//  Used by the marketing site to drop a request straight into the staff portal.
//  Writes only; the security rules let anyone create an inquiry but only a
//  signed-in staff member read or approve one.
// =============================================================================

import {
  firebaseConfig,
  PORTAL_PLANS,
  PORTAL_PAYMENT,
} from "./firebase-config.js";

let dbPromise = null;

function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const [{ initializeApp, getApps }, fs] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js"),
    ]);
    const app = getApps()[0] || initializeApp(firebaseConfig);
    return { db: fs.getFirestore(app), fs };
  })();
  return dbPromise;
}

const clip = (v, n) => String(v ?? "").trim().slice(0, n);

/**
 * Send one enquiry. Returns true if it reached the portal.
 * The caller falls back to email if this returns false, so a request is never
 * silently lost when someone is offline.
 */
export async function sendInquiry(data) {
  try {
    const { db, fs } = await getDb();

    // Shape it exactly as the rules expect — an extra field would be rejected.
    //  kind: invest | buy | apply (academy) | job (working here)
    //  product doubles as "what this is about": the produce for an order, the
    //  role for a job application.
    const payload = {
      kind: ["invest", "buy", "apply", "job"].includes(data.kind) ? data.kind : "buy",
      name: clip(data.name, 118),
      phone: clip(data.phone, 38),
      email: clip(data.email, 118).toLowerCase(),
      address: clip(data.address, 290),
      details: clip(data.details, 980),
      product: clip(data.product, 118),
      amount: Number(data.amount) || 0,
      status: "new",
      source: "website",
      createdAt: fs.serverTimestamp(),
    };
    if (!payload.name || !payload.phone) return false;

    await fs.addDoc(fs.collection(db, "inquiries"), payload);
    return true;
  } catch (err) {
    console.warn("[Prast] enquiry could not be sent:", err?.message);
    return false;
  }
}

// =============================================================================
//  PORTAL SUBSCRIPTIONS — another farm signing up to use the software
//
//  Two documents are written: the request itself, which the owner's dashboard
//  listens to, and the receipt image, kept in its own collection so that
//  listener never downloads a photo it is not showing. Nothing here grants
//  access — status is pinned to "pending" and only a signed-in owner can
//  change it, which is what the security rules enforce.
// =============================================================================

/**
 * Shrink a phone photo so it fits inside a Firestore document (~1 MiB cap) and
 * still reads clearly. Deliberately a small copy of db.js's resizeImage: this
 * page must not pull in the whole data layer just to send one form.
 */
export function shrinkReceipt(file, maxEdge = 1300, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) {
      reject(new Error("That file is not an image."));
      return;
    }
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

        // Step the quality down until it is safely under the document limit.
        let q = quality;
        let dataUrl = canvas.toDataURL("image/jpeg", q);
        while (dataUrl.length > 700_000 && q > 0.3) {
          q -= 0.12;
          dataUrl = canvas.toDataURL("image/jpeg", q);
        }
        resolve({ dataUrl, width: w, height: h, bytes: Math.round(dataUrl.length * 0.75) });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Send one farm's subscription request plus its payment receipt.
 * Returns true once both are safely stored.
 */
export async function sendFarmSignup(data, receiptDataUrl) {
  try {
    const plan = PORTAL_PLANS[data.plan] ? data.plan : "3y";
    const { years, amount } = PORTAL_PLANS[plan];
    const { db, fs } = await getDb();

    const payload = {
      farmName: clip(data.farmName, 118),
      contactName: clip(data.contactName, 118),
      email: clip(data.email, 118).toLowerCase(),
      phone: clip(data.phone, 38),
      plan,
      years,
      amount,
      status: "pending",
      source: "website",
      createdAt: fs.serverTimestamp(),
    };
    if (!payload.farmName || !payload.contactName || !payload.email || !payload.phone) {
      return false;
    }

    const ref = await fs.addDoc(fs.collection(db, "licenses"), payload);

    // Written second and keyed by the request id, so a failure here leaves a
    // request she can still chase up rather than an orphaned image.
    if (receiptDataUrl) {
      await fs.setDoc(fs.doc(db, "licenseReceipts", ref.id), {
        image: receiptDataUrl,
        createdAt: fs.serverTimestamp(),
      });
    }
    return true;
  } catch (err) {
    console.warn("[Prast] sign-up could not be sent:", err?.message);
    return false;
  }
}

// The marketing page's own scripts are plain (non-module) functions, so expose
// what they need on the window.
window.sendInquiry = sendInquiry;
window.sendFarmSignup = sendFarmSignup;
window.shrinkReceipt = shrinkReceipt;
window.PORTAL_PLANS = PORTAL_PLANS;
window.PORTAL_PAYMENT = PORTAL_PAYMENT;
