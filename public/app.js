const $ = (id) => document.getElementById(id);
const LABELS = {
  queued: 'In coda',
  downloading: 'Download',
  done: 'Completato',
  error: 'Errore',
  canceled: 'Annullato',
};

let state = { running: false, queue: [], downloadDir: '' };
const rows = new Map(); // id -> <li>

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => ({}));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Pulsante con icona + testo visibile; `hint` è la descrizione estesa (tooltip).
function setIcon(btn, name, text, hint = text) {
  btn.innerHTML = `${icon(name)}<span>${text}</span>`;
  btn.title = hint;
}

function button(name, text, onClick, hint) {
  const b = el('button', 'icon');
  setIcon(b, name, text, hint);
  b.onclick = onClick;
  return b;
}

document
  .querySelectorAll('button[data-icon]')
  .forEach((b) => setIcon(b, b.dataset.icon, b.dataset.text, b.dataset.label));

function statText(it) {
  if (it.status === 'downloading') {
    return [`${(it.percent || 0).toFixed(1)}%`, it.speed, it.eta && `ETA ${it.eta}`].filter(Boolean).join(' · ');
  }
  return LABELS[it.status] || it.status;
}

function buildRow() {
  const li = el('li', 'item enter');
  li.addEventListener('animationend', () => li.classList.remove('enter'), { once: true });
  const thumb = el('div', 'thumb');
  const main = el('div', 'main');
  const title = el('div', 'title');
  const sub = el('div', 'sub');
  const duration = el('span', 'duration');
  const dir = el('span', 'dir');
  dir.tabIndex = 0;
  const err = el('span', 'err');
  sub.append(duration, dir, err);
  main.append(title, sub);
  li.append(thumb, main, el('div', 'stat'), el('div', 'acts'));
  li._ = { thumb, title, duration, dir, err, stat: li.querySelector('.stat'), acts: li.querySelector('.acts') };
  return li;
}

function updateRow(li, it) {
  const r = li._;
  r.title.textContent = it.title;
  r.title.title = it.url;
  r.duration.textContent = it.duration || '';
  if (it.thumb) {
    let img = r.thumb.firstChild;
    if (!img) {
      img = new Image();
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.remove();
      r.thumb.append(img);
    }
    if (img.getAttribute('src') !== it.thumb) img.src = it.thumb;
  }
  r.dir.textContent = it.dir || '';
  r.dir.title = 'Apri cartella';
  r.dir.onclick = () => api('POST', '/api/open-folder', { dir: it.dir });
  r.dir.onkeydown = (e) => {
    if (e.key === 'Enter') r.dir.click();
  };
  r.err.textContent = it.status === 'error' ? it.error : '';
  r.stat.textContent = statText(it);
  li.style.setProperty('--p', `${it.status === 'downloading' ? it.percent || 0 : 0}%`);

  if (li.dataset.status !== it.status) {
    li.dataset.status = it.status;
    li.className = li.className.replace(/\bst-\w+/g, '').trim() + ` st-${it.status}`;
    const acts = [];
    if (it.status === 'downloading' || it.status === 'queued') {
      acts.push(button('x', 'Annulla', () => api('POST', `/api/cancel/${it.id}`)));
    }
    if (['error', 'canceled', 'done'].includes(it.status)) {
      acts.push(button('rotate-cw', 'Riprova', () => api('POST', `/api/retry/${it.id}`)));
    }
    if (it.status !== 'downloading') {
      acts.push(button('trash-2', 'Rimuovi', () => api('DELETE', `/api/item/${it.id}`), 'Rimuovi dalla lista'));
    }
    r.acts.replaceChildren(...acts);
  }
}

function render() {
  const { queue, running } = state;
  if (document.activeElement !== $('dir')) $('dir').value = state.downloadDir;

  if ($('toggle').dataset.running !== String(running)) {
    $('toggle').dataset.running = String(running);
    setIcon(
      $('toggle'),
      running ? 'pause' : 'play',
      running ? 'Pausa' : 'Avvia coda',
      running ? 'Finisce il download in corso, poi si ferma' : 'Avvia coda'
    );
    $('toggle').classList.toggle('primary', !running);
  }

  const count = (s) => queue.filter((i) => i.status === s).length;
  $('counts').textContent = queue.length
    ? [
        `${count('queued')} in coda`,
        count('downloading') && `${count('downloading')} in corso`,
        `${count('done')} completati`,
        count('error') && `${count('error')} errori`,
      ].filter(Boolean).join(' · ')
    : '';
  $('empty').hidden = queue.length > 0;

  const list = $('list');
  const ids = new Set(queue.map((i) => i.id));
  for (const [id, li] of rows) {
    if (!ids.has(id)) {
      li.remove();
      rows.delete(id);
    }
  }
  queue.forEach((it, idx) => {
    let li = rows.get(it.id);
    if (!li) {
      li = buildRow();
      rows.set(it.id, li);
    }
    updateRow(li, it);
    if (list.children[idx] !== li) list.insertBefore(li, list.children[idx] || null);
  });
}

function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    state = JSON.parse(e.data);
    render();
  };
}

function flash(id, text, ms = 4000) {
  $(id).textContent = text;
  if (ms) setTimeout(() => $(id).textContent === text && ($(id).textContent = ''), ms);
}

$('add').onclick = async () => {
  const urls = $('urls').value.split(/\s+/).filter(Boolean);
  if (!urls.length) return;
  const r = await api('POST', '/api/add', { urls });
  $('urls').value = '';
  const skipped = (r.skipped || []).length;
  flash('msg', `Aggiunti ${r.added || 0}` + (skipped ? `, scartati ${skipped}` : ''));
};

// Attenzione: un gestore onkeydown che restituisce `false` blocca la scrittura e le scorciatoie (Ctrl+V...).
// Per questo si usa `if`, mai `&&` come valore di ritorno.
$('urls').onkeydown = (e) => {
  if (e.key === 'Enter') $('add').click();
};

$('toggle').onclick = () => api('POST', state.running ? '/api/pause' : '/api/start');
$('folder').onclick = () => api('POST', '/api/open-folder', {});
$('clear').onclick = () => api('POST', '/api/clear-finished');

async function saveDir() {
  const value = $('dir').value.trim();
  if (!value || value === state.downloadDir) return;
  const r = await api('POST', '/api/settings', { downloadDir: value });
  if (r.error) {
    flash('dirmsg', r.error, 6000);
    $('dir').value = state.downloadDir;
  } else {
    flash('dirmsg', 'Cartella salvata');
  }
}
$('dir').onchange = saveDir;
$('dir').onkeydown = (e) => {
  if (e.key === 'Enter') $('dir').blur();
};

$('browse').onclick = async () => {
  $('browse').disabled = true;
  flash('dirmsg', 'Scegli la cartella nella finestra di Windows…', 0);
  const r = await api('POST', '/api/pick-folder');
  $('browse').disabled = false;
  flash('dirmsg', r.canceled ? 'Nessuna modifica' : 'Cartella salvata');
};

connect();
