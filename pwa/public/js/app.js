/* OS1 web app — thin client.
 *
 * NO KEY EVER LIVES IN THE BROWSER. This client only ever talks to our own
 * same-origin bridge at /api/*. The bridge (server/proxy.mjs) holds every
 * credential and forwards to whichever backend is configured.
 *
 * Endpoints this client expects from the bridge:
 *   GET  /api/health                         -> { ok, backend, configured }
 *   GET  /api/sessions                       -> { items: [ { id, title, status, updatedAt } ] }
 *   GET  /api/kanban                         -> { columns: [ { name, tickets:[...] } ] }
 *   GET  /api/files                          -> { items: [ { name, type, size } ] }
 *
 * With no backend configured the bridge returns demo data tagged
 * `demo: true`, so the whole shell is verifiable with zero secrets.
 */

const state = {
  view: 'sessions',
  online: navigator.onLine,
  configured: false,
  demo: true,
  token: localStorage.getItem('os1_token') || '',
  cache: {}
};

const el = {
  view: document.getElementById('view'),
  dot: document.getElementById('status-dot'),
  connLabel: document.getElementById('conn-label'),
  offlineBanner: document.getElementById('offline-banner')
};

async function api(path, opts = {}) {
  const headers = { 'Accept': 'application/json' };
  if (state.token) headers['X-OS1-Token'] = state.token;
  const mergedHeaders = { ...headers, ...(opts.headers || {}) };

  const res = await fetch(path, {
    ...opts,
    headers: mergedHeaders
  });
  if (res.status === 401) throw new Error('locked');
  if (!res.ok) throw new Error(`API ${path} -> ${res.status}`);
  return res.json();
}

function setStatus(kind, label) {
  el.dot.className = 'status-dot' + (kind ? ' ' + kind : '');
  el.connLabel.textContent = label;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loading(msg) {
  el.view.innerHTML = `<div class="loading"><div class="spinner"></div><div>${esc(msg)}</div></div>`;
}

function errorView(msg, hint) {
  if (msg === 'locked') {
    el.view.innerHTML = `<div class="error-box"><h3>Locked</h3><p>Open OS1 from the install link again.</p></div>`;
    return;
  }
  el.view.innerHTML = `<div class="error-box"><h3>Couldn't load</h3><p>${esc(msg)}</p>${
    hint ? `<p class="meta">${esc(hint)}</p>` : ''
  }</div>`;
}

/* ---------- Views ---------- */

async function renderSessions() {
  loading('Loading sessions…');
  try {
    const data = await api('/api/sessions');
    const items = data.items || data;
    if (!items || !items.length) {
      el.view.innerHTML = `<div class="section-title">Sessions</div><div class="empty">No active sessions.</div>`;
      return;
    }
    el.view.innerHTML =
      `<div class="section-title">Sessions${state.demo ? ' · demo' : ''}</div>` +
      items.map((s) => `
        <div class="card">
          <h3>${esc(s.title || s.id)}</h3>
          <div class="meta">${esc(s.status || 'idle')}${s.updatedAt ? ' · ' + esc(s.updatedAt) : ''}</div>
        </div>`).join('');
  } catch (e) {
    errorView(e.message, 'Check the bridge.');
  }
}

async function renderKanban() {
  loading('Loading board…');
  try {
    const data = await api('/api/kanban');
    const cols = data.columns || data;
    if (!cols || !cols.length) {
      el.view.innerHTML = `<div class="section-title">Kanban</div><div class="empty">Board is empty.</div>`;
      return;
    }
    el.view.innerHTML =
      `<div class="section-title">Kanban${state.demo ? ' · demo' : ''}</div>` +
      `<div class="kanban">` +
      cols.map((col) => `
        <div class="kanban-col">
          <h4>${esc(col.name)}<span class="count">${(col.tickets || []).length}</span></h4>
          ${(col.tickets || []).map((t) => `
            <div class="ticket">${esc(t.title || t.id)}
              ${t.meta ? `<div class="t-meta">${esc(t.meta)}</div>` : ''}
            </div>`).join('') || '<div class="t-meta">—</div>'}
        </div>`).join('') +
      `</div>`;
  } catch (e) {
    errorView(e.message, 'Check the bridge.');
  }
}

async function renderFiles() {
  loading('Loading files…');
  try {
    const data = await api('/api/files?path=/');
    const items = data.items || data;
    el.view.innerHTML =
      `<div class="section-title">Files${state.demo ? ' · demo' : ''}</div>` +
      (items && items.length
        ? items.map((f) => `
            <div class="card cream">
              <h3>${f.type === 'dir' ? '[dir] ' : '[file] '}${esc(f.name)}</h3>
              <div class="meta">${esc(f.type || 'file')}${f.size ? ' · ' + esc(f.size) : ''}</div>
            </div>`).join('')
        : `<div class="empty">No files.</div>`);
  } catch (e) {
    errorView(e.message, 'Check the bridge.');
  }
}

function renderVoice() {
  el.view.innerHTML = `
    <div class="section-title">Voice</div>
    <div class="card">
      <h3>Talk to OS1</h3>
      <div class="meta">Live microphone input is available in the native iPhone app. Here, send typed notes below.</div>
      <div class="voice-agent">
        <button class="btn cream active" data-agent="assistant">Assistant</button>
        <button class="btn cream" data-agent="note">Notes</button>
      </div>
      <textarea id="voice-text" class="voice-input" rows="4" placeholder="Type a note or command..."></textarea>
      <div class="voice-actions">
        <button class="btn" id="native-voice-btn">Open native mic</button>
        <button class="btn" id="voice-send-btn">Send</button>
      </div>
      <div class="meta" id="voice-result"></div>
    </div>
    <div class="card cream">
      <h3>Why this is safe</h3>
      <div class="meta">Agent and provider credentials never leave this Mac. The phone sends only your prompt to the private local bridge.</div>
    </div>`;

  let agent = 'assistant';
  document.querySelectorAll('[data-agent]').forEach((button) => {
    button.addEventListener('click', () => {
      agent = button.dataset.agent;
      document.querySelectorAll('[data-agent]').forEach((b) => b.classList.toggle('active', b === button));
    });
  });

  document.getElementById('native-voice-btn')?.addEventListener('click', () => {
    if (window.webkit?.messageHandlers?.os1Native) {
      window.webkit.messageHandlers.os1Native.postMessage({ type: 'openVoice', agent });
    } else {
      document.getElementById('voice-result').textContent = 'Open this screen in the native OS1 iPhone app to use the mic.';
    }
  });

  document.getElementById('voice-send-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('voice-text');
    const result = document.getElementById('voice-result');
    const text = input.value.trim();
    if (!text) return;
    result.textContent = `Sending to ${agent}...`;
    try {
      const reply = await api('/api/agents/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ agent, source: 'typed-web', text })
      });
      result.textContent = reply.reply || 'Sent.';
      input.value = '';
    } catch (e) {
      result.textContent = e.message;
    }
  });
}

const views = {
  sessions: renderSessions,
  kanban: renderKanban,
  files: renderFiles,
  voice: renderVoice
};

function switchView(name) {
  state.view = name;
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.view === name));
  (views[name] || renderSessions)();
}

/* ---------- Boot ---------- */

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token) {
    state.token = token;
    localStorage.setItem('os1_token', token);
    document.cookie = `os1_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=31536000`;
    const cleanURL = `${window.location.origin}${window.location.pathname}`;
    window.history.replaceState({}, document.title, cleanURL);
  } else if (state.token) {
    document.cookie = `os1_token=${encodeURIComponent(state.token)}; Path=/; SameSite=Lax; Max-Age=31536000`;
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  window.addEventListener('online', () => { state.online = true; el.offlineBanner.classList.add('hidden'); checkHealth(); });
  window.addEventListener('offline', () => { state.online = false; el.offlineBanner.classList.remove('hidden'); setStatus('error', 'offline'); });

  await checkHealth();
  switchView('sessions');
}

async function checkHealth() {
  try {
    const h = await api('/api/health');
    state.configured = !!h.configured;
    state.demo = !!h.demo;
    if (h.demo) {
      setStatus('online', 'demo');
    } else if (h.backend === 'local') {
      setStatus('online', `local · ${h.activeTasks || 0} tasks`);
    } else if (h.configured && h.ok) {
      setStatus('online', h.computerId ? esc(h.computerId).slice(0, 10) : 'connected');
    } else {
      setStatus('error', 'no backend');
    }
  } catch (e) {
    setStatus('error', e.message === 'locked' ? 'locked' : 'offline');
  }
}

boot();
