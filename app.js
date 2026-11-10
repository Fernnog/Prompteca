import {
  watchAuth, login, logout, watchPrompts, newPromptId, savePrompt, deletePrompt, authMessage, saveMessage
} from "./firebase.js";

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
};
const FIELD_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fieldsOf = body => { const out=[]; for (const m of body.matchAll(FIELD_RE)) if(!out.includes(m[1])) out.push(m[1]); return out; };

const state = {
  user:null, authReady:false, models:[], current:null, mode:'empty',
  values:{}, query:'', confirmId:null, loaded:false
};
let unsubPrompts = null;
let draft = null;
let savedRange = { s: 0, e: 0 };

// Captura global para alças de seleção em dispositivos móveis (Android/iOS)
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
  state.models=[]; state.values={}; state.current=null; state.mode='empty'; state.confirmId=null; draft=null;
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

/* ---------- Modelos ---------- */
const sig = m => m ? m.name+'\u0000'+m.body : '';
function setModels(arr){
  const before=sig(state.models.find(m=>m.id===state.current));
  state.models=arr.map(m=>({
    id:m.id,
    name:m.name||'Sem nome',
    body:m.body||'',
    pending:!!m.pending
  })).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
  const wasLoaded=state.loaded; state.loaded=true;
  if(state.current && !state.models.find(m=>m.id===state.current) && state.mode!=='edit'){ state.current=null; state.mode='empty'; }
  if(!state.current && state.mode==='empty' && state.models.length){ state.current=state.models[0].id; state.mode='use'; }
  renderList();
  const after=sig(state.models.find(m=>m.id===state.current));
  if(state.mode!=='edit' && (!wasLoaded || before!==after || state.mode==='empty')) renderMain();
}

/* ---------- Lista Lateral Minimalista ---------- */
function renderList(){
  const q=state.query.trim().toLowerCase();
  const items=state.models.filter(m=>!q||m.name.toLowerCase().includes(q)||m.body.toLowerCase().includes(q));
  $('#count').textContent=state.models.length;
  const ul=$('#list');
  if(!state.authReady || (state.user && !state.loaded)){ ul.innerHTML='<li class="no-res">Carregando…</li>'; return; }
  if(!state.user){ ul.innerHTML='<li class="no-res">Entre para ver seus modelos.</li>'; return; }
  if(!items.length){ ul.innerHTML=`<li class="no-res">${q?'Nenhum modelo encontrado.':'Nenhum modelo ainda.'}</li>`; return; }
  ul.innerHTML=items.map(m=>{
    const n=fieldsOf(m.body).length;
    const syncDot = m.pending ? `<span class="sync-dot" title="Sincronizando com a nuvem…"></span>` : '';
    const badge = n > 0 ? `<span class="badge" title="${n} ${n===1?'campo':'campos'}">${n}</span>` : '';
    const acts = state.confirmId===m.id
      ? `<div class="confirm"><button class="yes" data-act="del-yes" data-id="${m.id}">Excluir</button><button class="no" data-act="del-no">Não</button></div>`
      : `<div class="acts"><button class="ib" data-act="edit" data-id="${m.id}" aria-label="Editar ${esc(m.name)}" title="Editar">${I.edit}</button><button class="ib del" data-act="del" data-id="${m.id}" aria-label="Excluir ${esc(m.name)}" title="Excluir">${I.trash}</button></div>`;
    return `<li class="item ${m.id===state.current?'active':''}"><button class="open" data-act="open" data-id="${m.id}">${syncDot}<span class="n">${esc(m.name)}</span>${badge}</button>${acts}</li>`;
  }).join('');
}
$('#list').addEventListener('click',async e=>{
  const b=e.target.closest('[data-act]'); if(!b) return;
  const id=b.dataset.id, act=b.dataset.act;
  if(act==='open'){ if(state.mode==='edit' && !leaveEdit()) return; state.current=id; state.mode='use'; state.confirmId=null; renderList(); renderMain(); closeSide(); }
  if(act==='edit'){ if(state.mode==='edit' && !leaveEdit()) return; state.current=id; state.confirmId=null; openEditor(id); renderList(); closeSide(); }
  if(act==='del'){ state.confirmId=id; renderList(); clearTimeout(state._ct); state._ct=setTimeout(()=>{state.confirmId=null;renderList();},4000); }
  if(act==='del-no'){ state.confirmId=null; renderList(); }
  if(act==='del-yes'){
    state.confirmId=null; const name=state.models.find(m=>m.id===id)?.name;
    if(state.current===id){ state.current=null; state.mode='empty'; }
    delete state.values[id];
    deletePrompt(state.user.uid,id).catch(err=>{ console.error(err); toast(saveMessage(err)); });
    toast(`“${name}” excluído`, I.trash);
    renderList(); renderMain();
  }
});
$('#q').addEventListener('input',e=>{state.query=e.target.value;renderList();});

/* ---------- Painel Principal (Modo Minimalista) ---------- */
const mod=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘':'Ctrl';

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
  const body=$('#body');
  const m=state.models.find(x=>x.id===state.current);
  if(state.mode==='use' && m){
    const fields=fieldsOf(m.body);
    $('#title').textContent=m.name;
    $('#meta').textContent=fields.length
      ? `${fields.length} ${fields.length===1?'campo':'campos'}`
      : 'Sem campos variáveis';
    const vals=state.values[m.id]||(state.values[m.id]={});

    if(!fields.length){
      body.innerHTML=`<div class="view use-no-fields">
        <div class="card">
          <p>Este modelo está pronto para uso e não exige preenchimento de campos.</p>
          <button class="btn" type="button" id="copyStaticBtn">${I.copy}Copiar prompt <kbd>${mod} ↵</kbd></button>
        </div>
        <details class="peek" id="peekBox">
          <summary>Ver texto do prompt</summary>
          <div class="doc" id="peekDoc">${esc(m.body)}</div>
        </details>
      </div>`;
      const copyBtn = $('#copyStaticBtn');
      copyBtn?.addEventListener('click', copyCurrent);
      if(!matchMedia('(hover:none)').matches) copyBtn?.focus({preventScroll:true});
    } else {
      const slotsHtml=fields.map((f, i)=>{
        const fid=`slot-f-${i}`;
        return `<div class="slot">
          <label for="${fid}">${I.field}${esc(f)}</label>
          <textarea id="${fid}" data-f="${esc(f)}" rows="2" placeholder="Preencha ${esc(f)}…">${esc(vals[f]||'')}</textarea>
        </div>`;
      }).join('');

      body.innerHTML=`<div class="view use-minimal">
        ${slotsHtml}
        <details class="peek" id="peekBox">
          <summary>Ver texto do prompt</summary>
          <div class="doc" id="peekDoc"></div>
        </details>
      </div>`;

      const peekBox = $('#peekBox');
      const peekDoc = $('#peekDoc');
      const syncPeek = () => {
        if(peekBox?.open && peekDoc) peekDoc.innerHTML = formatPeekHtml(m.body, vals);
      };
      peekBox?.addEventListener('toggle', syncPeek);

      body.querySelectorAll('.slot textarea').forEach(ta=>{
        grow(ta);
        ta.addEventListener('input',()=>{
          vals[ta.dataset.f]=ta.value;
          grow(ta);
          syncPeek();
        });
      });
      const first=body.querySelector('.slot textarea');
      if(first && !matchMedia('(hover:none)').matches) first.focus({preventScroll:true});
    }
  } else {
    $('#title').textContent='Prompteca'; $('#meta').textContent='';
    let glyph=I.doc, h, p, btn='';
    if(!state.authReady){ h='Carregando…'; p=''; }
    else if(!state.user){ glyph=I.lock; h='Entre para acessar seus modelos';
      p='Seus prompts ficam salvos na sua conta e aparecem em qualquer dispositivo.';
      btn=`<button class="btn" data-login>Entrar</button>`; }
    else if(!state.loaded){ h='Carregando seus modelos…'; p=''; }
    else if(!state.models.length){ h='Nenhum modelo salvo';
      p='Crie um modelo com o texto do prompt e marque onde entra o seu texto livre. Depois é só preencher e copiar.';
      btn=`<button class="btn" data-new>${I.plus}Criar primeiro modelo</button>`; }
    else { h='Escolha um modelo na lista'; p='Os campos abrem prontos para preencher.'; }
    body.innerHTML=`<div class="view empty"><div><div class="glyph">${glyph}</div><p><strong>${h}</strong></p>${p?`<p>${p}</p>`:''}${btn}</div></div>`;
    body.querySelector('[data-new]')?.addEventListener('click',()=>openEditor(null));
    body.querySelector('[data-login]')?.addEventListener('click',e=>{ e.stopPropagation(); openPop(); });
  }
  renderDock();
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

function openEditor(id, recovered = null){
  if(!state.user){ openPop(); toast('Entre para criar modelos.'); return; }
  const m = id ? state.models.find(x => x.id === id) : null;
  const src = recovered || m;
  const isNew = recovered ? recovered.isNew : !m;
  const orig = recovered ? recovered.orig : (m ? JSON.stringify([m.name, m.body]) : '["",""]');

  draft = {
    id: recovered?.id || m?.id || newPromptId(state.user.uid),
    name: src?.name || '',
    body: src?.body || '',
    isNew,
    saving: false,
    orig
  };
  state.mode='edit';
  $('#title').textContent = isNew ? 'Novo modelo' : 'Editar modelo';
  $('#meta').textContent='';
  $('#body').innerHTML=`<div class="view">
    <div class="field-row"><label class="lbl" for="nm">Nome</label><input id="nm" class="name-in" placeholder="Ex.: Resumo de acórdão" value="${esc(draft.name)}" autocomplete="off"></div>
    <div class="field-row" style="margin-bottom:6px"><span class="lbl">Prompt</span></div>
    <div class="editor">
      <div class="tools" id="tools">${toolsIdle}</div>
      <div class="wrap"><pre class="backdrop" id="bd" aria-hidden="true"></pre><textarea class="ta" id="ta" spellcheck="true" placeholder="Cole ou escreva o prompt. Use “Inserir campo” onde o texto livre deve entrar."></textarea></div>
    </div>
    <div class="chips" id="chips"></div>
  </div>`;
  const ta=$('#ta'); ta.value=draft.body;
  const endPos=ta.value.length;
  ta.setSelectionRange(endPos, endPos);
  savedRange={s:endPos, e:endPos};
  syncBackdrop();

  const saveSel=()=>{ savedRange={s:ta.selectionStart, e:ta.selectionEnd}; };
  ['keyup','mouseup','select','input'].forEach(ev=>ta.addEventListener(ev, saveSel));

  ta.addEventListener('input',()=>{draft.body=ta.value;syncBackdrop();});
  ta.addEventListener('scroll',()=>{$('#bd').scrollTop=ta.scrollTop;});
  new ResizeObserver(syncBackdrop).observe(ta);
  $('#nm').addEventListener('input',e=>draft.name=e.target.value);
  bindAddFieldBtn();
  (draft.isNew && !recovered ? $('#nm') : ta).focus();
  renderDock();
}
function syncBackdrop(){
  const ta=$('#ta'), bd=$('#bd'); if(!ta) return;
  bd.innerHTML=esc(ta.value).replace(/\{\{\s*([^{}]+?)\s*\}\}/g,'<mark>$&</mark>')+'\n';
  bd.style.height=ta.offsetHeight+'px'; bd.scrollTop=ta.scrollTop;
  const fs=fieldsOf(ta.value);
  $('#chips').innerHTML= fs.length
    ? `<span class="lbl">Campos</span>`+fs.map(f=>`<span class="chip">${esc(f)}</span>`).join('')
    : `<span class="lbl" style="text-transform:none;letter-spacing:0">Sem campos: o modelo será copiado como está.</span>`;
}
function askFieldName(){
  const ta=$('#ta');
  if(!ta) return;
  const s=Math.min(savedRange.s, ta.value.length);
  const e=Math.min(savedRange.e, ta.value.length);
  const sel=ta.value.slice(s,e).trim().replace(/[{}]/g,'').slice(0,60);
  const tools=$('#tools');
  tools.innerHTML=`<span class="fname">${I.field}<input id="fn" placeholder="Nome do campo" value="${esc(sel)}" maxlength="60"><button class="tbtn" id="fok" type="button">Inserir</button><button class="mini" id="fcancel" type="button">Cancelar</button></span>`;
  const fn=$('#fn'); fn.focus(); fn.select();
  const restore=()=>{ tools.innerHTML=toolsIdle; bindAddFieldBtn(); };
  const commit=()=>{
    const name=fn.value.trim().replace(/[{}]/g,'')||'Texto livre';
    const token=`{{${name}}}`;
    restore();
    insertAt(ta, token, s, e);
    const pos = s + token.length;
    savedRange = { s: pos, e: pos };
    ta.setSelectionRange(pos, pos);
  };
  $('#fok').addEventListener('click',commit);
  $('#fcancel').addEventListener('click',()=>{restore();ta.focus();ta.setSelectionRange(s,e);});
  fn.addEventListener('keydown',ev=>{
    if(ev.key==='Enter'){ev.preventDefault();commit();}
    if(ev.key==='Escape'){ev.preventDefault();restore();ta.focus();ta.setSelectionRange(s,e);}
  });
}
function dirty(){ return draft && JSON.stringify([draft.name,draft.body])!==draft.orig; }
function leaveEdit(){
  if(draft?.saving){ toast('Aguarde o salvamento terminar.'); return false; }
  if(dirty() && !state._leaveOk){ state._leaveOk=true; toast('Alterações não salvas. Clique de novo para descartar.'); setTimeout(()=>state._leaveOk=false,3000); return false; }
  state._leaveOk=false; draft=null; return true;
}

function finishSave(m, isPending){
  const i=state.models.findIndex(x=>x.id===m.id);
  const item={...m, pending:isPending};
  if(i>=0) state.models[i]=item; else state.models.push(item);
  state.models.sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
  draft=null; state.current=m.id; state.mode='use';
  renderList(); renderMain();
}

async function saveDraft(){
  if(!state.user){ openPop(); toast('Entre para salvar.'); return; }
  if(!draft || draft.saving) return;
  const name=draft.name.trim(), body=draft.body;
  if(!name){ $('#nm').focus(); toast('Dê um nome ao modelo.'); return; }
  if(!body.trim()){ $('#ta').focus(); toast('Escreva o texto do prompt.'); return; }

  const m={id:draft.id, name, body};
  const prevModel=state.models.find(x=>x.id===m.id);
  const backup={
    id:m.id,
    name:m.name,
    body:m.body,
    orig:draft.orig,
    isNew:draft.isNew,
    prev:prevModel ? {...prevModel} : null
  };

  draft.saving=true;
  renderDock();

  const wait = navigator.onLine ? 2500 : 0;
  const writePromise = savePrompt(state.user.uid, m);
  let outcome;
  try {
    outcome = await Promise.race([
      writePromise.then(() => 'ok'),
      new Promise(res => setTimeout(() => res('pending'), wait))
    ]);
  } catch (err) {
    console.error('Erro ao salvar no Firestore:', err);
    if(draft && draft.id === m.id){
      draft.saving = false;
      renderDock();
    }
    const msg = saveMessage(err);
    showStatus(msg);
    toast(msg);
    return;
  }

  if(!draft || draft.id !== m.id) return;

  if(outcome === 'ok'){
    showStatus('');
    finishSave(m, false);
    toast('Modelo salvo', I.check);
  } else {
    finishSave(m, true);
    toast('Salvo neste aparelho · sincronizando…');
    writePromise.catch(err => {
      console.error('Erro tardio na sincronização com o Firestore:', err);
      const msg = saveMessage(err);
      showStatus(msg);
      toast(msg);

      // Reverte o item otimista local caso o rollback do onSnapshot ainda não tenha processado
      const idx = state.models.findIndex(x => x.id === backup.id);
      if(backup.isNew){
        if(idx >= 0) state.models.splice(idx, 1);
      } else if(backup.prev && idx >= 0){
        state.models[idx] = backup.prev;
      }

      // Restaura o editor com o backup completo para evitar qualquer perda de texto
      if(state.mode !== 'edit' || !dirty()){
        state.current = backup.isNew ? null : backup.id;
        openEditor(backup.id, backup);
        renderList();
      }
    });
  }
}
function cancelEdit(){ if(!leaveEdit()) return; state.mode=state.current&&state.models.find(x=>x.id===state.current)?'use':'empty'; renderList(); renderMain(); }

/* ---------- Copiar / limpar ---------- */
function assemble(m){ const vals=state.values[m.id]||{};
  const txt=m.body.replace(FIELD_RE,(_,f)=>(vals[f]||'').trim());
  return {txt, empty:fieldsOf(m.body).filter(f=>!(vals[f]||'').trim()).length};
}
function copyCurrent(){
  const m=state.models.find(x=>x.id===state.current); if(!m) return;
  const {txt,empty}=assemble(m);
  const done=()=>toast(empty?`Copiado · ${empty} ${empty===1?'campo vazio':'campos vazios'}`:'Prompt copiado',I.check);
  if(empty) document.querySelectorAll('.slot').forEach(s=>{ if(!s.querySelector('textarea').value.trim()){ s.classList.remove('empty-warn'); void s.offsetWidth; s.classList.add('empty-warn'); } });
  try{ navigator.clipboard.writeText(txt).then(done,()=>fallbackCopy(txt,done)); }catch(e){ fallbackCopy(txt,done); }
}
function fallbackCopy(txt,done){
  const t=document.createElement('textarea'); t.value=txt; t.style.position='fixed'; t.style.opacity='0'; document.body.appendChild(t); t.select();
  let ok=false; try{ ok=document.execCommand('copy'); }catch(e){} t.remove();
  ok?done():toast('Não deu para copiar automaticamente. Use Ctrl+C no texto.');
}
function clearFields(){ if(!state.current) return; state.values[state.current]={}; renderMain(); toast('Campos limpos',I.eraser); }

/* ---------- Dock ---------- */
function renderDock(){
  const m=state.models.find(x=>x.id===state.current);
  const using=state.mode==='use'&&m;
  const hasFields=using&&fieldsOf(m.body).length>0;
  let h='';
  if(state.mode==='edit'){
    const saving=!!draft?.saving;
    h+=`<button class="dk primary" data-d="save" ${saving?'disabled':''}>${I.save}<span class="lbl-t">${saving?'Salvando…':'Salvar'}</span><kbd>${mod} S</kbd></button>`;
    h+=`<button class="dk" data-d="cancel" ${saving?'disabled':''}>${I.x}<span class="lbl-t">Cancelar</span></button>`;
  } else {
    h+=`<button class="dk ${using?'':'primary'}" data-d="new">${I.plus}<span class="lbl-t">Novo modelo</span></button>`;
    if(using){
      h+=`<span class="sep"></span>`;
      if(hasFields){
        h+=`<button class="dk primary" data-d="copy">${I.copy}<span class="lbl-t">Copiar prompt</span><kbd>${mod} ↵</kbd></button>`;
        h+=`<button class="dk" data-d="clear" aria-label="Limpar campos">${I.eraser}<span class="tip">Limpar campos</span></button>`;
      }
      h+=`<button class="dk" data-d="edit" aria-label="Editar modelo">${I.edit}<span class="tip">Editar modelo</span></button>`;
    }
  }
  h+=`<button class="dk only-mobile" data-d="list" aria-label="Modelos">${I.list}</button>`;
  $('#dock').innerHTML=h;
}
$('#dock').addEventListener('click',e=>{
  const b=e.target.closest('[data-d]'); if(!b || b.disabled) return;
  ({ new:()=>{ if(state.mode==='edit'&&!leaveEdit())return; openEditor(null); renderList(); },
     save:saveDraft, cancel:cancelEdit, copy:copyCurrent, clear:clearFields,
     edit:()=>openEditor(state.current), list:toggleSide })[b.dataset.d]();
});
document.addEventListener('keydown',e=>{
  const k=e.key.toLowerCase(), m=e.metaKey||e.ctrlKey;
  if(m&&k==='s'&&state.mode==='edit'){ e.preventDefault(); saveDraft(); }
  if(m&&k==='enter'&&state.mode==='use'){ e.preventDefault(); copyCurrent(); }
  if(e.key==='Escape'){ if(!pop.hidden) closePop(); else if($('#side').classList.contains('open-m')) closeSide(); }
});

/* ---------- Mobile ---------- */
function toggleSide(){ $('#side').classList.toggle('open-m'); $('#scrim').classList.toggle('on'); }
function closeSide(){ $('#side').classList.remove('open-m'); $('#scrim').classList.remove('on'); }
$('#scrim').addEventListener('click',closeSide);

let tt;
function toast(msg,icon=''){ const t=$('#toast'); t.innerHTML=icon+esc(msg); t.classList.add('show'); clearTimeout(tt); tt=setTimeout(()=>t.classList.remove('show'),2600); }

renderList(); renderMain();
