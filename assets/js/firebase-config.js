// =============================================================================
//  PRAST FARMS — FIREBASE CONFIGURATION
//  This is the ONLY file you need to edit to connect the site to Firebase.
// =============================================================================

// -----------------------------------------------------------------------------
//  1. FIREBASE CONFIG
//     Project:  prastfarms  ("Prast Farms")
//     Console:  https://console.firebase.google.com/project/prastfarms/overview
//
//     These values identify the project; they are not secrets and are meant to
//     ship in client code. What actually protects the data is firestore.rules.
// -----------------------------------------------------------------------------
export const firebaseConfig = {
  apiKey: "AIzaSyDGXXTrjGYTfZbbyOVjAZa5fli2eEVB-7Q",
  authDomain: "prastfarms.firebaseapp.com",
  projectId: "prastfarms",
  storageBucket: "prastfarms.firebasestorage.app",
  messagingSenderId: "408257225256",
  appId: "1:408257225256:web:4e538062c6a10647454b1d",
};

// -----------------------------------------------------------------------------
//  2. DEV MODE — no access code required
//
//     true  -> the staff portal opens straight to the dashboard. No login wall.
//     false -> the login wall returns (see AUTH note in README before flipping).
//
//     !! Set this to false before the portal handles real client data on a
//     !! public URL. While it is true, anyone who opens portal.html is staff.
// -----------------------------------------------------------------------------
export const DEV_MODE = false;

// -----------------------------------------------------------------------------
//  3. COLLECTION NAME
//     The Firestore collection holding investment records.
// -----------------------------------------------------------------------------
export const RECORDS_COLLECTION = "records";

// -----------------------------------------------------------------------------
//  4. AI ASSISTANT
//     Plain-language record entry, powered by DeepSeek through the `assistant`
//     Cloud Function. The API key lives in Google Secret Manager — never here.
//
//     Set this to true only AFTER deploying the function:
//       firebase functions:secrets:set DEEPSEEK_KEY --project prastfarms
//       firebase deploy --only functions --project prastfarms
//
//     While false, the Assistant tab is hidden and the rest of the portal
//     works exactly the same.
// -----------------------------------------------------------------------------
export const ASSISTANT_ENABLED = true;

// -----------------------------------------------------------------------------
//  5. LEGACY GOOGLE SHEET ENDPOINT
//     Only used by migrate.html to pull the old records across ONCE.
//     After a successful migration you can delete migrate.html and this line.
// -----------------------------------------------------------------------------
export const LEGACY_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycby901f9aG5P7dfL2aHYIRLEdOpZ4JSifJT-Kp3VoKBpa6FylRwId5bHia4ioKEO-bno/exec";

// -----------------------------------------------------------------------------
//  6. PRAST PORTAL SUBSCRIPTIONS — other farms paying to use this software
//
//     Change a price here and it changes everywhere: the sign-up form, the
//     approval screen in the portal, and the expiry date worked out on approval.
//     The three headline prices printed on the website's pricing cards are in
//     index.html — update both if you change them.
// -----------------------------------------------------------------------------
export const PORTAL_PLANS = {
  "1y":  { years: 1,  amount:  40000, label: "1 year",   note: "₦40,000 per year" },
  "3y":  { years: 3,  amount: 100000, label: "3 years",  note: "₦33,333 per year" },
  "10y": { years: 10, amount: 250000, label: "10 years", note: "₦25,000 per year" },
};

// -----------------------------------------------------------------------------
//  7. WHERE SUBSCRIBING FARMS SEND THEIR MONEY
//
//     !! FILL THIS IN. While accountNumber is empty the sign-up form tells them
//     !! to call the phone number below for the account details instead of
//     !! showing an account that does not exist.
// -----------------------------------------------------------------------------
export const PORTAL_PAYMENT = {
  bank: "",             // e.g. "Zenith Bank"
  accountName: "",      // e.g. "Prast Integrated Services"
  accountNumber: "",    // e.g. "1234567890"
  phone: "+2348084219956",
};

// -----------------------------------------------------------------------------
//  8. PUBLIC CHATBOT on the website
//
//     Answers questions from visitors in English, Nigerian Pidgin, Igbo, Yoruba
//     and Hausa. Runs through the `ask` Cloud Function, which holds the API key
//     and the facts it is allowed to state.
//
//     Set this to true only AFTER deploying the function:
//       firebase deploy --only functions:ask --project prastfarms
//
//     While it is false the chat button does not appear and the site is
//     unaffected. It is a public, paid endpoint — read the abuse notes in the
//     README before turning it on.
// -----------------------------------------------------------------------------
export const CHATBOT_ENABLED = true;

// The number the chat offers when it cannot answer something.
export const CONTACT_PHONE = "+2348084219956";
export const CONTACT_PHONE_PRETTY = "+234 808 421 9956";
