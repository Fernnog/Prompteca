import {
  watchAuth, login, logout, watchPrompts, newPromptId,
  savePrompt, updateChildrenAfterSave, reorderSubPrompts,
  toggleFavPrompt, deletePromptWithChildren,
  authMessage, saveMessage
} from "./firebase.js?v=3";
import {
  detectMarkdown, classifyHtmlPaste, htmlToMarkdown,
  renderMarkdown, highlightMarkdownBackdrop
} from "./markdown.js?v=4";

const I = {
  plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  play:'<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
  edit:'<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/></svg>',
  trash:'<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  copy:'<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  check:'<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  field:'<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M7 10v4M10 12h7"/></svg>',
  save:'<svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/></svg>',
  x:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  star:'<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  branch:'<svg viewBox="0 0 24 24"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  sub:'<svg class="sub-ic" viewBox="0 0 24 24"><path d="M6 4v10a4 4 0 0 0 4 4h8"/><path d="m15 15 3 3-3 3"/></svg>'
};

const FIELD_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fieldsOf = body => { const out=[]; for (const m of body.matchAll(FIELD_RE)) if(!out.includes(m[1])) out.push(m[1]); return out; };
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const norm = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const state = {
  user: null, authReady: false, models: [], current: null, mode: 'list', // 'list' | 'use' | 'edit'
  values: {}, query: '', confirmKey: null, loaded: false,
  execParentId: null, activeRoutineParentId: null
};

const ui = {
  peekOpenById: {},
  routineProgress: new Map(), // Map<parentId, Set<subId | 'ROOT'>>
  flashIds: new Set(),
  organizeMode: false,
  returnFocusEl: null
};

let unsubPrompts = null;
let draft = null;
let savedRange = { s: 0, e: 0 };
let searchTimer = null;

const EDITOR_VIEW_KEY = 'prompteca_editor_view';
const splitMQ = matchMedia('(min-width: 860px)');
const canSplitEditor = () => splitMQ.matches;

let previewTimer = null;
let syncRaf = 0;
let scrollRaf = 0;
let lastChipsSig = null;
let plainPasteUntil = 0;
let pasteActionSnapshot = null;

function readSavedEditorView() {
  try {
    const v = localStorage.getItem(EDITOR_VIEW_KEY);
    return (v === 'edit' || v === 'split' || v === 'preview') ? v : null;
  } catch (_) { return null; }
}

function saveEditorView(view) {
  try { localStorage.setItem(EDITOR_VIEW_KEY, view); } catch (_) {}
}

// Rebaixa automaticamente o modo Dividido se a janela cair abaixo de 860px (preservando preferência salva)
splitMQ.addEventListener('change', () => {
  if (state.mode === 'edit' && draft?.view === 'split' && !splitMQ.matches) {
    setEditorView('edit', { focus: false, remember: false });
  }
});

/* ---------- Modo "Organizar" (Especialmente útil em Mobile/Toque) ---------- */
const orgBtn = $('#orgBtn');
function syncOrganizeMode() {
  $('#side')?.classList.toggle('organize-mode', ui.organizeMode);
  if (orgBtn) {
    orgBtn.setAttribute('aria-pressed', String(ui.organizeMode));
    orgBtn.textContent = ui.organizeMode ? 'Concluir' : 'Organizar';
  }
}
orgBtn?.addEventListener('click', () => {
  ui.organizeMode = !ui.organizeMode;
  syncOrganizeMode();
});

/* ---------- Persistência de Sessão da Rotina ---------- */
function saveRoutineSession() {
  if (!state.user) return;
  try {
    const obj = {};
    ui.routineProgress.forEach((set, pid) => { obj[pid] = Array.from(set); });
    sessionStorage.setItem(`prompteca_routine_${state.user.uid}`, JSON.stringify({
      activeParentId: state.activeRoutineParentId,
      map: obj
    }));
  } catch (_) {}
}

function loadRoutineSession(uid) {
  ui.routineProgress.clear();
  state.activeRoutineParentId = null;
  if (!uid) return;
  try {
    const raw = sessionStorage.getItem(`prompteca_routine_${uid}`);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.activeRoutineParentId = parsed.activeParentId || null;
    if (parsed.map && typeof parsed.map === 'object') {
      Object.entries(parsed.map).forEach(([pid, arr]) => {
        if (Array.isArray(arr) && arr.length) ui.routineProgress.set(pid, new Set(arr));
      });
    }
  } catch (_) {}
}

/* ---------- Visibilidade do Modal, Inércia de Fundo e Gestão de Foco ---------- */
function syncPanelVisibility() {
  const isOpen = state.mode === 'edit' || state.mode === 'use';
  const panel = $('#panel');
  const side = $('#side');
  const scrim = $('#scrim');
  const root = $('#appRoot');

  if (panel) {
    panel.hidden = !isOpen;
    if (state.mode !== 'edit') {
      panel.classList.remove('panel-wide');
      clearTimeout(previewTimer);
      cancelAnimationFrame(syncRaf);
      cancelAnimationFrame(scrollRaf);
      pasteActionSnapshot = null;
    }
  }
  if (side) side.toggleAttribute('inert', isOpen);
  if (scrim) scrim.classList.toggle('on', isOpen);
  if (root) root.dataset.panelOpen = String(isOpen);
}

function rememberFocus(el) {
  if (el && el instanceof HTMLElement) ui.returnFocusEl = el;
  else if (document.activeElement instanceof HTMLElement) ui.returnFocusEl = document.activeElement;
}

function restoreFocus() {
  const target = ui.returnFocusEl;
  ui.returnFocusEl = null;
  if (target && document.body.contains(target)) {
    setTimeout(() => target.focus({ preventScroll: true }), 0);
  }
}

function closePanel() {
  if (state.mode === 'edit' && !leaveEdit()) return;
  draft = null;
  state.mode = 'list';
  state.current = null;
  renderList();
  renderMain();
  restoreFocus();
}

$('#closePanelBtn')?.addEventListener('click', closePanel);
$('#scrim')?.addEventListener('click', closePanel);

document.addEventListener('selectionchange', () => {
  if (state.mode !== 'edit') return;
  const ta = $('#ta');
  if (ta && document.activeElement === ta) {
    savedRange = { s: ta.selectionStart, e: ta.selectionEnd };
  }
});

/* ---------- Conta ---------- */
const userBtn = $('#userBtn'), pop = $('#authPop');
function openPop(){ pop.hidden = false; userBtn.setAttribute('aria-expanded','true');
  if(!state.user) setTimeout(()=>$('#email').focus(),0); }
function closePop(){ pop.hidden = true; userBtn.setAttribute('aria-expanded','false'); }
userBtn.addEventListener('click',()=> pop.hidden ? openPop() : closePop());
document.addEventListener('mousedown',e=>{ if(!pop.hidden && !e.target.closest('.auth')) closePop(); });

$('#loginForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const email=$('#email').value, senha=$('#senha').value, err=$('#authErr'), btn=$('#entrar');
  if(!email.trim()||!senha){ err.textContent='Preencha e-mail e senha.'; return; }
  err.textContent=''; btn.disabled=true; btn.textContent='Entrando…';
  try{ await login(email,senha); $('#senha').value=''; closePop(); }
  catch(ex){ err.textContent=authMessage(ex); }
  finally{ btn.disabled=false; btn.textContent='Entrar'; }
});
$('#sair').addEventListener('click',async()=>{
  if(draft?.saving){ toast('Aguarde o salvamento terminar.'); return; }
  if(state.mode==='edit' && dirty() && !state._leaveOk){ state._leaveOk=true; toast('Há alterações não salvas. Clique em Sair de novo para descartar.'); setTimeout(()=>state._leaveOk=false,3000); return; }
  state._leaveOk=false; draft=null;
  try{ await logout(); closePop(); toast('Você saiu'); }catch(e){ toast('Não foi possível sair. Tente de novo.'); }
});

watchAuth(user=>{
  if(unsubPrompts){ unsubPrompts(); unsubPrompts=null; }
  state.user=user; state.authReady=true;
  state.models=[]; state.values={}; state.current=null; state.mode='list'; state.confirmKey=null; draft=null;
  ui.peekOpenById={}; ui.organizeMode=false; syncOrganizeMode();
  loadRoutineSession(user?.uid);
  userBtn.classList.toggle('on',!!user);
  userBtn.setAttribute('aria-label', user?`Conta: ${user.email}`:'Entrar');
  $('#loginForm').hidden=!!user; $('#acct').hidden=!user;
  if(user){
    $('#whoEmail').textContent=user.email||'';
    $('#av').textContent=(user.email||'?')[0];
    state.loaded=false;
    const timer=setTimeout(()=>showStatus('Não foi possível alcançar seus modelos ainda. Verifique a conexão.'),10000);
    unsubPrompts=watchPrompts(user.uid,(arr,meta)=>{
      if(!meta.fromCache){ clearTimeout(timer); showStatus(''); }
      setModels(arr);
    },err=>{
      clearTimeout(timer);
      const msg = saveMessage(err);
      showStatus(msg); toast(msg);
      state.loaded=true; renderList(); renderMain();
      window.PromptecaSplash?.dismiss();
    });
  } else {
    state.loaded=true; showStatus('');
    window.PromptecaSplash?.dismiss();
  }
  renderList(); renderMain();
});

function showStatus(t){ const el=$('#status'); el.textContent=t; el.hidden=!t; }

/* ---------- Modelos, Assinatura de Painel (panelSig) e Hierarquia ---------- */
const panelSig = m => m ? `${m.name}\u0000${m.body}\u0000${m.parentId || ''}` : '';

function enrichModel(m) {
  const name = m.name || 'Sem nome';
  const body = m.body || '';
  return {
    id: m.id,
    name,
    body,
    fav: !!m.fav,
    parentId: m.parentId || null,
    order: typeof m.order === 'number' ? m.order : null,
    pending: !!m.pending,
    _normName: norm(name),
    _normAll: norm(name + '\n' + body),
    _fields: fieldsOf(body)
  };
}

function resolveHierarchy(models) {
  const byId = new Map(models.map(m => [m.id, m]));
  const effParentId = m => {
    if (!m.parentId || m.parentId === m.id) return null;
    const p = byId.get(m.parentId);
    if (!p) return null;
    if (p.parentId && p.parentId !== p.id && byId.has(p.parentId)) return null;
    return p.id;
  };

  const mains = [];
  const childrenMap = new Map();
  models.forEach(m => {
    const pid = effParentId(m);
    if (pid) {
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid).push(m);
    } else {
      mains.push(m);
    }
  });

  mains.sort((a, b) => collator.compare(a.name, b.name));
  childrenMap.forEach(list =>
    list.sort((a, b) => ((a.order ?? Infinity) - (b.order ?? Infinity)) || collator.compare(a.name, b.name))
  );

  return { byId, effParentId, mains, childrenMap };
}

function setModels(arr){
  const before = panelSig(state.models.find(m => m.id === state.current));
  state.models = arr.map(enrichModel);
  const wasLoaded = state.loaded;
  state.loaded = true;
  window.PromptecaSplash?.dismiss();

  if(state.current && !state.models.find(m => m.id === state.current) && state.mode !== 'edit'){
    state.current = null;
    state.mode = 'list';
  }
  renderList();
  const after = panelSig(state.models.find(m => m.id === state.current));
  // Proteção panelSig: evita recriar o DOM do painel durante a digitação
  if(state.mode !== 'edit' && (!wasLoaded || before !== after || state.mode === 'list')) {
    renderMain();
  } else {
    renderDock();
  }
}

/* ---------- Motor de Sequência de Rotina ---------- */
function getRoutineSet(parentId) {
  return ui.routineProgress.get(parentId) || null;
}

function isRoutineActive(parentId) {
  const set = getRoutineSet(parentId);
  return Boolean(set && set.size > 0);
}

function getNextSubPrompt(parentId, subs) {
  const set = getRoutineSet(parentId);
  if (!set || !set.size || !subs || !subs.length) return null;
  for (let idx = 0; idx < subs.length; idx++) {
    if (!set.has(subs[idx].id)) {
      return { sub: subs[idx], idx };
    }
  }
  return null;
}

function getActiveRoutineNextStep() {
  const { byId, childrenMap } = resolveHierarchy(state.models);
  const checkParent = pid => {
    if (!pid || !byId.has(pid)) return null;
    const subs = childrenMap.get(pid) || [];
    const next = getNextSubPrompt(pid, subs);
    return next ? { parentId: pid, sub: next.sub, idx: next.idx } : null;
  };

  if (state.activeRoutineParentId) {
    const res = checkParent(state.activeRoutineParentId);
    if (res) return res;
  }
  for (const pid of ui.routineProgress.keys()) {
    const res = checkParent(pid);
    if (res) return res;
  }
  return null;
}

function resetRoutineProgress(parentId, silent = false) {
  ui.routineProgress.delete(parentId);
  if (state.activeRoutineParentId === parentId) state.activeRoutineParentId = null;
  saveRoutineSession();
  renderList();
  renderDock();
  if (!silent) toast('Sequência reiniciada');
}

function markStepExecuted(targetId, parentId = null) {
  const effParentId = parentId || targetId;
  const { childrenMap } = resolveHierarchy(state.models);
  const subs = childrenMap.get(effParentId) || [];

  if (targetId === effParentId) {
    if (!subs.length) {
      ui.flashIds.add(effParentId);
      renderList();
      setTimeout(() => { ui.flashIds.delete(effParentId); renderList(); }, 1200);
      return;
    }
    ui.routineProgress.set(effParentId, new Set(['ROOT']));
    state.activeRoutineParentId = effParentId;
  } else {
    let set = ui.routineProgress.get(effParentId);
    if (!set) {
      set = new Set();
      ui.routineProgress.set(effParentId, set);
    }
    set.add(targetId);
    state.activeRoutineParentId = effParentId;
  }

  saveRoutineSession();
  renderList();
  renderDock();
}

function autoInheritParentFields(subModel, parentId) {
  if (!parentId || subModel.id === parentId) return;
  const parentVals = state.values[parentId];
  if (!parentVals) return;
  const vals = state.values[subModel.id] || (state.values[subModel.id] = {});
  const fields = subModel._fields || fieldsOf(subModel.body);
  fields.forEach(f => {
    if (!(vals[f] || '').trim() && (parentVals[f] || '').trim()) {
      vals[f] = parentVals[f];
    }
  });
}

function openModelPanel(id, parentId = null, triggerEl = null) {
  const m = state.models.find(x => x.id === id);
  if (!m) return;
  rememberFocus(triggerEl);

  const { effParentId } = resolveHierarchy(state.models);
  const resolvedParentId = parentId || effParentId(m) || m.id;
  state.execParentId = resolvedParentId;

  // Herança automática de campos ocorre quando a rotina do principal está ativa
  if (resolvedParentId !== m.id && isRoutineActive(resolvedParentId)) {
    autoInheritParentFields(m, resolvedParentId);
  }

  state.current = m.id;
  state.mode = 'use';
  state.confirmKey = null;
  renderList();
  renderMain();
}

async function handlePlay(id, event = null, parentId = null, triggerEl = null) {
  const m = state.models.find(x => x.id === id);
  if (!m) return;

  const { effParentId } = resolveHierarchy(state.models);
  const resolvedParentId = parentId || effParentId(m) || m.id;
  state.execParentId = resolvedParentId;

  const fields = m._fields || fieldsOf(m.body);
  const forcePanel = Boolean(event && event.shiftKey);

  // Sem campos variáveis (e sem Shift): Cópia direta em 1-Clique
  if (fields.length === 0 && !forcePanel) {
    const ok = await writeClipboard(m.body.trim());
    if (!ok) return;
    markStepExecuted(m.id, resolvedParentId);
    toast(`“${m.name}” copiado em 1 clique!`, I.check);
    return;
  }

  // Com campos variáveis (ou Shift+Clique): Abre o modal focado
  openModelPanel(m.id, resolvedParentId, triggerEl);
}

async function moveSubOrder(parentId, subId, dir) {
  if (!state.user) return;
  const { childrenMap } = resolveHierarchy(state.models);
  const subs = [...(childrenMap.get(parentId) || [])];
  const idx = subs.findIndex(s => s.id === subId);
  const targetIdx = idx + dir;
  if (idx === -1 || targetIdx < 0 || targetIdx >= subs.length) return;

  const actName = dir < 0 ? 'sub-up' : 'sub-down';
  const fallbackAct = dir < 0 ? 'sub-down' : 'sub-up';
  const [moved] = subs.splice(idx, 1);
  subs.splice(targetIdx, 0, moved);
  subs.forEach((s, i) => { s.order = i; });

  renderList();

  // Devolve o foco ao botão clicado ou ao botão irmão caso tenha atingido o topo/base
  const ul = $('#list');
  const escapedId = CSS.escape(subId);
  const btnToFocus =
    ul?.querySelector(`[data-act="${actName}"][data-id="${escapedId}"]:not([disabled])`) ||
    ul?.querySelector(`[data-act="${fallbackAct}"][data-id="${escapedId}"]:not([disabled])`);
  btnToFocus?.focus({ preventScroll: true });

  try {
    await reorderSubPrompts(state.user.uid, subs.map(s => s.id));
  } catch (err) {
    toast(saveMessage(err));
  }
}

/* ---------- Renderização da Lista Principal ---------- */
function renderItemHtml(m, opts = {}) {
  const {
    isSub = false, parentId = null, parentName = '', stepIdx = null, stepTotal = 0,
    isNextStep = false, wasCopied = false, showReset = false,
    ctxOnly = false, keyPrefix = 'tree', childCount = 0, canReorder = false
  } = opts;

  const n = m._fields ? m._fields.length : fieldsOf(m.body).length;
  const syncDot = m.pending ? `<span class="sync-dot" title="Sincronizando com a nuvem…"></span>` : '';
  const badge = n > 0 ? `<span class="badge" title="${n} ${n===1?'campo variável':'campos variáveis'}">${n}</span>` : '';
  const originTag = parentName ? `<span class="sub-origin">↳ ${esc(parentName)}</span>` : '';
  const nextBadge = isNextStep ? `<span class="next-pill">Próximo passo</span>` : '';
  const resetBtn = showReset
    ? `<button class="reset-seq-btn" type="button" data-act="reset-seq" data-id="${m.id}" title="Reiniciar progresso da sequência">↺ Reiniciar</button>`
    : '';
  const stepIndicator = isSub && stepIdx !== null
    ? `<span class="step-num" title="Etapa ${stepIdx + 1} da sequência">${stepIdx + 1}</span>`
    : (isSub ? I.sub : '');

  const rowKey = `${keyPrefix}:${m.id}`;
  const isFlash = ui.flashIds.has(m.id);

  const favBtn = `<button class="fav-btn ${m.fav?'on':''}" data-act="fav" data-id="${m.id}" aria-label="${m.fav?'Remover dos favoritos':'Favoritar'} ${esc(m.name)}" title="${m.fav?'Favorito (clique para remover)':'Fixar nos favoritos'}">${I.star}</button>`;

  const playTitle = n === 0
    ? 'Copiar em 1-Clique (Shift+Clique para abrir painel)'
    : `Preencher ${n} ${n===1?'campo':'campos'} e copiar`;
  const playBtn = `<button class="play-btn ${n===0?'direct':''}" data-act="play" data-id="${m.id}" ${parentId?`data-parent="${parentId}"`:''} aria-label="Executar ${esc(m.name)}" title="${playTitle}">${I.play}</button>`;

  const orderBtns = (isSub && canReorder && stepTotal > 1)
    ? `<span class="ord-grp">
        <button class="ib ord" data-act="sub-up" data-parent="${parentId}" data-id="${m.id}" ${stepIdx===0?'disabled':''} aria-label="Mover ${esc(m.name)} para cima" title="Mover para cima">↑</button>
        <button class="ib ord" data-act="sub-down" data-parent="${parentId}" data-id="${m.id}" ${stepIdx===stepTotal-1?'disabled':''} aria-label="Mover ${esc(m.name)} para baixo" title="Mover para baixo">↓</button>
      </span>`
    : '';

  const branchBtn = !isSub
    ? `<button class="ib branch" data-act="sub-new" data-id="${m.id}" aria-label="Criar subprompt para ${esc(m.name)}" title="Criar subprompt vinculado">${I.branch}</button>`
    : '';

  const warnText = childCount > 0 ? `<span class="warn-sub">${childCount} sub${childCount>1?'s':''} virar${childCount>1?'ão':'á'} principal</span>` : '';
  const acts = state.confirmKey === rowKey
    ? `<div class="confirm">${warnText}<button class="yes" data-act="del-yes" data-id="${m.id}">Excluir</button><button class="no" data-act="del-no">Não</button></div>`
    : `<div class="acts">${orderBtns}${branchBtn}<button class="ib" data-act="edit" data-id="${m.id}" aria-label="Editar ${esc(m.name)}" title="Editar">${I.edit}</button><button class="ib del" data-act="del" data-id="${m.id}" data-key="${rowKey}" aria-label="Excluir ${esc(m.name)}" title="Excluir">${I.trash}</button></div>`;

  return `<li class="item ${isSub?'is-sub':''} ${ctxOnly?'ctx-only':''} ${m.id===state.current?'active':''} ${wasCopied?'was-copied':''} ${isFlash?'just-copied-flash':''} ${isNextStep?'is-next-step':''}">
    ${favBtn}
    <button class="open" data-act="open" data-id="${m.id}" ${parentId?`data-parent="${parentId}"`:''} title="Abrir ${esc(m.name)}">
      ${syncDot}${stepIndicator}<span class="n">${esc(m.name)}</span>${originTag}${nextBadge}${badge}
    </button>
    ${acts}
    ${resetBtn}
    ${playBtn}
  </li>`;
}

function renderList(){
  const q = norm(state.query.trim());
  const { byId, effParentId, mains, childrenMap } = resolveHierarchy(state.models);
  const subCount = state.models.length - mains.length;
  $('#count').textContent = subCount > 0 ? `${mains.length} · ${subCount} sub${subCount>1?'s':''}` : String(state.models.length);

  const ul = $('#list');
  if(!state.authReady || (state.user && !state.loaded)){ ul.innerHTML='<li class="no-res">Carregando…</li>'; return; }
  if(!state.user){ ul.innerHTML='<li class="no-res">Entre na sua conta (ícone no canto superior direito) para acessar seus modelos.</li>'; return; }
  if(!state.models.length){ ul.innerHTML='<li class="no-res">Nenhum modelo salvo ainda. Clique em “+ Novo modelo” abaixo.</li>'; return; }

  const renderBranch = (main, keyPrefix = 'tree', filterSubs = null, mainCtxOnly = false) => {
    const allSubs = childrenMap.get(main.id) || [];
    const subsToRender = filterSubs || allSubs;
    const rSet = getRoutineSet(main.id);
    const nextInfo = getNextSubPrompt(main.id, allSubs);
    const rootCopied = Boolean(allSubs.length > 0 && rSet && rSet.has('ROOT'));
    const showReset = Boolean(allSubs.length > 0 && rSet && rSet.size > 0);

    const mainHtml = renderItemHtml(main, {
      isSub: false,
      ctxOnly: mainCtxOnly,
      keyPrefix,
      childCount: allSubs.length,
      wasCopied: rootCopied,
      showReset
    });

    const subsHtml = subsToRender.map(s => {
      const realIdx = allSubs.findIndex(x => x.id === s.id);
      const stepCopied = Boolean(rSet && rSet.has(s.id));
      const isNext = Boolean(nextInfo && nextInfo.sub.id === s.id);
      return renderItemHtml(s, {
        isSub: true,
        parentId: main.id,
        stepIdx: realIdx,
        stepTotal: allSubs.length,
        isNextStep: isNext,
        wasCopied: stepCopied,
        keyPrefix,
        canReorder: !filterSubs
      });
    }).join('');

    return mainHtml + subsHtml;
  };

  let html = '';
  if (q) {
    const groups = [];
    mains.forEach(main => {
      const subs = childrenMap.get(main.id) || [];
      const mainHit = main._normAll.includes(q);
      const matchingSubs = subs.filter(s => s._normAll.includes(q));
      if (mainHit) groups.push({ main, mainCtxOnly: false, subs: null });
      else if (matchingSubs.length > 0) groups.push({ main, mainCtxOnly: true, subs: matchingSubs });
    });

    if (!groups.length) {
      ul.innerHTML = '<li class="no-res">Nenhum modelo ou subprompt encontrado.</li>';
      return;
    }
    html = groups.map(g => renderBranch(g.main, 'search', g.subs, g.mainCtxOnly)).join('');
  } else {
    const favMains = mains.filter(m => m.fav);
    const regularMains = mains.filter(m => !m.fav);
    const pinnedSubShortcuts = state.models.filter(m => {
      const pid = effParentId(m);
      return pid && m.fav && !byId.get(pid)?.fav;
    }).sort((a, b) => collator.compare(a.name, b.name));

    if (favMains.length || pinnedSubShortcuts.length) {
      html += `<li class="list-sec">${I.star}Fixados nos Favoritos</li>`;
      html += favMains.map(m => renderBranch(m, 'fav')).join('');
      html += pinnedSubShortcuts.map(s => {
        const pid = effParentId(s);
        const pName = (pid && byId.get(pid)?.name) || '';
        const allSubs = (pid && childrenMap.get(pid)) || [];
        const realIdx = allSubs.findIndex(x => x.id === s.id);
        const rSet = pid ? getRoutineSet(pid) : null;
        const nextInfo = pid ? getNextSubPrompt(pid, allSubs) : null;
        return renderItemHtml(s, {
          isSub: true,
          parentId: pid,
          parentName: pName,
          stepIdx: realIdx !== -1 ? realIdx : null,
          stepTotal: allSubs.length,
          isNextStep: Boolean(nextInfo && nextInfo.sub.id === s.id),
          wasCopied: Boolean(rSet && rSet.has(s.id)),
          keyPrefix: 'fav-sub',
          canReorder: false
        });
      }).join('');
      if (regularMains.length) html += `<li class="list-sec">Modelos</li>`;
    }
    html += regularMains.map(m => renderBranch(m, 'tree')).join('');
  }

  ul.innerHTML = html;
}

$('#list').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const id = b.dataset.id, act = b.dataset.act;

  if(act === 'open'){
    openModelPanel(id, b.dataset.parent || null, b);
  }
  if(act === 'play'){
    handlePlay(id, e, b.dataset.parent || null, b);
  }
  if(act === 'reset-seq'){
    resetRoutineProgress(id);
  }
  if(act === 'sub-up'){
    moveSubOrder(b.dataset.parent, id, -1);
  }
  if(act === 'sub-down'){
    moveSubOrder(b.dataset.parent, id, 1);
  }
  if(act === 'fav'){
    const m = state.models.find(x => x.id === id);
    if(!m) return;
    const nextFav = !m.fav;
    m.fav = nextFav;
    renderList();
    toggleFavPrompt(state.user.uid, id, nextFav).catch(err => {
      const cur = state.models.find(x => x.id === id);
      if (cur && cur.fav === nextFav) { cur.fav = !nextFav; renderList(); }
      toast(saveMessage(err));
    });
    toast(nextFav ? `“${m.name}” fixado nos favoritos` : 'Removido dos favoritos', I.star);
  }
  if(act === 'sub-new'){
    if(state.mode==='edit' && !leaveEdit()) return;
    rememberFocus(b);
    state.confirmKey = null;
    openEditor(null, null, id);
    renderList();
  }
  if(act === 'edit'){
    if(state.mode==='edit' && !leaveEdit()) return;
    rememberFocus(b);
    state.current = id; state.confirmKey = null;
    openEditor(id);
    renderList();
  }
  if(act === 'del'){
    state.confirmKey = b.dataset.key || `tree:${id}`;
    renderList();
    clearTimeout(state._ct);
    state._ct = setTimeout(() => { state.confirmKey = null; renderList(); }, 4500);
  }
  if(act === 'del-no'){
    state.confirmKey = null; renderList();
  }
  if(act === 'del-yes'){
    state.confirmKey = null;
    const target = state.models.find(m => m.id === id);
    const name = target?.name || 'Modelo';
    const childIds = state.models.filter(m => m.parentId === id).map(m => m.id);
    if(state.current === id){ state.current = null; state.mode = 'list'; }
    delete state.values[id];
    delete ui.peekOpenById[id];
    ui.routineProgress.delete(id);
    saveRoutineSession();
    deletePromptWithChildren(state.user.uid, id, childIds).catch(err => {
      console.error(err); toast(saveMessage(err));
    });
    toast(childIds.length ? `“${name}” excluído · ${childIds.length} sub(s) promovido(s)` : `“${name}” excluído`, I.trash);
    renderList(); renderMain();
  }
});

$('#q').addEventListener('input', e => {
  state.query = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderList, 90);
});

/* ---------- Painel Modal Sob Demanda (Visualização/Preenchimento e Editor) ---------- */
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

let peekTimer = null;

function formatPeekHtml(body, vals, useMarkdown = false){
  if (useMarkdown) {
    return renderMarkdown(body, { fieldRe: FIELD_RE, values: vals });
  }
  let html = '', last = 0;
  for (const mt of body.matchAll(FIELD_RE)){
    html += esc(body.slice(last, mt.index));
    const v = (vals[mt[1]] || '').trim();
    html += `<mark>${esc(v || mt[0])}</mark>`;
    last = mt.index + mt[0].length;
  }
  return html + esc(body.slice(last));
}

function renderMain(){
  clearTimeout(peekTimer);
  syncPanelVisibility();
  const body = $('#body');
  const m = state.models.find(x => x.id === state.current);

  if(state.mode === 'use' && m){
    const { byId, effParentId } = resolveHierarchy(state.models);
    const pid = effParentId(m);
    const parentModel = pid ? byId.get(pid) : null;
    const fields = m._fields || fieldsOf(m.body);
    const hasMd = detectMarkdown(m.body).isMarkdown;

    $('#title').textContent = m.name;
    $('#meta').textContent = fields.length
      ? `${fields.length} ${fields.length===1?'campo':'campos'}`
      : 'Sem campos variáveis';

    const vals = state.values[m.id] || (state.values[m.id] = {});
    const parentVals = parentModel ? (state.values[parentModel.id] || {}) : {};
    // Exibe o botão apenas quando há campos em comum vazios no subprompt e preenchidos no principal
    const canPullFromParent = parentModel && fields.some(f => (parentVals[f] || '').trim() && !(vals[f] || '').trim());

    const ctxBarHtml = parentModel
      ? `<div class="ctx-bar">
          <button type="button" class="parent-pill" id="goParentBtn" title="Abrir prompt principal">${I.sub}Subprompt de: <strong>${esc(parentModel.name)}</strong></button>
          ${canPullFromParent ? `<button type="button" class="inherit-btn" id="pullParentValsBtn" title="Preencher campos em comum vazios com os dados do prompt principal">${I.field}Reaproveitar dados do principal</button>` : ''}
        </div>`
      : '';

    const isPeekOpen = !fields.length || !!ui.peekOpenById[m.id];
    const slotsHtml = fields.map((f, i) => {
      const fid = `slot-f-${i}`;
      return `<div class="slot">
        <label for="${fid}">${I.field}${esc(f)}</label>
        <textarea id="${fid}" data-f="${esc(f)}" rows="2" placeholder="Preencha ${esc(f)}…">${esc(vals[f]||'')}</textarea>
      </div>`;
    }).join('');

    body.innerHTML = `<div class="view use-minimal">
      ${ctxBarHtml}
      ${slotsHtml}
      <details class="peek" id="peekBox" ${isPeekOpen ? 'open' : ''}>
        <summary>Ver texto do prompt</summary>
        <div class="${hasMd ? 'md-preview' : 'doc'}" id="peekDoc" aria-live="off">${isPeekOpen ? formatPeekHtml(m.body, vals, hasMd) : ''}</div>
      </details>
    </div>`;

    const refreshPeek = (immediate = false) => {
      const peekBox = $('#peekBox');
      const peekDoc = $('#peekDoc');
      if (!peekBox?.open || !peekDoc) return;
      const paint = () => {
        if ($('#peekBox')?.open && $('#peekDoc')) {
          $('#peekDoc').innerHTML = formatPeekHtml(m.body, vals, hasMd);
        }
      };
      clearTimeout(peekTimer);
      // Debounce leve apenas em prompts extensos para manter a digitação nos campos fluida
      if (immediate || !hasMd || m.body.length < 4000) paint();
      else peekTimer = setTimeout(paint, 120);
    };

    body.querySelectorAll('.slot textarea').forEach(ta => {
      grow(ta);
      ta.addEventListener('input', () => {
        vals[ta.dataset.f] = ta.value;
        grow(ta);
        refreshPeek();
      });
    });

    const first = body.querySelector('.slot textarea');
    if(first && !matchMedia('(hover:none)').matches) first.focus({preventScroll:true});

    $('#goParentBtn')?.addEventListener('click', () => {
      state.current = parentModel.id;
      state.execParentId = parentModel.id;
      state.mode = 'use';
      renderList(); renderMain();
    });

    $('#pullParentValsBtn')?.addEventListener('click', () => {
      fields.forEach(f => {
        if (!(vals[f] || '').trim() && (parentVals[f] || '').trim()) {
          vals[f] = parentVals[f];
        }
      });
      renderMain();
      toast('Campos preenchidos a partir do principal', I.check);
    });

    const peekBox = $('#peekBox');
    peekBox?.addEventListener('toggle', () => {
      ui.peekOpenById[m.id] = peekBox.open;
      if (peekBox.open) refreshPeek(true);
    });
  }
  renderDock();
}

function grow(ta){ ta.style.height='auto'; ta.style.height=ta.scrollHeight+'px'; }

/* ---------- Editor com Reordenação de Subprompts e Recuperação Offline ---------- */
const toolsIdle=`<button class="tbtn" id="addField" type="button" title="Inserir campo de texto livre na posição do cursor">${I.field}Inserir campo</button><span class="hint">Posicione o cursor ou selecione um trecho para transformá-lo em campo</span>`;

function bindAddFieldBtn(){
  const btn=$('#addField');
  if(!btn) return;
  btn.addEventListener('pointerdown', e=>{
    const ta=$('#ta');
    if(ta && document.activeElement===ta){
      savedRange={s:ta.selectionStart, e:ta.selectionEnd};
    }
    e.preventDefault();
  });
  btn.addEventListener('click', askFieldName);
}

function insertAt(ta, text, s, e){
  ta.focus();
  ta.setSelectionRange(s, e);
  let ok = false;
  try { ok = document.execCommand && document.execCommand('insertText', false, text); } catch (_) { ok = false; }
  if(!ok){
    ta.setRangeText(text, s, e, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function renderDraftSubOrderList() {
  const box = $('#subOrderBox');
  if (!box || !draft) return;
  if (draft.parentId || !draft.subOrderIds.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  const byId = new Map(state.models.map(m => [m.id, m]));
  box.innerHTML = `<span class="lbl">Sequência de Subprompts vinculados (${draft.subOrderIds.length})</span>
    <div class="sub-order-list">
      ${draft.subOrderIds.map((sid, idx) => {
        const sub = byId.get(sid);
        if (!sub) return '';
        return `<div class="sub-order-item">
          <span class="step-num">${idx + 1}</span>
          <span class="name">${esc(sub.name)}</span>
          <span class="ord-grp">
            <button type="button" class="ib ord" data-sub-move="-1" data-idx="${idx}" ${idx===0?'disabled':''} aria-label="Mover ${esc(sub.name)} para cima" title="Mover para cima">↑</button>
            <button type="button" class="ib ord" data-sub-move="1" data-idx="${idx}" ${idx===draft.subOrderIds.length-1?'disabled':''} aria-label="Mover ${esc(sub.name)} para baixo" title="Mover para baixo">↓</button>
          </span>
        </div>`;
      }).join('')}
    </div>`;

  box.querySelectorAll('[data-sub-move]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const dir = Number(btn.dataset.subMove);
      const target = idx + dir;
      if (target < 0 || target >= draft.subOrderIds.length) return;
      const [moved] = draft.subOrderIds.splice(idx, 1);
      draft.subOrderIds.splice(target, 0, moved);
      renderDraftSubOrderList();
    });
  });
}

function updateMarkdownPreview(immediate = false) {
  if (!draft || draft.view === 'edit') return;
  const run = () => {
    const pv = $('#mdPreview');
    if (!pv || !draft) return;
    pv.innerHTML = renderMarkdown(draft.body, { fieldRe: FIELD_RE });
  };
  clearTimeout(previewTimer);
  if (immediate || (draft.body?.length || 0) < 4000) run();
  else previewTimer = setTimeout(run, 120);
}

function setEditorView(view, { focus = true, remember = true } = {}) {
  if (!draft) return;
  const resolved = view === 'split' && !canSplitEditor() ? 'preview' : view;
  draft.view = resolved;
  if (remember) saveEditorView(resolved);

  const box = $('#editorBox');
  const editPane = $('#editPane');
  const preview = $('#mdPreview');
  const panel = $('#panel');

  if (box) box.dataset.view = resolved;
  if (panel) panel.classList.toggle('panel-wide', resolved === 'split');
  if (editPane) editPane.hidden = resolved === 'preview';
  if (preview) preview.hidden = resolved === 'edit';

  document.querySelectorAll('[data-ed-view]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.edView === resolved));
  });

  if (resolved !== 'edit') {
    updateMarkdownPreview(true);
  } else if (focus && !matchMedia('(hover:none)').matches) {
    $('#ta')?.focus({ preventScroll: true });
  }
}

function applySmartMarkdownView(wasEmpty) {
  if (!draft || draft.view !== 'edit') {
    updateMarkdownPreview(true);
    return;
  }
  if (readSavedEditorView() === 'edit') return; // Respeita escolha manual de ficar só no texto
  if (canSplitEditor()) setEditorView('split', { focus: false, remember: false });
  else if (wasEmpty) setEditorView('preview', { focus: false, remember: false });
}

function applySnapshotReplacement(snap, doneMsg, expandIfStrong = false) {
  const ta = $('#ta');
  if (!ta || !draft || pasteActionSnapshot !== snap) return;
  if (ta.value.slice(snap.start, snap.end) !== snap.expected) {
    toast('O texto já foi alterado; use Ctrl+Z para desfazer.');
    pasteActionSnapshot = null;
    return;
  }
  pasteActionSnapshot = null;
  insertAt(ta, snap.replacement, snap.start, snap.end);
  syncEditor({ immediate: true });
  if (expandIfStrong && detectMarkdown(snap.replacement).isStrong) {
    applySmartMarkdownView(snap.wasEmpty);
  }
  toast(doneMsg, I.check);
}

function handleEditorPaste(e) {
  const ta = $('#ta');
  if (!ta || !draft || !e.clipboardData) return;

  // Respeita Ctrl/⌘+Shift+V e Cmd+Option+Shift+V (macOS) com janela temporal efêmera
  const forcePlain = performance.now() <= plainPasteUntil;
  plainPasteUntil = 0;
  pasteActionSnapshot = null;
  if (forcePlain) return;

  const plain = e.clipboardData.getData('text/plain') || '';
  const normPlain = plain.replace(/\r\n?/g, '\n'); // Compatível com \r\n no Windows
  const html = e.clipboardData.getData('text/html') || '';
  const wasEmpty = !ta.value.trim();

  // Nível 1: text/plain já contém Markdown → preserva colagem nativa; só expande view se isStrong
  const pastedMd = detectMarkdown(normPlain);
  if (pastedMd.isMarkdown) {
    if (pastedMd.isStrong) {
      requestAnimationFrame(() => {
        if (!draft) return;
        applySmartMarkdownView(wasEmpty);
        toast('Formatação Markdown identificada', I.check);
      });
    }
    return;
  }

  if (!html) return;
  const htmlKind = classifyHtmlPaste(html);
  if (htmlKind === 'none') return;

  const converted = htmlToMarkdown(html);
  const convertedMd = detectMarkdown(converted);
  if (!converted || converted === normPlain.trim() || !convertedMd.isMarkdown) return;

  // Nível 2: HTML com estrutura de bloco (títulos, listas, tabelas, código, citações) → converte + Desfazer
  if (htmlKind === 'block') {
    e.preventDefault();
    const start = ta.selectionStart;
    insertAt(ta, converted, start, ta.selectionEnd);
    syncEditor({ immediate: true });
    if (convertedMd.isStrong) applySmartMarkdownView(wasEmpty);

    const snap = {
      start,
      end: start + converted.length,
      expected: converted,
      replacement: normPlain,
      wasEmpty
    };
    pasteActionSnapshot = snap;
    toast('Formatação convertida para Markdown', I.check, {
      duration: 6000,
      action: {
        label: 'Desfazer',
        onClick: () => applySnapshotReplacement(snap, 'Colagem revertida para texto simples')
      }
    });
    return;
  }

  // Nível 3: HTML apenas com marcação inline (Word/PJe) → cola texto limpo + oferta opt-in
  if (htmlKind === 'inline') {
    const start = ta.selectionStart;
    requestAnimationFrame(() => {
      if (!ta || !draft) return;
      if (ta.value.slice(start, start + normPlain.length) !== normPlain) return;
      const snap = {
        start,
        end: start + normPlain.length,
        expected: normPlain,
        replacement: converted,
        wasEmpty
      };
      pasteActionSnapshot = snap;
      toast('Texto colado sem formatação', '', {
        duration: 6000,
        action: {
          label: 'Converter formatação',
          onClick: () => applySnapshotReplacement(snap, 'Formatação convertida para Markdown', true)
        }
      });
    });
  }
}

function openEditor(id, recovered = null, defaultParentId = null){
  if(!state.user){ openPop(); toast('Entre para criar modelos.'); return; }
  const m = id ? state.models.find(x => x.id === id) : null;
  const src = recovered || m;
  const isNew = recovered ? recovered.isNew : !m;

  const { mains, childrenMap } = resolveHierarchy(state.models);
  const rawParentId = recovered !== null
    ? (recovered.parentId || null)
    : (m ? (m.parentId || null) : (defaultParentId || null));

  const existingChildren = id ? (childrenMap.get(id) || []) : [];
  const initialSubOrderIds = recovered?.initialSubOrderIds || existingChildren.map(c => c.id);
  const currentSubOrderIds = recovered?.subOrderIds || [...initialSubOrderIds];

  const orig = recovered
    ? recovered.orig
    : JSON.stringify([src?.name || '', src?.body || '', rawParentId, initialSubOrderIds]);

  const eligibleParents = mains.filter(x => x.id !== id);

  lastChipsSig = null;
  pasteActionSnapshot = null;
  draft = {
    id: recovered?.id || m?.id || newPromptId(state.user.uid),
    name: src?.name || '',
    body: src?.body || '',
    parentId: rawParentId,
    _origParentId: m ? (m.parentId || null) : null,
    order: m ? m.order : null,
    subOrderIds: currentSubOrderIds,
    _initialSubOrderIds: initialSubOrderIds,
    view: 'edit',
    isNew,
    saving: false,
    orig
  };
  state.mode = 'edit';
  syncPanelVisibility();

  const showOrphan = !!rawParentId && !eligibleParents.some(p => p.id === rawParentId);
  const orphanOpt = showOrphan
    ? `<option value="${esc(rawParentId)}" selected>(vínculo anterior indisponível)</option>`
    : '';
  const parentOpts =
    `<option value=""${!rawParentId ? ' selected' : ''}>Nenhum — prompt principal</option>` +
    orphanOpt +
    eligibleParents.map(p =>
      `<option value="${esc(p.id)}"${p.id === rawParentId ? ' selected' : ''}>${esc(p.name)}</option>`
    ).join('');

  draft._childIds = existingChildren.map(c => c.id);
  draft._parentNames = new Map(eligibleParents.map(p => [p.id, p.name]));

  $('#title').textContent = isNew ? (rawParentId ? 'Novo subprompt' : 'Novo modelo') : 'Editar modelo';
  $('#body').innerHTML = `<div class="view edit">
    <div class="field-grid">
      <div class="field-row">
        <label class="lbl" for="nameIn">Nome</label>
        <input class="name-in" id="nameIn" type="text" maxlength="120" placeholder="Ex.: Resumo de acórdão" autocomplete="off">
      </div>
      <div class="field-row">
        <label class="lbl" for="parentSel">Subprompt de</label>
        <select class="parent-select" id="parentSel">${parentOpts}</select>
        <div class="reparent-note" id="reparentNote" hidden></div>
      </div>
    </div>
    <div class="field-row" id="subOrderBox" hidden></div>
    <div class="field-row">
      <span class="lbl">Texto do prompt</span>
      <div class="editor" id="editorBox" data-view="edit">
        <div class="tools" id="tools">
          <div class="tools-left" id="toolsField">${toolsIdle}</div>
          <div class="tools-right" id="toolsMd">
            <span class="md-pill" id="mdBadge" hidden>Markdown</span>
            <div class="seg" role="group" aria-label="Modo de visualização do editor">
              <button type="button" class="seg-btn" data-ed-view="edit" aria-pressed="true">Editar</button>
              <button type="button" class="seg-btn seg-split" data-ed-view="split" aria-pressed="false">Dividido</button>
              <button type="button" class="seg-btn" data-ed-view="preview" aria-pressed="false">Formatado</button>
            </div>
          </div>
        </div>
        <div class="editor-panes">
          <div class="wrap" id="editPane">
            <div class="backdrop" id="bd" aria-hidden="true"></div>
            <textarea class="ta" id="ta" spellcheck="false" placeholder="Cole o texto do prompt (Markdown é reconhecido automaticamente). Use “Inserir campo” para marcar variáveis."></textarea>
          </div>
          <div class="md-preview" id="mdPreview" role="region" aria-label="Pré-visualização formatada em Markdown" aria-live="off" hidden></div>
        </div>
      </div>
      <div class="chips" id="chips"></div>
    </div>
  </div>`;

  const ta = $('#ta'), nameIn = $('#nameIn'), sel = $('#parentSel');
  nameIn.value = draft.name;
  ta.value = draft.body;
  savedRange = { s: ta.value.length, e: ta.value.length };

  nameIn.addEventListener('input', () => { draft.name = nameIn.value; });
  nameIn.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); ta.focus(); }
  });
  sel.addEventListener('change', () => {
    draft.parentId = sel.value || null;
    updateReparentNote();
    renderDraftSubOrderList();
  });

  ta.addEventListener('input', () => {
    if (
      pasteActionSnapshot &&
      ta.value.slice(pasteActionSnapshot.start, pasteActionSnapshot.end) !== pasteActionSnapshot.expected
    ) {
      pasteActionSnapshot = null;
    }
    syncEditor();
  });

  ta.addEventListener('keydown', e => {
    const isV = e.code === 'KeyV' || (e.key || '').toLowerCase() === 'v';
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && isV) {
      plainPasteUntil = performance.now() + 300;
    }
  });

  ta.addEventListener('paste', handleEditorPaste);

  ta.addEventListener('scroll', () => {
    const bd = $('#bd');
    if (bd) bd.scrollTop = ta.scrollTop;
    if (draft?.view === 'split') {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        const pv = $('#mdPreview');
        const maxTa = ta.scrollHeight - ta.clientHeight;
        if (pv && maxTa > 0) {
          pv.scrollTop = (ta.scrollTop / maxTa) * (pv.scrollHeight - pv.clientHeight);
        }
      });
    }
  });

  document.querySelectorAll('[data-ed-view]').forEach(btn => {
    btn.addEventListener('click', () => setEditorView(btn.dataset.edView));
  });

  bindAddFieldBtn();
  syncEditor({ immediate: true });
  updateReparentNote();
  renderDraftSubOrderList();

  // Abertura inicial: só ativa modo dividido automaticamente quando detecção for forte (isStrong)
  const initialMd = detectMarkdown(draft.body);
  const savedView = readSavedEditorView();
  let startView = 'edit';
  if (initialMd.isStrong) {
    startView = savedView || (canSplitEditor() ? 'split' : 'edit');
  }
  setEditorView(startView, { focus: false, remember: false });

  renderDock();
  // Preserva integralmente o foco original (Nome em modelos novos, textarea em edições)
  if (!matchMedia('(hover:none)').matches) {
    (isNew ? nameIn : (draft.view === 'preview' ? nameIn : ta)).focus({ preventScroll: true });
  }
}

function syncEditor({ immediate = false } = {}) {
  const ta = $('#ta');
  if (!ta || !draft) return;

  // Fase 1 (Síncrona): mantém draft.body e dirty() sempre exatos antes de qualquer atalho/saída
  draft.body = ta.value;

  // Fase 2 (Unificada em rAF — roda antes da pintura do mesmo quadro no input)
  const runPaint = () => {
    if (!draft) return;

    const bd = $('#bd');
    if (bd) {
      bd.innerHTML = highlightMarkdownBackdrop(draft.body, FIELD_RE);
      bd.scrollTop = ta.scrollTop;
    }

    const mdInfo = detectMarkdown(draft.body);
    const badge = $('#mdBadge');
    if (badge) {
      badge.hidden = !mdInfo.isMarkdown;
      badge.title = mdInfo.isMarkdown
        ? `Markdown detectado: ${mdInfo.features.join(', ')}`
        : '';
    }

    const f = fieldsOf(draft.body);
    const sig = f.join('\u0000');
    if (sig !== lastChipsSig) {
      lastChipsSig = sig;
      const chipsEl = $('#chips');
      if (chipsEl) chipsEl.innerHTML = f.map(x => `<span class="chip">${esc(x)}</span>`).join('');
      const metaEl = $('#meta');
      if (metaEl) metaEl.textContent = f.length ? `${f.length} ${f.length === 1 ? 'campo' : 'campos'}` : 'Sem campos variáveis';
    }

    updateMarkdownPreview(immediate === true);
  };

  cancelAnimationFrame(syncRaf);
  if (immediate === true) runPaint();
  else syncRaf = requestAnimationFrame(runPaint);
}

function updateReparentNote() {
  const el = $('#reparentNote');
  if (!el || !draft) return;
  const n = draft._childIds.length;
  const pName = draft._parentNames.get(draft.parentId);
  let t = '';
  if (draft.parentId && !pName) t = 'O prompt principal vinculado não existe mais. Escolha outro ou deixe como principal.';
  else if (pName && n) t = `Os ${n} subprompt${n > 1 ? 's' : ''} deste modelo também passarão a ser subprompts de “${pName}”.`;
  el.textContent = t;
  el.hidden = !t;
}

function askFieldName() {
  if (draft?.view === 'preview') setEditorView(canSplitEditor() ? 'split' : 'edit', { remember: false });
  const ta = $('#ta'), tools = $('#toolsField');
  if (!ta || !tools) return;
  const len = ta.value.length;
  const r = { s: Math.min(savedRange.s, len), e: Math.min(savedRange.e, len) };
  const picked = ta.value.slice(r.s, r.e).trim();
  const useSel = !!picked && !picked.includes('\n') && picked.length <= 60;

  tools.innerHTML = `<span class="fname">{{<input id="fname" type="text" maxlength="60" placeholder="Nome do campo" autocomplete="off" value="${esc(useSel ? picked : '')}">}}</span>
    <button class="tbtn" id="fOk" type="button">${I.check}Inserir</button>
    <button class="mini" id="fNo" type="button">Cancelar</button>`;
  const input = $('#fname');
  input.focus();
  input.select();

  const close = () => { tools.innerHTML = toolsIdle; bindAddFieldBtn(); };
  const cancel = () => { close(); ta.focus(); ta.setSelectionRange(r.s, r.e); };
  const confirm = () => {
    const name = input.value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    if (!name) { toast('Dê um nome ao campo.'); input.focus(); return; }
    close();
    insertAt(ta, `{{${name}}}`, r.s, useSel ? r.e : r.s);
    syncEditor({ immediate: true });
  };
  $('#fOk').addEventListener('click', confirm);
  $('#fNo').addEventListener('click', cancel);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
  });
}

/* ---------- Alterações, Saída e Salvamento Isolado ---------- */
function dirty() {
  return !!draft && JSON.stringify([draft.name, draft.body, draft.parentId || null, draft.subOrderIds]) !== draft.orig;
}

function leaveEdit() {
  if (!draft) return true;
  if (draft.saving) { toast('Aguarde o salvamento terminar.'); return false; }
  if (dirty() && !state._leaveOk) {
    state._leaveOk = true;
    toast('Há alterações não salvas. Repita a ação para descartar.');
    clearTimeout(state._lt);
    state._lt = setTimeout(() => { state._leaveOk = false; }, 3000);
    return false;
  }
  state._leaveOk = false;
  draft = null;
  return true;
}

async function saveDraft() {
  if (!draft || draft.saving || !state.user) return;
  const d = draft;
  d.name = ($('#nameIn')?.value ?? d.name).trim();
  d.body = $('#ta')?.value ?? d.body;
  if (!d.name) { toast('Dê um nome ao modelo.'); $('#nameIn')?.focus(); return; }
  if (!d.body.trim()) { toast('O texto do prompt está vazio.'); $('#ta')?.focus(); return; }
  if (d.body.length > 250000) { toast('Texto acima do limite de 250 mil caracteres.'); return; }

  const uid = state.user.uid;
  const { childrenMap } = resolveHierarchy(state.models);
  const newParentId = d.parentId || null;
  let orderVal = null;
  let targetSiblingsCount = 0;

  if (newParentId) {
    const targetSiblings = (childrenMap.get(newParentId) || []).filter(s => s.id !== d.id);
    targetSiblingsCount = targetSiblings.length;
    const parentChanged = newParentId !== d._origParentId;
    if (d.isNew || parentChanged || typeof d.order !== 'number') {
      orderVal = targetSiblingsCount;
    } else {
      orderVal = d.order;
    }
  }

  const payload = { id: d.id, name: d.name, body: d.body, parentId: newParentId, order: orderVal };

  // Filhos transferidos caso um principal tenha sido convertido em subprompt de outro principal
  const canReparentChildren = newParentId && d._parentNames.has(newParentId) && d._childIds.length > 0;
  const reparentEntries = canReparentChildren
    ? d._childIds.map((cid, idx) => ({
        id: cid,
        parentId: newParentId,
        order: targetSiblingsCount + 1 + idx
      }))
    : [];

  // Só grava a ordem dos subprompts se ela realmente tiver mudado no editor
  const subOrderChanged =
    !newParentId &&
    d.subOrderIds.length > 0 &&
    JSON.stringify(d.subOrderIds) !== JSON.stringify(d._initialSubOrderIds);
  const orderIds = subOrderChanged ? [...d.subOrderIds] : [];

  d.saving = true;
  renderDock();

  // Fase 1: Grava o documento principal isoladamente
  const mainWrite = savePrompt(uid, payload);
  let timedOut = false;
  try {
    await Promise.race([mainWrite, new Promise(res => setTimeout(() => { timedOut = true; res(); }, 6000))]);
  } catch (err) {
    console.error(err);
    d.saving = false;
    toast(saveMessage(err));
    if (draft === d) renderDock();
    return;
  }

  if (timedOut) {
    mainWrite.catch(err => {
      console.error(err);
      toast(saveMessage(err));
      // Recuperação integral do rascunho se a escrita offline falhar tardiamente
      if (state.user?.uid === uid && state.mode !== 'edit') {
        openEditor(d.isNew ? null : d.id, {
          id: d.id,
          name: d.name,
          body: d.body,
          parentId: newParentId,
          subOrderIds: d.subOrderIds,
          initialSubOrderIds: d._initialSubOrderIds,
          isNew: d.isNew,
          orig: d.orig
        });
      }
    });
  }

  // Fase 2: Atualiza filhos em operação independente (nunca aborta o salvamento do principal)
  if (reparentEntries.length || orderIds.length) {
    updateChildrenAfterSave(uid, { reparentEntries, orderIds }).catch(err => console.warn(err));
  }

  if (draft !== d) return;

  // Atualização otimista local
  const prev = state.models.find(m => m.id === d.id);
  const rec = enrichModel({ ...payload, fav: prev?.fav, pending: true });
  state.models = state.models.filter(m => m.id !== d.id).concat(rec);
  reparentEntries.forEach(({ id, parentId, order }) => {
    const c = state.models.find(m => m.id === id);
    if (c) { c.parentId = parentId; c.order = order; }
  });
  orderIds.forEach((sid, idx) => {
    const s = state.models.find(m => m.id === sid);
    if (s) s.order = idx;
  });

  state.current = null;
  state.mode = 'list';
  state.confirmKey = null;
  draft = null;
  renderList();
  renderMain();
  restoreFocus();
  toast(d.isNew ? 'Modelo criado' : 'Modelo salvo', I.check);
}

/* ---------- Área de Transferência, Cópia e Avanço de Sequência ---------- */
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const t = document.createElement('textarea');
    t.value = text;
    t.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(t);
    t.select();
    let ok = false;
    try { ok = Boolean(document.execCommand('copy')); } catch (__) { ok = false; }
    t.remove();
    if (!ok) toast('Não foi possível copiar.');
    return ok;
  }
}

async function copyCurrent() {
  const m = state.models.find(x => x.id === state.current);
  if (!m || state.mode !== 'use') return;
  const vals = state.values[m.id] || {};
  const fields = m._fields || fieldsOf(m.body);
  const empty = fields.filter(f => !(vals[f] || '').trim());

  if (empty.length) {
    const slots = [...document.querySelectorAll('.slot')];
    const bad = slots.filter(s => empty.includes(s.querySelector('textarea').dataset.f));
    bad.forEach(s => { s.classList.remove('empty-warn'); void s.offsetWidth; s.classList.add('empty-warn'); });
    bad[0]?.querySelector('textarea').focus();
    toast(empty.length === 1 ? `Preencha “${empty[0]}”` : `Faltam ${empty.length} campos`);
    return;
  }

  const text = m.body.replace(FIELD_RE, (_, n) => (vals[n] || '').trim());
  const ok = await writeClipboard(text);
  if (!ok) return;

  const copiedId = m.id;
  const parentId = state.execParentId || copiedId;
  state.mode = 'list';
  state.current = null;
  markStepExecuted(copiedId, parentId);
  renderMain();
  restoreFocus();
  toast('Prompt copiado!', I.check);
}

/* ---------- Menu Flutuante Centralizado (Dock) ---------- */
function renderDock() {
  const dock = $('#dock');
  if (!dock) return;
  if (!state.user) { dock.hidden = true; dock.innerHTML = ''; return; }
  dock.hidden = false;

  const b = (act, icon, label, o = {}) =>
    `<button class="dk ${o.primary ? 'primary' : ''} ${o.cls || ''}" type="button" data-dk="${act}"${o.disabled ? ' disabled' : ''}${o.title ? ` title="${esc(o.title)}"` : ''} aria-label="${esc(label)}">` +
    `${icon}<span class="lbl-t">${esc(label)}</span>${o.kbd ? `<kbd>${o.kbd}</kbd>` : ''}</button>`;
  const sep = '<span class="sep"></span>';
  const cur = state.models.find(x => x.id === state.current);

  if (state.mode === 'edit') {
    dock.innerHTML = b('cancel', I.x, 'Cancelar') + sep +
      b('save', I.save, draft?.saving ? 'Salvando…' : 'Salvar', { primary: true, kbd: `${mod} S`, disabled: !!draft?.saving });
  } else if (state.mode === 'use' && cur) {
    dock.innerHTML = b('cancel', I.x, 'Fechar') + b('edit', I.edit, 'Editar') + sep +
      b('copy', I.copy, 'Copiar prompt', { primary: true, kbd: `${mod} ↵` });
  } else {
    const nextStep = getActiveRoutineNextStep();
    const nextBtn = nextStep
      ? b('next-step', I.play, `Próximo: ${nextStep.sub.name}`, {
          cls: 'next-step-dk',
          kbd: 'Alt ↵',
          title: `Executar etapa ${nextStep.idx + 1}: ${nextStep.sub.name}`
        }) + sep
      : '';
    dock.innerHTML = nextBtn + b('new', I.plus, 'Novo modelo', { primary: !nextStep });
  }
}

$('#dock').addEventListener('click', e => {
  const btn = e.target.closest('[data-dk]');
  if (!btn) return;
  const act = btn.dataset.dk;
  if (act === 'copy') copyCurrent();
  else if (act === 'save') saveDraft();
  else if (act === 'cancel') closePanel();
  else if (act === 'new') {
    if (state.mode === 'edit' && !leaveEdit()) return;
    rememberFocus(btn);
    openEditor(null);
    renderList();
  } else if (act === 'edit') {
    if (state.current) { openEditor(state.current); renderList(); }
  } else if (act === 'next-step') {
    const nextStep = getActiveRoutineNextStep();
    if (nextStep) handlePlay(nextStep.sub.id, e, nextStep.parentId, btn);
  }
});

/* ---------- Toast e Atalhos Globais ---------- */
let toastTimer = null;
function toast(msg, icon = '', opts = {}) {
  const el = $('#toast');
  if (!el) return;
  const { action = null, duration = 2600 } = opts;

  el.innerHTML = `${icon}<span>${esc(msg)}</span>` +
    (action ? `<button type="button" class="toast-act" id="toastAct">${esc(action.label)}</button>` : '');
  el.classList.toggle('has-action', Boolean(action));
  el.classList.add('show');

  if (action) {
    $('#toastAct')?.addEventListener('click', () => {
      clearTimeout(toastTimer);
      el.classList.remove('show', 'has-action');
      action.onClick();
    }, { once: true });
  }

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show', 'has-action');
  }, duration);
}

document.addEventListener('keydown', e => {
  const meta = e.ctrlKey || e.metaKey;
  const k = (e.key || '').toLowerCase();
  if (meta && k === 'enter' && state.mode === 'use') {
    e.preventDefault();
    copyCurrent();
  } else if (e.altKey && k === 'enter' && state.mode === 'list') {
    const nextStep = getActiveRoutineNextStep();
    if (nextStep) {
      e.preventDefault();
      handlePlay(nextStep.sub.id, e, nextStep.parentId);
    }
  } else if (meta && k === 's' && state.mode === 'edit') {
    e.preventDefault();
    saveDraft();
  } else if (k === 'escape') {
    if (!pop.hidden) { closePop(); return; }
    if (state.mode === 'edit' || state.mode === 'use') { closePanel(); }
  }
});

window.addEventListener('beforeunload', e => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });