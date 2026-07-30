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
export const DEV_MODE = true;

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
