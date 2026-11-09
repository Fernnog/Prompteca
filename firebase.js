// Conexão com o Firebase: autenticação (e-mail e senha) e Firestore.
// Os modelos ficam em users/{uid}/prompts/{id}, visíveis só para o dono.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, deleteDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC8-OdhIDPVJet1uCsqcwddnccgi0jfrCo",
  authDomain: "prompteca-75112.firebaseapp.com",
  projectId: "prompteca-75112",
  storageBucket: "prompteca-75112.firebasestorage.app",
  messagingSenderId: "428962540194",
  appId: "1:428962540194:web:eaa5eb889157b8273bc5fb",
  measurementId: "G-82M9L33B4W"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Cache local: a lista abre na hora e continua funcionando sem internet.
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
} catch (e) {
  db = initializeFirestore(app, {});
}

const promptsCol = uid => collection(db, "users", uid, "prompts");

export const watchAuth = cb => onAuthStateChanged(auth, cb);
export const login = (email, senha) => signInWithEmailAndPassword(auth, email.trim(), senha);
export const logout = () => signOut(auth);

export function watchPrompts(uid, onData, onError) {
  return onSnapshot(promptsCol(uid),
    snap => onData(snap.docs.map(d => ({ id: d.id, ...d.data() })), snap.metadata),
    onError);
}

export const newPromptId = uid => doc(promptsCol(uid)).id;

export const savePrompt = (uid, m) =>
  setDoc(doc(db, "users", uid, "prompts", m.id),
    { name: m.name, body: m.body, updatedAt: serverTimestamp() });

export const deletePrompt = (uid, id) => deleteDoc(doc(db, "users", uid, "prompts", id));

export function authMessage(err) {
  const c = err?.code || "";
  if (c === "auth/invalid-credential" || c === "auth/wrong-password" || c === "auth/user-not-found")
    return "E-mail ou senha incorretos.";
  if (c === "auth/invalid-email") return "Digite um e-mail válido.";
  if (c === "auth/too-many-requests") return "Muitas tentativas. Aguarde alguns minutos e tente de novo.";
  if (c === "auth/network-request-failed") return "Sem conexão. Verifique a internet.";
  if (c === "auth/user-disabled") return "Este usuário está desativado.";
  return "Não foi possível entrar. Tente de novo.";
}
