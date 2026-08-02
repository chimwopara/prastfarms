// =============================================================================
//  PRAST FARMS — PUBLIC CHATBOT
//
//  The bubble in the corner of the website. Questions go to the `ask` Cloud
//  Function, which holds the API key and the only facts the bot may state.
//  Nothing here knows anything about the business — deliberately, so the
//  answers cannot drift away from what the function was told.
//
//  Answers come back in whatever language the visitor wrote in: English,
//  Nigerian Pidgin, Igbo, Yoruba, Hausa, or Pidgin as the fallback.
// =============================================================================

import {
  firebaseConfig,
  CHATBOT_ENABLED,
  CONTACT_PHONE,
  CONTACT_PHONE_PRETTY,
} from "./firebase-config.js";

// --- talking to the function -------------------------------------------------

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
    return httpsCallable(getFunctions(app, "us-central1"), "ask");
  })();
  return callablePromise;
}

/**
 * What to say when the call fails.
 *
 * A stranger on a phone cannot act on "internal", so every failure ends with
 * the same thing a failure should end with: the phone number.
 */
function failureMessage(err) {
  const code = String(err?.code || "").replace(/^functions\//, "");
  const raw = String(err?.message || "");

  // Our own HttpsError messages are real sentences; codes are single words.
  if (raw.includes(" ") && raw.length > 12 && code === "resource-exhausted") return raw;

  if (code === "resource-exhausted") {
    return `That's a lot of questions at once — give it a minute. Or call us on ${CONTACT_PHONE_PRETTY}.`;
  }
  if (code === "invalid-argument") {
    return "This chat has got long. Tap the refresh arrow above to start a new one.";
  }
  return `Sorry — I can't reach our system right now. Please call us on ${CONTACT_PHONE_PRETTY} and someone will help you straight away.`;
}

// --- the actions the bot may offer -------------------------------------------
//
//  The function returns names from a fixed list; this maps each to something
//  the page can actually do. Anything unrecognised is simply not rendered.

const ACTIONS = {
  call: {
    label: "Call us",
    icon: "phone",
    run: () => { window.location.href = `tel:${CONTACT_PHONE}`; },
  },
  whatsapp: {
    label: "WhatsApp",
    icon: "comment",
    run: () => window.open(`https://wa.me/${CONTACT_PHONE.replace(/\D/g, "")}`, "_blank", "noopener"),
  },
  buy: {
    label: "Place an order",
    icon: "basket-shopping",
    run: (product) => openProduct("Buy", product),
  },
  invest: {
    label: "Talk about investing",
    icon: "arrow-trend-up",
    run: (product) => openProduct("Invest", product),
  },
  academy: {
    label: "Apply to the Academy",
    icon: "graduation-cap",
    run: () => { window.location.href = "apply.html#academy"; },
  },
  job: {
    label: "Apply for a job",
    icon: "briefcase",
    run: () => { window.location.href = "apply.html"; },
  },
  portal: {
    label: "See the software plans",
    icon: "laptop",
    run: () => goToSection("portal"),
  },
  locations: {
    label: "See our branches",
    icon: "location-dot",
    run: () => goToSection("branches"),
  },
  products: {
    label: "See what we sell",
    icon: "leaf",
    run: () => goToSection("products"),
  },
};

function goToSection(id) {
  const el = document.getElementById(id);
  if (!el) { window.location.href = `index.html#${id}`; return; }
  closePanel();
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openProduct(action, product) {
  // The order form lives in the landing page's own script.
  if (typeof window.openProductActionModal === "function") {
    closePanel();
    window.openProductActionModal(action, product || "Pigs");
  } else {
    window.location.href = "index.html#products";
  }
}

// --- the widget ---------------------------------------------------------------

const OPENERS = [
  "What do you sell?",
  "Wetin una dey sell?",
  "Where are your farms?",
  "How I fit invest?",
  "Tell me about the Academy",
];

const GREETING =
  "Hello 👋 I'm the Prast Farms assistant. Ask me anything about our farms, " +
  "what we sell, the Academy, or working with us.\n\n" +
  "You fit talk Pidgin, Igbo, Yoruba or Hausa — I go answer you for the same language.";

let history = [];      // what we send up: [{role, content}]
let busy = false;
let els = {};

function init() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build, { once: true });
  } else {
    build();
  }
}

function build() {
  const root = document.createElement("div");
  root.id = "prastChat";
  root.innerHTML = `
    <button id="pcLauncher" type="button" aria-label="Ask Prast Farms a question" aria-expanded="false">
      <i class="fas fa-comment-dots"></i>
      <span class="pc-ping"></span>
    </button>

    <div id="pcPanel" role="dialog" aria-modal="false" aria-labelledby="pcTitle" hidden>
      <div class="pc-head">
        <div class="pc-who">
          <span class="pc-avatar"><i class="fas fa-seedling"></i></span>
          <div>
            <div id="pcTitle">Ask Prast Farms</div>
            <div class="pc-sub">English · Pidgin · Igbo · Yoruba · Hausa</div>
          </div>
        </div>
        <div class="pc-tools">
          <button type="button" id="pcReset" aria-label="Start a new chat"><i class="fas fa-rotate-left"></i></button>
          <button type="button" id="pcClose" aria-label="Close chat"><i class="fas fa-xmark"></i></button>
        </div>
      </div>

      <div id="pcLog" role="log" aria-live="polite"></div>

      <form id="pcForm" autocomplete="off">
        <input id="pcInput" type="text" maxlength="600" placeholder="Ask your question…"
               aria-label="Your question" enterkeyhint="send">
        <button type="submit" id="pcSend" aria-label="Send"><i class="fas fa-paper-plane"></i></button>
      </form>
    </div>`;

  document.body.appendChild(root);

  els = {
    launcher: root.querySelector("#pcLauncher"),
    panel: root.querySelector("#pcPanel"),
    log: root.querySelector("#pcLog"),
    form: root.querySelector("#pcForm"),
    input: root.querySelector("#pcInput"),
    send: root.querySelector("#pcSend"),
  };

  els.launcher.addEventListener("click", () => (isOpen() ? closePanel() : openPanel()));
  root.querySelector("#pcClose").addEventListener("click", closePanel);
  root.querySelector("#pcReset").addEventListener("click", reset);
  els.form.addEventListener("submit", onSubmit);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) { closePanel(); els.launcher.focus(); }
  });

  reset();
}

const isOpen = () => !els.panel.hidden;

function openPanel() {
  els.panel.hidden = false;
  els.launcher.setAttribute("aria-expanded", "true");
  els.launcher.querySelector("i").className = "fas fa-xmark";
  document.getElementById("prastChat").classList.add("open");
  // Opening the keyboard on a phone the instant it opens is unwelcome.
  if (window.matchMedia("(min-width: 768px)").matches) {
    setTimeout(() => els.input.focus(), 220);
  }
  scrollLog();
}

function closePanel() {
  els.panel.hidden = true;
  els.launcher.setAttribute("aria-expanded", "false");
  els.launcher.querySelector("i").className = "fas fa-comment-dots";
  document.getElementById("prastChat").classList.remove("open");
}

function reset() {
  history = [];
  els.log.innerHTML = "";
  bubble(GREETING, "bot");
  suggestions();
  scrollLog();
}

// --- rendering ---------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function bubble(text, who) {
  const el = document.createElement("div");
  el.className = `pc-msg pc-${who}`;
  // Model output is escaped, then only newlines are turned back into markup.
  el.innerHTML = esc(text).replace(/\n/g, "<br>");
  els.log.appendChild(el);
  return el;
}

function suggestions() {
  const wrap = document.createElement("div");
  wrap.className = "pc-chips";
  OPENERS.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = q;
    b.addEventListener("click", () => { wrap.remove(); send(q); });
    wrap.appendChild(b);
  });
  els.log.appendChild(wrap);
}

function actionRow(actions, product) {
  const usable = actions.filter((a) => ACTIONS[a]);
  if (!usable.length) return;

  const wrap = document.createElement("div");
  wrap.className = "pc-actions";
  usable.forEach((key) => {
    const { label, icon, run } = ACTIONS[key];
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<i class="fas fa-${icon}"></i> ${esc(label)}`;
    b.addEventListener("click", () => run(product));
    wrap.appendChild(b);
  });
  els.log.appendChild(wrap);
}

function typing() {
  const el = document.createElement("div");
  el.className = "pc-msg pc-bot pc-typing";
  el.innerHTML = "<span></span><span></span><span></span>";
  els.log.appendChild(el);
  scrollLog();
  return el;
}

function scrollLog() {
  requestAnimationFrame(() => { els.log.scrollTop = els.log.scrollHeight; });
}

// --- sending -----------------------------------------------------------------

function onSubmit(e) {
  e.preventDefault();
  const q = els.input.value.trim();
  if (!q) return;
  els.input.value = "";
  send(q);
}

async function send(question) {
  if (busy) return;
  busy = true;
  els.send.disabled = true;
  els.log.querySelector(".pc-chips")?.remove();

  bubble(question, "me");
  history.push({ role: "user", content: question });
  scrollLog();

  const dots = typing();

  try {
    const call = await getCallable();
    const { data } = await call({ messages: history });

    dots.remove();
    bubble(data.reply, "bot");
    history.push({ role: "assistant", content: data.reply });
    actionRow(data.actions || [], data.product);
  } catch (err) {
    dots.remove();
    bubble(failureMessage(err), "bot");
    // A failed turn is not part of the conversation, so drop the question
    // rather than leaving an unanswered user message in the history.
    history.pop();
    actionRow(["call", "whatsapp"], null);
  } finally {
    busy = false;
    els.send.disabled = false;
    scrollLog();
  }
}

// Started from the bottom of the module on purpose: this file is deferred, so
// build() runs synchronously, and starting any higher would touch `els` and the
// other `let` bindings before they are initialised.
if (CHATBOT_ENABLED) init();
