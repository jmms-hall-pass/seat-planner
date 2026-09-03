// ============================================================
// FIREBASE CONFIG
// ============================================================
// Go to https://console.firebase.google.com -> your project ->
// gear icon (Project settings) -> General tab -> scroll to
// "Your apps" -> click the </> (web) icon to register a web app
// (or click your existing web app) -> copy the firebaseConfig
// object it gives you and paste the values below.
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyDhaMUR5-FACIcmoTsZID40JD2z57m7Kuc",
  authDomain: "seatingchart-afb1c.firebaseapp.com",
  projectId: "seatingchart-afb1c",
  storageBucket: "seatingchart-afb1c.firebasestorage.app",
  messagingSenderId: "622439912973",
  appId: "1:622439912973:web:2af446e4b16f7421cfe744",
};

// A "room code" lets you keep more than one class/room in the
// same Firebase project without them overwriting each other.
// Change this per class if you teach more than one room, e.g.
// "period-2" or "homeroom-2026". Leave as "default" if you only
// need one.
const ROOMS = [
  "Period 2",
  "Period 3",
  "Period 4",
  "Period 5",
  "Period 6",
  "Polar Time",
  "Period 9",
  "Period 10",
];

// ============================================================
// ACCESS CONTROL
// ============================================================
// Only these Google accounts will be allowed to open the app.
// List the exact Gmail/Google-Workspace addresses, e.g.:
//   const ALLOWED_EMAILS = ["you@gmail.com", "co.teacher@school.edu"];
// This list is just used to show a friendly "not authorized"
// screen — the REAL security check is the allow-list you put in
// your Firestore Rules (see README Part 1, step 6). Both lists
// must match or a permitted person will sign in here but still
// get blocked by Firestore.
const ALLOWED_EMAILS = [
  "jaf2jc@bearworks.sparcc.org",
];
