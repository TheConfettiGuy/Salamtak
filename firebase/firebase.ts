import { initializeApp, getApps } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously, setPersistence, browserLocalPersistence } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Singleton anonymous sign-in to prevent double UIDs
let anonInit: Promise<string> | null = null;

export async function ensureAnon(): Promise<string> {
  if (typeof window === "undefined") throw new Error("ensureAnon() must run in browser");
  const auth = getAuth(app);
  await setPersistence(auth, browserLocalPersistence);

  if (auth.currentUser) return auth.currentUser.uid;
  if (anonInit) return anonInit;

  anonInit = (async () => {
    const cred = await signInAnonymously(auth);
    return cred.user.uid;
  })();

  try {
    return await anonInit;
  } finally {
    anonInit = null;
  }
}
