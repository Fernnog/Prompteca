// Conexão com o Firebase: autenticação (e-mail e senha) e Firestore.
// Os modelos ficam em users/{uid}/prompts/{id}, visíveis só para o dono.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot,
  serverTimestamp, deleteField
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

// Cache local persistente: funciona offline e sincroniza automaticamente entre abas.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const promptsCol = uid => collection(db, "users", uid, "prompts");
const promptRef = (uid, id) => doc(db, "users", uid, "prompts", id);

export const watchAuth = cb => onAuthStateChanged(auth, cb);
export const login = (email, senha) => signInWithEmailAndPassword(auth, email.trim(), senha);
export const logout = () => signOut(auth);

export function watchPrompts(uid, onData, onError) {
  return onSnapshot(
    promptsCol(uid),
    { includeMetadataChanges: true },
    snap => onData(
      snap.docs.map(d => ({
        id: d.id,
        ...d.data(),
        pending: d.metadata.hasPendingWrites
      })),
      snap.metadata
    ),
    onError
  );
}

export const newPromptId = uid => doc(promptsCol(uid)).id;

/**
 * Grava o modelo principal ou subprompt de forma isolada.
 * Assim, falhas em referências de filhos nunca abortam o salvamento do texto principal.
 */
export function savePrompt(uid, m) {
  const data = {
    name: m.name,
    body: m.body,
    parentId: m.parentId ?? null,
    order: m.parentId && typeof m.order === "number" ? m.order : deleteField(),
    updatedAt: serverTimestamp()
  };
  return setDoc(promptRef(uid, m.id), data, { merge: true });
}

/**
 * Atualiza filhos transferidos de pai e/ou reordenados de forma isolada via updateDoc,
 * impedindo a criação de documentos-fantasma e evitando que 1 filho ausente derrube os demais.
 */
export async function updateChildrenAfterSave(uid, { reparentEntries = [], orderIds = [] } = {}) {
  const ops = [];
  reparentEntries.forEach(({ id, parentId, order }) => {
    ops.push(
      updateDoc(promptRef(uid, id), {
        parentId: parentId ?? null,
        order: parentId && typeof order === "number" ? order : deleteField()
      })
    );
  });
  orderIds.forEach((sid, idx) => {
    ops.push(updateDoc(promptRef(uid, sid), { order: idx }));
  });
  if (ops.length) await Promise.allSettled(ops);
}

export async function reorderSubPrompts(uid, orderedSubIds = []) {
  const ops = orderedSubIds.map((sid, idx) => updateDoc(promptRef(uid, sid), { order: idx }));
  const results = await Promise.allSettled(ops);
  const rejected = results.find(r => r.status === "rejected" && r.reason?.code !== "not-found");
  if (rejected) throw rejected.reason;
}

export const toggleFavPrompt = (uid, id, fav) =>
  updateDoc(promptRef(uid, id), { fav: !!fav });

export async function deletePromptWithChildren(uid, id, childIds = []) {
  await deleteDoc(promptRef(uid, id));
  if (childIds.length) {
    await Promise.allSettled(
      childIds.map(cid =>
        updateDoc(promptRef(uid, cid), { parentId: null, order: deleteField() })
      )
    );
  }
}

export const deletePrompt = (uid, id) => deleteDoc(promptRef(uid, id));

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

export function saveMessage(err) {
  const c = err?.code || "";
  if (c === "permission-denied")
    return "Permissão negada pelo Firestore. Confira se as Regras de Segurança permitem fav, parentId e order.";
  if (c === "not-found")
    return "Registro ou banco Firestore não encontrado (verifique se o modelo ainda existe ou se o banco Nativo foi criado).";
  if (c === "unauthenticated")
    return "Sessão expirada. Entre novamente para salvar.";
  if (c === "invalid-argument")
    return "Dados inválidos ou texto acima do limite permitido (250 mil caracteres).";
  if (c === "resource-exhausted")
    return "Limite de uso do Firebase atingido. Tente novamente mais tarde.";
  if (c === "unavailable")
    return "Servidor indisponível no momento. Verifique sua conexão.";
  return "Erro ao salvar no Firebase (" + (c || "desconhecido") + ").";
}