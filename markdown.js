// Motor puro de detecção, conversão e renderização Markdown do Prompteca.
// - Zero lookbehinds em regexes (compatível com Safari/iOS < 16.4)
// - Leitura de estilos inline via CSSOM nativo (imune a mso-bidi-* do Word, !important e shorthand font)
// - Percurso HTML O(N)

const DEFAULT_FIELD_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const safeUrl = url => /^(https?:|mailto:)/i.test(String(url || '').trim()) ? String(url).trim() : '';

// Lê a propriedade CSS exata via CSSOM do elemento (ignora mso-bidi-*, remove !important e resolve cascata/shorthands)
const cssVal = (el, prop) => (el?.style?.getPropertyValue?.(prop) || '').trim().toLowerCase();

const isBoldEl = el => {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const w = cssVal(el, 'font-weight');
  if (w) {
    if (w === 'normal' || w === 'lighter') return false; // Ignora wrapper falso do Google Docs
    if (w === 'bold' || w === 'bolder') return true;
    const num = Number(w);
    if (Number.isFinite(num)) return num >= 600;
  }
  return /^(B|STRONG)$/.test(el.tagName);
};

const isItalicEl = el => {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const fs = cssVal(el, 'font-style');
  if (fs) {
    if (fs === 'normal') return false;
    if (fs === 'italic' || fs.startsWith('oblique')) return true;
  }
  return /^(I|EM)$/.test(el.tagName);
};

const isStrikeEl = el => {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const td = `${cssVal(el, 'text-decoration')} ${cssVal(el, 'text-decoration-line')}`.trim();
  if (/\bline-through\b/.test(td)) return true;
  if (td === 'none') return false;
  return /^(S|DEL|STRIKE)$/.test(el.tagName);
};

/**
 * Identifica estrutura Markdown em dois níveis:
 * - isMarkdown (score >= 2): exibe badge MD e protege colagem text/plain.
 * - isStrong (bloco forte, score >= 3 ou >= 2 tipos): habilita abertura automática no modo dividido.
 */
export function detectMarkdown(text = '') {
  const src = String(text || '');
  if (!src.trim()) return { isMarkdown: false, isStrong: false, score: 0, features: [] };

  let score = 0;
  let hasStrongBlock = false;
  const features = [];

  if (/^#{1,6}\s+\S/m.test(src)) { score += 2; hasStrongBlock = true; features.push('títulos'); }
  if (/^\s*(?:```|~~~)/m.test(src)) { score += 2; hasStrongBlock = true; features.push('blocos de código'); }
  if (/^\|.+\|\s*\n\|[\s:|-]+\|/m.test(src)) { score += 2; hasStrongBlock = true; features.push('tabelas'); }
  if (/(\*\*|__)\S(?:[^\n]*?\S)?\1/.test(src)) { score += 2; features.push('negrito'); }
  if (/^>\s+\S/m.test(src)) { score += 2; features.push('citações'); }
  if (/\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)/.test(src)) { score += 2; features.push('links'); }

  const listItems = (src.match(/^\s*(?:[-*+]|\d+\.)\s+\S/gm) || []).length;
  if (listItems >= 2) { score += 2; features.push('listas'); }
  else if (listItems === 1) { score += 1; features.push('lista'); }

  if (/`[^`\n]+`/.test(src)) { score += 1; features.push('código inline'); }
  if (/^\s*(?:[-*_]){3,}\s*$/m.test(src)) { score += 1; features.push('separador'); }

  const isMarkdown = score >= 2;
  const isStrong = hasStrongBlock || score >= 3 || features.length >= 2;
  return { isMarkdown, isStrong, score, features };
}

/**
 * Classifica o HTML colado em:
 * - 'block': contém estrutura documental (h1-h6, ul, ol, table, pre, blockquote, hr)
 * - 'inline': contém apenas formatação inline real (negrito, itálico, tachado, código inline)
 * - 'none': sem formatação relevante (inclusive wrappers falsos do Google Docs)
 */
export function classifyHtmlPaste(html = '') {
  if (!html || typeof DOMParser === 'undefined') return 'none';
  if (!/<(h[1-6]|ul|ol|table|pre|blockquote|hr|strong|b|em|i|s|del|strike|code|span)\b/i.test(html)) {
    return 'none';
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.body;
  if (!root) return 'none';

  if (root.querySelector('h1,h2,h3,h4,h5,h6,ul,ol,table,pre,blockquote,hr')) {
    return 'block';
  }

  const candidates = root.querySelectorAll('strong,b,em,i,s,del,strike,code,span');
  for (const el of candidates) {
    if (!el.textContent?.trim()) continue;
    if (el.tagName === 'CODE' || isBoldEl(el) || isItalicEl(el) || isStrikeEl(el)) {
      return 'inline';
    }
  }
  return 'none';
}

/**
 * Converte HTML rico (ChatGPT, Claude, Gemini, Google Docs, Notion, Word) para Markdown limpo.
 */
export function htmlToMarkdown(html = '') {
  if (!html || typeof DOMParser === 'undefined') return '';

  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!doc.body) return '';

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'SVG', 'BUTTON', 'INPUT']);

  const wrapInline = (inner, mk) => {
    if (!inner || !inner.trim()) return inner;
    // Evita marcadores inline quebrados atravessando múltiplos parágrafos
    if (inner.includes('\n\n')) {
      return inner.split('\n\n').map(part => wrapInline(part, mk)).join('\n\n');
    }
    const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m && m[2] ? `${m[1]}${mk}${m[2]}${mk}${m[3]}` : inner;
  };

  const applyInlineStyles = (el, inner) => {
    if (!inner || !inner.trim()) return inner;
    let out = inner;
    if (isStrikeEl(el)) out = wrapInline(out, '~~');
    if (isItalicEl(el)) out = wrapInline(out, '*');
    if (isBoldEl(el)) out = wrapInline(out, '**');
    return out;
  };

  const convertNodes = (nodes, ctx) => Array.from(nodes).map(n => walk(n, ctx)).join('');

  const renderList = (listEl, depth) => {
    const ordered = listEl.tagName === 'OL';
    const startAttr = parseInt(listEl.getAttribute('start') || '1', 10);
    const start = Number.isFinite(startAttr) && startAttr > 0 ? startAttr : 1;
    const indent = '  '.repeat(depth);
    const items = Array.from(listEl.children).filter(el => el.tagName === 'LI');

    const lines = items.map((li, idx) => {
      const marker = ordered ? `${start + idx}. ` : '- ';
      const ownNodes = [];
      const nestedLists = [];

      for (const child of li.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')) {
          nestedLists.push(child);
        } else {
          ownNodes.push(child);
        }
      }

      const ownText = convertNodes(ownNodes, { listDepth: depth, pre: false, code: false })
        .trim()
        .replace(/\n{2,}/g, '\n')
        .replace(/\n/g, `\n${indent}  `);

      let line = `${indent}${marker}${ownText}`;
      if (nestedLists.length) {
        const subBlocks = nestedLists.map(sub => renderList(sub, depth + 1)).filter(Boolean);
        if (subBlocks.length) line += '\n' + subBlocks.join('\n');
      }
      return line;
    });

    const block = lines.join('\n');
    return depth === 0 ? `\n\n${block}\n\n` : block;
  };

  const walk = (node, ctx = { listDepth: 0, pre: false, code: false }) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (ctx.pre || ctx.code) return node.nodeValue;
      return node.nodeValue.replace(/[\s\u00a0]+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName;
    if (SKIP.has(tag)) return '';
    if (tag === 'BR') return '\n';
    if (tag === 'HR') return '\n\n---\n\n';

    if (/^H[1-6]$/.test(tag)) {
      const lvl = Number(tag[1]);
      const inner = convertNodes(node.childNodes, ctx).trim().replace(/\s*\n\s*/g, ' ');
      return inner ? `\n\n${'#'.repeat(lvl)} ${inner}\n\n` : '';
    }

    if (tag === 'PRE') {
      const codeEl = node.querySelector('code');
      const raw = (codeEl || node).textContent.replace(/\r\n/g, '\n').replace(/\n$/, '');
      const langMatch = (codeEl?.className || node.className || '').match(/(?:language-|lang-)([a-z0-9_+-]+)/i);
      const lang = langMatch ? langMatch[1] : '';
      return `\n\n\`\`\`${lang}\n${raw}\n\`\`\`\n\n`;
    }

    if (tag === 'CODE') {
      const raw = node.textContent;
      if (!raw) return '';
      return raw.includes('`') ? `\`\` ${raw} \`\`` : `\`${raw}\``;
    }

    if (tag === 'A') {
      const text = convertNodes(node.childNodes, ctx).trim();
      const href = safeUrl(node.getAttribute('href') || '');
      if (!text) return '';
      return href && href !== text ? `[${text}](${href})` : text;
    }

    if (tag === 'BLOCKQUOTE') {
      const inner = convertNodes(node.childNodes, ctx).trim();
      if (!inner) return '';
      const quoted = inner.split('\n').map(l => (l.trim() ? `> ${l}` : '>')).join('\n');
      return `\n\n${quoted}\n\n`;
    }

    if (tag === 'UL' || tag === 'OL') {
      return renderList(node, ctx.listDepth);
    }

    if (tag === 'TABLE') {
      const rows = Array.from(node.querySelectorAll('tr')).map(tr =>
        Array.from(tr.children)
          .filter(c => c.tagName === 'TH' || c.tagName === 'TD')
          .map(c => convertNodes(c.childNodes, ctx).trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|'))
      ).filter(r => r.length > 0);
      if (!rows.length) return '';
      const cols = Math.max(...rows.map(r => r.length));
      const padRow = r => `| ${Array.from({ length: cols }, (_, i) => r[i] || '').join(' | ')} |`;
      const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
      return `\n\n${[padRow(rows[0]), sep, ...rows.slice(1).map(padRow)].join('\n')}\n\n`;
    }

    if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') {
      const inner = convertNodes(node.childNodes, ctx).trim();
      return inner ? `\n\n${inner}\n\n` : '';
    }

    const inner = convertNodes(node.childNodes, ctx);
    return applyInlineStyles(node, inner);
  };

  return walk(doc.body)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Renderiza Markdown para HTML seguro.
 * - Protege contra XSS (HTML bruto escapado; tags XML de prompt ficam visíveis).
 * - Suporta listas aninhadas mistas W3C válidas, <ol start>, checklists, tabelas e código.
 * - Aceita `{ fieldRe, values }` para renderizar valores preenchidos sem parsear Markdown nos valores.
 */
export function renderMarkdown(source = '', options = {}) {
  const fieldRe = options.fieldRe || DEFAULT_FIELD_RE;
  const values = options.values || null;
  const src = String(source || '').replace(/\r\n/g, '\n');
  if (!src.trim()) return '<p class="md-empty">Nenhum conteúdo para pré-visualizar ainda.</p>';

  const renderVarMark = (fullMatch, varName) => {
    const rawVal = values && typeof values[varName] === 'string' ? values[varName].trim() : '';
    if (rawVal) return `<mark class="md-var md-var-filled">${esc(rawVal)}</mark>`;
    return `<mark class="md-var">${esc(fullMatch)}</mark>`;
  };

  const renderVarsOnly = text => {
    let out = '', last = 0;
    for (const m of text.matchAll(fieldRe)) {
      out += esc(text.slice(last, m.index)) + renderVarMark(m[0], m[1]);
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  };

  const applyEmphasis = escapedText => escapedText
    .replace(/\*\*\*(\S(?:[^\n]*?\S)?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(\S(?:[^\n]*?\S)?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(\S(?:[^\n]*?\S)?)__/g, '<strong>$1</strong>')
    .replace(/~~(\S(?:[^\n]*?\S)?)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_(\S(?:[^_\n]*?\S)?)_(?!\w)/g, '$1<em>$2</em>');

  const renderInline = text => {
    const stash = [];
    const hold = html => `\u0000T${stash.push(html) - 1}\u0000`;
    const restore = s => s.replace(/\u0000T(\d+)\u0000/g, (_, idx) => stash[Number(idx)]);

    // 1. Reserva códigos inline e {{campos}} antes das ênfases
    let s = text.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${renderVarsOnly(code)}</code>`));
    s = s.replace(fieldRe, (full, name) => hold(renderVarMark(full, name)));

    // 2. Reserva links antes do esc() global (sem duplo escape, sem ênfase em href, com formatação no label)
    s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+(?:\([^()\s]*\)[^()\s]*)*)\)/g, (full, label, url) => {
      const clean = safeUrl(url);
      if (!clean) return full;
      const renderedLabel = applyEmphasis(esc(label));
      return hold(`<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer">${renderedLabel}</a>`);
    });

    // 3. Escapa texto restante e aplica ênfases inline
    s = applyEmphasis(esc(s));

    // 4. Restaura tokens reservados (inclusive código/{{campos}} dentro de labels de links)
    return restore(restore(s));
  };

  const lines = src.split('\n');
  const out = [];
  let i = 0;

  const isTableSep = line => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && /-/.test(line);
  const splitRow = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const parseListMarker = line => {
    const m = line.match(/^([ \t]*)(?:([-*+])|(\d+)\.)\s+(.*)$/);
    if (!m) return null;
    const indent = m[1].replace(/\t/g, '  ').length;
    const ordered = Boolean(m[3]);
    return {
      indent,
      tag: ordered ? 'ol' : 'ul',
      start: ordered ? Math.max(1, parseInt(m[3], 10)) : 1,
      content: m[4]
    };
  };

  const startsNewBlock = idx => {
    const l = lines[idx];
    if (!l || !l.trim()) return true;
    if (/^(?:#{1,6}\s|>\s?|\s*(?:```|~~~)|\s*(?:[-*_]){3,}\s*$)/.test(l)) return true;
    if (parseListMarker(l)) return true;
    if (l.includes('|') && idx + 1 < lines.length && isTableSep(lines[idx + 1])) return true;
    return false;
  };

  const serializeListNode = node => {
    const attrs = node.tag === 'ol' && node.start !== 1 ? ` start="${node.start}"` : '';
    const inner = node.items.map(it => {
      const kids = it.children.join('');
      return it.isTask
        ? `<li class="md-task"><div class="md-task-row">${it.html}</div>${kids}</li>`
        : `<li>${it.html}${kids}</li>`;
    }).join('');
    return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Bloco de código cercado (``` ou ~~~)
    const fence = line.match(/^\s*(```|~~~)\s*([a-z0-9_+-]*)\s*$/i);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const langBar = lang ? `<div class="md-code-lang">${esc(lang)}</div>` : '';
      out.push(`<div class="md-code-block">${langBar}<pre><code>${renderVarsOnly(codeLines.join('\n'))}</code></pre></div>`);
      continue;
    }

    // Separador horizontal
    if (/^\s*(?:[-*_]){3,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Títulos (# até ######)
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
      i++;
      continue;
    }

    // Tabela GFM
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headers = splitRow(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        bodyRows.push(splitRow(lines[i]));
        i++;
      }
      const ths = headers.map(h => `<th>${renderInline(h)}</th>`).join('');
      const trs = bodyRows.map(r =>
        `<tr>${headers.map((_, idx) => `<td>${renderInline(r[idx] || '')}</td>`).join('')}</tr>`
      ).join('');
      out.push(`<div class="md-table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
      continue;
    }

    // Citação (>)
    if (/^\s*>\s?/.test(line)) {
      const qLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote><p>${qLines.map(renderInline).join('<br>')}</p></blockquote>`);
      continue;
    }

    // Listas com pilha hierárquica (aninhamento, listas mistas, <ol start>, checklists e continuação)
    const firstItem = parseListMarker(line);
    if (firstItem) {
      const stack = [];
      const flushTop = () => {
        const closed = stack.pop();
        const html = serializeListNode(closed);
        if (stack.length) {
          const parentItems = stack[stack.length - 1].items;
          if (parentItems.length) parentItems[parentItems.length - 1].children.push(html);
          else out.push(html);
        } else {
          out.push(html);
        }
      };

      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) break;

        const lm = parseListMarker(cur);
        if (lm) {
          while (stack.length > 1 && lm.indent < stack[stack.length - 1].indent) flushTop();
          if (stack.length && lm.indent === stack[stack.length - 1].indent && lm.tag !== stack[stack.length - 1].tag) {
            flushTop();
          }
          if (!stack.length || lm.indent > stack[stack.length - 1].indent) {
            stack.push({ tag: lm.tag, indent: lm.indent, start: lm.start, items: [] });
          }

          const task = lm.tag === 'ul' && lm.content.match(/^\[([ xX])\]\s+(.*)$/);
          if (task) {
            const checked = task[1].toLowerCase() === 'x';
            stack[stack.length - 1].items.push({
              isTask: true,
              html: `<span class="md-check ${checked ? 'on' : ''}">${checked ? '✓' : ''}</span><span>${renderInline(task[2])}</span>`,
              children: []
            });
          } else {
            stack[stack.length - 1].items.push({
              isTask: false,
              html: renderInline(lm.content),
              children: []
            });
          }
          i++;
          continue;
        }

        const contIndent = cur.match(/^([ \t]*)/)[1].replace(/\t/g, '  ').length;
        const top = stack[stack.length - 1];
        if (top && top.items.length && !startsNewBlock(i) && contIndent >= top.indent + 2) {
          top.items[top.items.length - 1].html += `<br>${renderInline(cur.trim())}`;
          i++;
          continue;
        }
        break;
      }

      while (stack.length) flushTop();
      continue;
    }

    // Parágrafo comum (preserva quebras simples como <br> para prompts)
    const pLines = [line];
    i++;
    while (i < lines.length && !startsNewBlock(i)) {
      pLines.push(lines[i]);
      i++;
    }
    out.push(`<p>${pLines.map(renderInline).join('<br>')}</p>`);
  }

  return out.join('');
}

/**
 * Gera realce de sintaxe Markdown + {{campos}} para o backdrop do textarea.
 * Usa grupos nomeados explícitos diretamente sobre fieldRe.source (sem mutar a regex).
 */
export function highlightMarkdownBackdrop(text = '', fieldRe = DEFAULT_FIELD_RE) {
  const src = String(text || '');
  const highlightFieldsOnly = s => {
    let html = '', last = 0;
    for (const m of s.matchAll(fieldRe)) {
      html += esc(s.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
      last = m.index + m[0].length;
    }
    return html + esc(s.slice(last));
  };

  const INLINE_RE = new RegExp(
    `(?<mdField>${fieldRe.source})|(?<mdCode>\`[^\`\\n]+\`)|(?<mdBold>\\*\\*\\S(?:[^*\\n]*?\\S)?\\*\\*)`,
    'g'
  );

  const highlightInline = line => {
    let html = '', last = 0;
    for (const m of line.matchAll(INLINE_RE)) {
      html += esc(line.slice(last, m.index));
      const g = m.groups || {};
      if (g.mdField) html += `<mark>${esc(g.mdField)}</mark>`;
      else if (g.mdCode) html += `<span class="hl-code">${highlightFieldsOnly(g.mdCode)}</span>`;
      else if (g.mdBold) html += `<span class="hl-bold">${highlightFieldsOnly(g.mdBold)}</span>`;
      last = m.index + m[0].length;
    }
    return html + esc(line.slice(last));
  };

  let inFence = false;
  const highlighted = src.split('\n').map(line => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      return `<span class="hl-code">${highlightFieldsOnly(line)}</span>`;
    }
    if (inFence) return `<span class="hl-code">${highlightFieldsOnly(line)}</span>`;
    if (/^#{1,6}\s/.test(line)) return `<span class="hl-h">${highlightFieldsOnly(line)}</span>`;
    if (/^\s*>\s?/.test(line)) return `<span class="hl-quote">${highlightInline(line)}</span>`;
    return highlightInline(line);
  });

  return highlighted.join('\n') + '\n';
}