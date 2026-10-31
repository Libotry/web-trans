(() => {
  if (globalThis.__bilingualReaderV1) return;
  globalThis.__bilingualReaderV1 = true;
  const HOST = 'data-bilingual-reader';
  const exclude = `script,style,noscript,pre,textarea,input,select,button,svg,math,canvas,nav,header,footer,aside,[role="navigation"],[role="button"],[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[hidden],[aria-hidden="true"],[${HOST}]`;
  const semantic = 'p,h1,h2,h3,h4,h5,h6,li,td,th,dt,dd,blockquote,figcaption';
  let active = false, paused = false, hidden = false, beforeHide = false, token = '', generation = 0, scope = 'article', style = {};
  let records = new Map(), sequence = 0, mutation = null, intersection = null, timer = null, routeTimer = null;
  const routeKey = () => location.origin + location.pathname + location.search + (/^#(?:\/|!)/.test(location.hash) ? location.hash : '');
  let inFlight = 0, requests = 0, hits = 0, tokens = 0, hasUsage = false, message = '', limited = false, url = routeKey();
  let scanning = false, dirty = new Set(), index = new WeakMap();
  const send = m => chrome.runtime.sendMessage(m).then(r => { if (!r?.ok) throw new Error(r?.error || '后台未返回结果，结果未知，请手动重试。'); return r; });
  function source(r) { return r.nodes.map(n => n.isConnected ? n.textContent : '').join('').replace(/\s+/g, ' ').trim(); }
  function eligible(text) { const en = (text.match(/[a-z]/gi) || []).length; return en >= 3 && en > (text.match(/[\u3400-\u9fff]/g) || []).length * 2 && !/^https?:\/\/\S+$/.test(text); }
  function pieces(text) {
    const out = []; while (text.length > 1800) { const head = text.slice(0, 1800); let i = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! ')); if (i < 900) i = head.lastIndexOf(' '); if (i < 1) i = 1799; out.push(text.slice(0, i + 1)); text = text.slice(i + 1); } if (text) out.push(text); return out;
  }
  function remove(r) { if (r.host) { intersection?.unobserve(r.el); r.host.remove(); } r.host = null; }
  function host(r, text, error = false) {
    if (!r.anchor.isConnected || !r.el.isConnected) return;
    if (!r.host) {
      const el = document.createElement('span'); el.setAttribute(HOST, ''); el.setAttribute('translate', 'no'); el.lang = 'zh-Hans';
      el.style.setProperty('display', hidden ? 'none' : 'block', 'important');
      const root = el.attachShadow({ mode: 'open' }); const css = document.createElement('style');
      css.textContent = `:host{clear:both;white-space:normal!important}span{display:block;white-space:pre-wrap;overflow-wrap:anywhere;text-align:start;font-family:system-ui,"Microsoft YaHei",sans-serif;font-weight:400;line-height:1.65;font-size:${style.fontSize || 95}%;margin-top:${style.gap ?? 8}px;color:${style.color || 'inherit'};${style.tint ? 'background:light-dark(#eff6ff,#1e293b);padding:8px 10px;border-radius:6px;' : ''}}button{font:inherit;color:inherit;cursor:pointer;background:transparent;border:1px solid currentColor;border-radius:4px;margin-inline-start:8px}small{opacity:.7}`;
      const span = document.createElement('span'); root.append(css, span); r.host = el; r.output = span;
      r.el.insertBefore(el, r.anchor.nextSibling);
    }
    r.output.textContent = text;
    if (error) { const btn = document.createElement('button'); btn.textContent = '重试'; btn.type = 'button'; btn.addEventListener('click', () => { if (r.state !== 'error') return; r.state = 'pending'; r.error = ''; paused = false; message = ''; pump(); }); r.output.append(btn); }
  }
  function isOwn(node) { const el = node.nodeType === 1 ? node : node.parentElement; return !!el?.closest(`[${HOST}]`); }
  function root() { return scope === 'page' ? document.body : document.querySelector('article,main,[role="main"]') || document.body; }
  function schedule(node) {
    if (!active || !node) return;
    dirty.add(node.nodeType === 1 ? node : node.parentElement);
    clearTimeout(timer); timer = setTimeout(scan, 300);
  }
  async function scan() {
    if (!active || scanning) return;
    scanning = true; const epoch = generation;
    try {
      const roots = [...dirty]; dirty.clear(); const main = root();
      const targets = roots.filter((r, i) => r?.isConnected && (r === main || main.contains(r)) && !roots.some((other, j) => i !== j && other?.contains(r) && other !== r));
      for (const area of targets) {
        if (area.closest(exclude)) continue;
        const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
        const groups = []; let current = null, n, count = 0; const owners = new WeakMap();
        while ((n = walker.nextNode())) {
          if (epoch !== generation || !active) return;
          if (++count % 400 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          const parent = n.parentElement;
          if (!n.textContent.trim() || !parent || parent.closest(exclude)) continue;
          let owner = owners.get(parent);
          if (!owner) {
            owner = parent.closest(semantic);
            // Stop at the nearest block, so nested div layouts remain distinct paragraphs.
            for (let p = parent; p && p !== owner; p = p.parentElement) {
              if (/^(block|flow-root|list-item|table-cell)$/.test(getComputedStyle(p).display)) { owner = p; break; }
            }
            owner ||= parent;
            owners.set(parent, owner);
          }
          if (!owner.getClientRects().length || getComputedStyle(owner).visibility !== 'visible') continue;
          if (!current || current.el !== owner) { current = { el: owner, nodes: [] }; groups.push(current); }
          current.nodes.push(n);
        }
        for (const group of groups) {
          const text = source(group); if (!eligible(text)) continue;
          const first = group.nodes[0]; let r = index.get(first);
          if (r && r.text === text && r.el === group.el) continue;
          if (r) { remove(r); records.delete(r.id); }
          let anchor = group.nodes.at(-1); while (anchor.parentNode !== group.el && anchor.parentNode) anchor = anchor.parentNode;
          if (anchor.parentNode !== group.el) continue;
          r = { ...group, anchor, text, id: `b${++sequence}`, state: 'pending', host: null, near: false };
          records.set(r.id, r); index.set(first, r); intersection.observe(r.el);
        }
      }
      for (const [id, r] of records) {
        if (!r.el.isConnected || !r.nodes.every(n => n.isConnected) || source(r) !== r.text) { remove(r); records.delete(id); }
      }
    } catch (e) { message = '扫描部分页面失败：' + e.message; }
    finally { scanning = false; if (active && dirty.size) schedule(root()); pump(); }
  }
  function near(r) { const b = r.el.getBoundingClientRect(); return b.height > 0 && b.bottom >= -100 && b.top <= innerHeight * 2; }
  function pump() {
    if (!active || paused || hidden || limited) return;
    while (inFlight < 2) {
      const candidates = [...records.values()].filter(r => r.state === 'pending' && r.el.isConnected && near(r)).sort((a, b) => Math.abs(a.el.getBoundingClientRect().top) - Math.abs(b.el.getBoundingClientRect().top));
      if (!candidates.length) break;
      const chosen = []; let size = 0;
      for (const r of candidates) { if (chosen.length >= 4) break; if (chosen.length && size + r.text.length > 5000) continue; chosen.push(r); size += r.text.length; if (r.text.length > 1800) break; }
      inFlight++; const epoch = generation;
      for (const r of chosen) { r.state = 'loading'; host(r, '正在翻译…'); }
      run(chosen, epoch).finally(() => { if (epoch === generation) { inFlight--; pump(); } });
    }
  }
  async function run(chosen, epoch) {
    try {
      const segments = chosen.flatMap(r => pieces(r.text).map((text, i) => ({ id: `${r.id}:${i}`, text })));
      const translated = new Map();
      for (let i = 0; i < segments.length;) {
        if (!active || epoch !== generation) return;
        if (paused || hidden) { for (const r of chosen) { r.state = 'pending'; remove(r); } return; }
        const batch = []; let size = 0;
        while (i < segments.length && batch.length < 4 && size + segments[i].text.length <= 6000) { size += segments[i].text.length; batch.push(segments[i++]); }
        const response = await send({ type: 'TRANSLATE', token, segments: batch });
        if (epoch !== generation || !active) return;
        if (response.limit) { limited = true; message = response.error; for (const r of chosen) { r.state = 'pending'; remove(r); } return; }
        if (response.cached) hits += batch.length; else requests++;
        if (response.tokens !== null) { hasUsage = true; tokens += response.tokens; }
        for (const t of response.translations) translated.set(t.id, t.text);
      }
      for (const r of chosen) {
        if (epoch !== generation || !active || records.get(r.id) !== r || source(r) !== r.text) continue;
        const texts = pieces(r.text).map((_, i) => translated.get(`${r.id}:${i}`));
        if (texts.some(t => !t)) { r.state = 'error'; r.error = '返回缺少此段译文或编号重复。'; host(r, r.error, true); }
        else { r.state = 'done'; host(r, texts.join('')); }
      }
    } catch (e) {
      if (epoch !== generation || !active) return;
      message = e.message;
      for (const r of chosen) if (records.get(r.id) === r && source(r) === r.text) { r.state = 'error'; r.error = e.message; host(r, e.message, true); }
    }
  }
  function stop() {
    active = false; generation++; inFlight = 0; message = ''; clearTimeout(timer); clearInterval(routeTimer); mutation?.disconnect(); intersection?.disconnect();
    for (const r of records.values()) r.host?.remove(); records.clear(); dirty.clear(); index = new WeakMap();
  }
  function start(m) {
    stop(); token = m.token; scope = m.scope; style = m.style || {}; active = true; paused = hidden = limited = false;
    requests = hits = tokens = 0; hasUsage = false; message = ''; url = routeKey();
    intersection = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) pump(); }, { rootMargin: '100% 0px' });
    mutation = new MutationObserver(changes => {
      for (const c of changes) {
        if (isOwn(c.target)) continue;
        if (c.type === 'childList' && [...c.addedNodes, ...c.removedNodes].length && [...c.addedNodes, ...c.removedNodes].every(n => n.nodeType === 1 && n.hasAttribute(HOST))) continue;
        schedule(c.target);
      }
    });
    mutation.observe(document.body, { childList: true, subtree: true, characterData: true });
    routeTimer = setInterval(async () => {
      if (routeKey() === url || !active) return;
      const epoch = generation; const old = { token, scope, style }; url = routeKey(); paused = true;
      try { const r = await send({ type: 'RESET', token }); if (generation === epoch && active) start({ ...old, token: r.token }); }
      catch (e) { message = e.message; }
    }, 1000);
    schedule(root());
  }
  function status() {
    const values = [...records.values()]; return { active, paused, hidden, limited, requests, hits, tokens: hasUsage ? tokens : null, message,
      done: values.filter(r => r.state === 'done').length, failed: values.filter(r => r.state === 'error').length,
      pending: values.filter(r => ['pending', 'loading'].includes(r.state)).length };
  }
  chrome.runtime.onMessage.addListener((m, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    (async () => {
      if (m.type === 'START') start(m);
      else if (m.type === 'STATUS') return status();
      else if (m.type === 'CONTROL') {
        if (!active) return status();
        if (m.action === 'restore') { const old = token; stop(); send({ type: 'CANCEL', token: old }).catch(() => {}); }
        if (m.action === 'pause') { paused = !paused; pump(); }
        if (m.action === 'hide') {
          hidden = !hidden; if (hidden) { beforeHide = paused; paused = true; } else paused = beforeHide;
          for (const r of records.values()) if (r.host) r.host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
          pump();
        }
        if (m.action === 'retry') { message = ''; paused = false; for (const r of records.values()) if (r.state === 'error') { r.state = 'pending'; remove(r); } pump(); }
        if (m.action === 'extend') { await send({ type: 'EXTEND', token }); limited = false; paused = false; message = ''; pump(); }
      }
      return status();
    })().then(r => respond({ ok: true, ...r })).catch(e => respond({ ok: false, error: e.message }));
    return true;
  });
})();
