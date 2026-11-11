import {
  watchAuth, login, logout, watchPrompts, newPromptId,
  savePrompt, savePromptWithReparent, toggleFavPrompt, deletePromptWithChildren,
  authMessage, saveMessage
} from "./firebase.js?v=2";

const I = {
  plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  edit:'<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/></svg>',
  trash:'<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  copy:'<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  check:'<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  field:'<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M7 10v4M10 12h7"/></svg>',
  eraser:'<svg viewBox="0 0 24 24"><path d="m7 21-4-4L14 6l6 6-9 9z"/><path d="M7 21h13M10 10l6 6"/></svg>',
  save:'<svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/></svg>',
  x:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  list:'<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  doc:'<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/></svg>',
  lock:'<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  star:'<svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  branch:'<svg viewBox="0 0 24 24"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  sub:'<svg class="sub-ic" viewBox="0 0 24 24"><path d="M6 4v10a4 4 0 0 0 4 4h8"/><path d="m15 15 3 3-3 3"/></svg>',
  expandPrompt:'<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 9l-3 3 3 3"/></svg>',
  expandList:'<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16M9 9l3 3-3 3"/></svg>'
};

const FIELD_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fieldsOf = body => { const out=[]; for (const m of body.matchAll(FIELD_RE)) if(!out.includes(m[1])) out.push(m[1]); return out; };
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const norm = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const state = {
  user: null, authReady: false, models: [], current: null, mode: 'empty',
  values: {}, query: '', confirmKey: null, loaded: false
};

const ui = {
  override: null,     // null (automático) | 'list' | 'prompt' | 'collapsed'
  peekOpenById: {},   // preserva abertura do <details> por modelo
  searchFocused: false
};

let unsubPrompts = null;
let draft = null;
let savedRange = { s: 0, e: 0 };
let searchTimer = null;
let blurTimer = null;

/* ---------- Máquina de Estados de Layout ---------- */
function computeLayout() {
  if (state.mode === 'edit') {
    return ui.override === 'collapsed' ? 'collapsed' : 'prompt';
  }
  if (ui.override) return ui.override;
  if (ui.searchFocused || state.query.trim().length > 0) return 'list';
  if (state.mode === 'use' && state.current && ui.peekOpenById[state.current]) return 'prompt';
  return 'list';
}

function applyLayout() {
  const layout = computeLayout();
  const root = $('#appRoot');
  const side = $('#side');
  const toggleBtn = $('#toggleLayoutBtn');
  if (!root || !side || !toggleBtn) return;

  root.dataset.layout = layout;
  const isCollapsed = layout === 'collapsed' && matchMedia('(min-width: 901px)').matches;
  side.toggleAttribute('inert', isCollapsed);

  const isWidePrompt = layout === 'prompt' || layout === 'collapsed';
  toggleBtn.setAttribute('aria-pressed', String(isWidePrompt));
  toggleBtn.innerHTML = isWidePrompt ? I.expandList : I.expandPrompt;

  const label = layout === 'collapsed'
    ? 'Reabrir barra lateral de modelos'
    : (layout === 'prompt' ? 'Ampliar lista de modelos' : 'Ampliar área do prompt');
  toggleBtn.setAttribute('aria-label', label);
  toggleBtn.title = label;
}

$('#toggleLayoutBtn')?.addEventListener('click', () => {
  const current = computeLayout();
  if (current === 'collapsed') {
    ui.override = state.mode === 'edit' ? 'prompt' : 'list';
  } else if (current === 'list') {
    ui.override = 'prompt';
  } else {
    ui.override = 'list';
  }
  applyLayout();
});

$('#collapseSideBtn')?.addEventListener('click', () => {
  ui.override = 'collapsed';
  applyLayout();
});

document.addEventListener('selectionchange', () => {
  if (state.mode !== 'edit') return;
  const ta = $('#ta');
  if (ta && document.activeElement === ta) {
    savedRange = { s: ta.selectionStart, e: ta.selectionEnd };
  }
});

/* ---------- Conta ---------- */
const userBtn=$('#userBtn'), pop=$('#authPop');
function openPop(){ pop.hidden=false; userBtn.setAttribute('aria-expanded','true');
  if(!state.user) setTimeout(()=>$('#email').focus(),0); }
function closePop(){ pop.hidden=true; userBtn.setAttribute('aria-expanded','false'); }
userBtn.addEventListener('click',()=> pop.hidden?openPop():closePop());
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
  state.models=[]; state.values={}; state.current=null; state.mode='empty'; state.confirmKey=null; draft=null;
  ui.override=null; ui.peekOpenById={};
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
      showStatus(msg);
      toast(msg);
      state.loaded=true; renderList(); renderMain();
    });
  } else {
    state.loaded=true; showStatus('');
  }
  renderList(); renderMain();
});

function showStatus(t){ const el=$('#status'); el.textContent=t; el.hidden=!t; }

/* ---------- Modelos e Resolução Não-Destrutiva de Hierarquia ---------- */
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
  childrenMap.forEach(list => list.sort((a, b) => collator.compare(a.name, b.name)));

  return { byId, effParentId, mains, childrenMap };
}

function setModels(arr){
  const before = panelSig(state.models.find(m=>m.id===state.current));
  state.models = arr.map(enrichModel).sort((a,b) => collator.compare(a.name, b.name));
  const wasLoaded = state.loaded; state.loaded = true;
  if(state.current && !state.models.find(m=>m.id===state.current) && state.mode!=='edit'){
    state.current = null; state.mode = 'empty';
  }
  if(!state.current && state.mode==='empty' && state.models.length){
    const { mains } = resolveHierarchy(state.models);
    const firstFav = mains.find(m => m.fav) || state.models.find(m => m.fav) || mains[0] || state.models[0];
    state.current = firstFav.id; state.mode = 'use';
  }
  renderList();
  const after = panelSig(state.models.find(m=>m.id===state.current));
  if(state.mode!=='edit' && (!wasLoaded || before!==after || state.mode==='empty')) renderMain();
}

/* ---------- Lista Lateral (Favoritos, Árvore e Busca Bidirecional) ---------- */
function renderItemHtml(m, opts = {}) {
  const { isSub = false, parentName = '', ctxOnly = false, keyPrefix = 'tree', childCount = 0 } = opts;
  const n = m._fields ? m._fields.length : fieldsOf(m.body).length;
  const syncDot = m.pending ? `<span class="sync-dot" title="Sincronizando com a nuvem…"></span>` : '';
  const badge = n > 0 ? `<span class="badge" title="${n} ${n===1?'campo':'campos'}">${n}</span>` : '';
  const subIcon = isSub ? I.sub : '';
  const originTag = parentName ? `<span class="sub-origin">↳ ${esc(parentName)}</span>` : '';
  const rowKey = `${keyPrefix}:${m.id}`;

  const favBtn = `<button class="fav-btn ${m.fav?'on':''}" data-act="fav" data-id="${m.id}" aria-label="${m.fav?'Remover dos favoritos':'Favoritar'} ${esc(m.name)}" title="${m.fav?'Favorito (clique para remover)':'Fixar nos favoritos'}">${I.star}</button>`;
  const branchBtn = !isSub
    ? `<button class="ib branch" data-act="sub-new" data-id="${m.id}" aria-label="Criar subprompt para ${esc(m.name)}" title="Criar subprompt vinculado">${I.branch}</button>`
    : '';

  const warnText = childCount > 0 ? `<span class="warn-sub">${childCount} sub${childCount>1?'s':''} virar${childCount>1?'ão':'á'} principal</span>` : '';
  const acts = state.confirmKey === rowKey
    ? `<div class="confirm">${warnText}<button class="yes" data-act="del-yes" data-id="${m.id}">Excluir</button><button class="no" data-act="del-no">Não</button></div>`
    : `<div class="acts">${branchBtn}<button class="ib" data-act="edit" data-id="${m.id}" aria-label="Editar ${esc(m.name)}" title="Editar">${I.edit}</button><button class="ib del" data-act="del" data-id="${m.id}" data-key="${rowKey}" aria-label="Excluir ${esc(m.name)}" title="Excluir">${I.trash}</button></div>`;

  return `<li class="item ${isSub?'is-sub':''} ${ctxOnly?'ctx-only':''} ${m.id===state.current?'active':''}">
    ${favBtn}
    <button class="open" data-act="open" data-id="${m.id}">${syncDot}${subIcon}<span class="n">${esc(m.name)}</span>${originTag}${badge}</button>
    ${acts}
  </li>`;
}

function renderList(){
  const q = norm(state.query.trim());
  const { byId, effParentId, mains, childrenMap } = resolveHierarchy(state.models);
  const subCount = state.models.length - mains.length;
  $('#count').textContent = subCount > 0 ? `${mains.length} · ${subCount} sub${subCount>1?'s':''}` : String(state.models.length);

  const ul = $('#list');
  if(!state.authReady || (state.user && !state.loaded)){ ul.innerHTML='<li class="no-res">Carregando…</li>'; applyLayout(); return; }
  if(!state.user){ ul.innerHTML='<li class="no-res">Entre para ver seus modelos.</li>'; applyLayout(); return; }
  if(!state.models.length){ ul.innerHTML='<li class="no-res">Nenhum modelo ainda.</li>'; applyLayout(); return; }

  let html = '';

  if (q) {
    const groups = [];
    mains.forEach(main => {
      const subs = childrenMap.get(main.id) || [];
      const mainHit = main._normAll.includes(q);
      const matchingSubs = subs.filter(s => s._normAll.includes(q));
      if (mainHit) {
        groups.push({ main, mainCtxOnly: false, subs });
      } else if (matchingSubs.length > 0) {
        groups.push({ main, mainCtxOnly: true, subs: matchingSubs });
      }
    });

    if (!groups.length) {
      ul.innerHTML = '<li class="no-res">Nenhum modelo ou subprompt encontrado.</li>';
      applyLayout();
      return;
    }

    html = groups.map(g => {
      const allSubsCount = (childrenMap.get(g.main.id) || []).length;
      return renderItemHtml(g.main, { isSub: false, ctxOnly: g.mainCtxOnly, keyPrefix: 'search', childCount: allSubsCount }) +
        g.subs.map(s => renderItemHtml(s, { isSub: true, keyPrefix: 'search' })).join('');
    }).join('');
  } else {
    const favMains = mains.filter(m => m.fav);
    const regularMains = mains.filter(m => !m.fav);
    const pinnedSubShortcuts = state.models.filter(m => {
      const pid = effParentId(m);
      return pid && m.fav && !byId.get(pid)?.fav;
    }).sort((a, b) => collator.compare(a.name, b.name));

    const renderBranch = main => {
      const subs = childrenMap.get(main.id) || [];
      return renderItemHtml(main, { isSub: false, keyPrefix: 'tree', childCount: subs.length }) +
        subs.map(s => renderItemHtml(s, { isSub: true, keyPrefix: 'tree' })).join('');
    };

    if (favMains.length || pinnedSubShortcuts.length) {
      html += `<li class="list-sec">${I.star}Fixados nos Favoritos</li>`;
      html += favMains.map(renderBranch).join('');
      html += pinnedSubShortcuts.map(s => {
        const pid = effParentId(s);
        const pName = (pid && byId.get(pid)?.name) || '';
        return renderItemHtml(s, { isSub: true, parentName: pName, keyPrefix: 'fav-sub' });
      }).join('');
      if (regularMains.length) {
        html += `<li class="list-sec">Modelos</li>`;
      }
    }
    html += regularMains.map(renderBranch).join('');
  }

  ul.innerHTML = html;
  applyLayout();
}

$('#list').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const id = b.dataset.id, act = b.dataset.act;

  if(act === 'open'){
    if(state.mode==='edit' && !leaveEdit()) return;
    state.current = id; state.mode = 'use'; state.confirmKey = null;
    if (ui.override === 'prompt') ui.override = null;
    renderList(); renderMain(); closeSide();
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
    state.confirmKey = null;
    openEditor(null, null, id);
    renderList(); closeSide();
  }
  if(act === 'edit'){
    if(state.mode==='edit' && !leaveEdit()) return;
    state.current = id; state.confirmKey = null;
    openEditor(id);
    renderList(); closeSide();
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
    if(state.current === id){ state.current = null; state.mode = 'empty'; }
    delete state.values[id];
    delete ui.peekOpenById[id];
    deletePromptWithChildren(state.user.uid, id, childIds).catch(err => {
      console.error(err); toast(saveMessage(err));
    });
    toast(childIds.length ? `“${name}” excluído · ${childIds.length} sub(s) promovido(s)` : `“${name}” excluído`, I.trash);
    renderList(); renderMain();
  }
});

const qInput = $('#q');
qInput.addEventListener('focus', () => {
  clearTimeout(blurTimer);
  ui.searchFocused = true;
  if (state.mode !== 'edit' && ui.override === 'prompt') ui.override = null;
  applyLayout();
});
qInput.addEventListener('blur', () => {
  clearTimeout(blurTimer);
  blurTimer = setTimeout(() => {
    ui.searchFocused = false;
    applyLayout();
  }, 180);
});
qInput.addEventListener('input', e => {
  state.query = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderList, 90);
});

/* ---------- Painel Principal ---------- */
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

function formatPeekHtml(body, vals){
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
  const body = $('#body');
  const m = state.models.find(x => x.id === state.current);
  if(state.mode === 'use' && m){
    const { byId, effParentId } = resolveHierarchy(state.models);
    const pid = effParentId(m);
    const parentModel = pid ? byId.get(pid) : null;
    const fields = m._fields || fieldsOf(m.body);

    $('#title').textContent = m.name;
    $('#meta').textContent = fields.length
      ? `${fields.length} ${fields.length===1?'campo':'campos'}`
      : 'Sem campos variáveis';

    const vals = state.values[m.id] || (state.values[m.id] = {});
    const parentVals = parentModel ? (state.values[parentModel.id] || {}) : {};
    const canPullFromParent = parentModel && fields.some(f => (parentVals[f] || '').trim() && !(vals[f] || '').trim());

    const ctxBarHtml = parentModel
      ? `<div class="ctx-bar">
          <button type="button" class="parent-pill" id="goParentBtn" title="Abrir prompt principal">${I.sub}Subprompt de: <strong>${esc(parentModel.name)}</strong></button>
          ${canPullFromParent ? `<button type="button" class="inherit-btn" id="pullParentValsBtn" title="Preencher campos em comum com os valores digitados no prompt principal">${I.field}Reaproveitar dados do principal</button>` : ''}
        </div>`
      : '';

    const isPeekOpen = !!ui.peekOpenById[m.id];

    if(!fields.length){
      body.innerHTML = `<div class="view use-no-fields">
        ${ctxBarHtml}
        <div class="card">
          <p>Este modelo está pronto para uso e não exige preenchimento de campos.</p>
          <button class="btn" type="button" id="copyStaticBtn">${I.copy}Copiar prompt <kbd>${mod} ↵</kbd></button>
        </div>
        <details class="peek" id="peekBox" ${isPeekOpen ? 'open' : ''}>
          <summary>Ver texto do prompt</summary>
          <div class="doc" id="peekDoc">${esc(m.body)}</div>
        </details>
      </div>`;
      const copyBtn = $('#copyStaticBtn');
      copyBtn?.addEventListener('click', copyCurrent);
      if(!matchMedia('(hover:none)').matches) copyBtn?.focus({preventScroll:true});
    } else {
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
          <div class="doc" id="peekDoc">${isPeekOpen ? formatPeekHtml(m.body, vals) : ''}</div>
        </details>
      </div>`;

      body.querySelectorAll('.slot textarea').forEach(ta => {
        grow(ta);
        ta.addEventListener('input', () => {
          vals[ta.dataset.f] = ta.value;
          grow(ta);
          if ($('#peekBox')?.open && $('#peekDoc')) {
            $('#peekDoc').innerHTML = formatPeekHtml(m.body, vals);
          }
        });
      });
      const first = body.querySelector('.slot textarea');
      if(first && !matchMedia('(hover:none)').matches) first.focus({preventScroll:true});
    }

    $('#goParentBtn')?.addEventListener('click', () => {
      state.current = parentModel.id;
      state.mode = 'use';
      state.confirmKey = null;
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
    const peekDoc = $('#peekDoc');
    peekBox?.addEventListener('toggle', () => {
      if (peekBox.open === !!ui.peekOpenById[m.id]) return; // Ignora toggle de montagem inicial do DOM
      ui.peekOpenById[m.id] = peekBox.open;
      if (peekBox.open && peekDoc && fields.length) {
        peekDoc.innerHTML = formatPeekHtml(m.body, vals);
      }
      if (ui.override !== 'collapsed') ui.override = null;
      applyLayout();
    });
  } else {
    $('#title').textContent = 'Prompteca'; $('#meta').textContent = '';
    let glyph = I.doc, h, p, btn = '';
    if(!state.authReady){ h='Carregando…'; p=''; }
    else if(!state.user){ glyph=I.lock; h='Entre para acessar seus modelos';
      p='Seus prompts ficam salvos na sua conta e aparecem em qualquer dispositivo.';
      btn=`<button class="btn" data-login>Entrar</button>`; }
    else if(!state.loaded){ h='Carregando seus modelos…'; p=''; }
    else if(!state.models.length){ h='Nenhum modelo salvo';
      p='Crie um modelo com o texto do prompt e marque onde entra o seu texto livre. Depois é só preencher e copiar.';
      btn=`<button class="btn" data-new>${I.plus}Criar primeiro modelo</button>`; }
    else { h='Escolha um modelo na lista à esquerda'; p='Os campos abrem prontos para preencher.'; }
    body.innerHTML=`<div class="view empty"><div><div class="glyph">${glyph}</div><p><strong>${h}</strong></p>${p?`<p>${p}</p>`:''}${btn}</div></div>`;
    body.querySelector('[data-new]')?.addEventListener('click',()=>openEditor(null));
    body.querySelector('[data-login]')?.addEventListener('click',e=>{ e.stopPropagation(); openPop(); });
  }
  renderDock();
  applyLayout();
}
function grow(ta){ ta.style.height='auto'; ta.style.height=ta.scrollHeight+'px'; }

/* ---------- Editor ---------- */
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
  try {
    ok = document.execCommand && document.execCommand('insertText', false, text);
  } catch (_) {
    ok = false;
  }
  if(!ok){
    ta.setRangeText(text, s, e, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function openEditor(id, recovered = null, defaultParentId = null){
  if(!state.user){ openPop(); toast('Entre para criar modelos.'); return; }
  const m = id ? state.models.find(x => x.id === id) : null;
  const src = recovered || m;
  const isNew = recovered ? recovered.isNew : !m;

  const { effParentId, mains, childrenMap } = resolveHierarchy(state.models);
  const rawParentId = recovered !== null
    ? (recovered.parentId || null)
    : (m ? (m.parentId || null) : (defaultParentId || null));
  const resolvedParentId = m ? effParentId(m) : rawParentId;
  const hasOrphanParent = !!(rawParentId && !resolvedParentId);

  const orig = recovered
    ? recovered.orig
    : JSON.stringify([src?.name || '', src?.body || '', rawParentId]);

  const existingChildren = id ? (childrenMap.get(id) || []) : [];
  const eligibleParents = mains.filter(x => x.id !== id);

  draft = {
    id: recovered?.id || m?.id || newPromptId(state.user.uid),
    name: src?.name || '',
    body: src?.body || '',
    parentId: rawParentId,
    isNew,
    saving: false,
    orig
  };
  state.mode = 'edit';

  const orphanOpt = hasOrphanParent
