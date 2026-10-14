/* OS1 bridge — static host for the PWA shell + the only process that holds keys.
 *
 * Zero dependencies (Node 18+ built-ins only): http, fs, path.
 *
 * Three jobs:
 *  1. Serve the installable PWA shell from ../public.
 *  2. Be the ONLY thing that holds provider keys (OpenAI, Orgo). Phones and
 *     browsers never see them; they only call this server's same-origin /api/*.
 *  3. Shell out to a local agent CLI (configurable) so the phone can reach your
 *     agent stack without ever running code itself.
 *
 * Three backends, chosen by OS1_BACKEND (or inferred):
 *   demo   no credentials needed; every /api route returns sample data
 *          ({demo:true}) so the whole shell is clickable with zero secrets.
 *   local  reads the local agent CLI's SQLite state under AGENT_HOME and shells
 *          out to AGENT_CLI_BIN.
 *   orgo   forwards to a remote Orgo cloud computer over HTTPS + Bearer auth.
 *
 * Configuration is entirely environment-driven — see .env.example at the repo
 * root for every variable and its default. Never hard-code a secret here.
 */

import http from 'node:http';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';

const ORGO_API_KEY = process.env.ORGO_API_KEY || '';
const ORGO_COMPUTER_ID = process.env.ORGO_COMPUTER_ID || '';
const ORGO_BASE = process.env.ORGO_BASE || 'https://www.orgo.ai/api';
const ACCESS_TOKEN = process.env.OS1_ACCESS_TOKEN || '';
const BACKEND = process.env.OS1_BACKEND || (ORGO_API_KEY && ORGO_COMPUTER_ID ? 'orgo' : 'demo');
const DEMO = BACKEND === 'demo';
// Local agent-CLI backend. Everything here is a path/name you own — nothing is
// hard-coded to one machine. AGENT_CLI_BIN is resolved from PATH unless you
// give it an absolute path.
const AGENT_HOME = process.env.AGENT_HOME || join(process.env.HOME || '', '.agent');
const AGENT_CLI_BIN = process.env.AGENT_CLI_BIN || 'agent';
const AGENT_WORKSPACE_DIR = process.env.AGENT_WORKSPACE_DIR || process.cwd();
// Which CLI profile answers each app mode. Empty string = the CLI's default profile.
const AGENT_PROFILE_ASSISTANT = process.env.AGENT_PROFILE_ASSISTANT || 'assistant';
const AGENT_PROFILE_NOTE = process.env.AGENT_PROFILE_NOTE || 'note';
const AGENT_PROFILE_ROUTER = process.env.AGENT_PROFILE_ROUTER || 'router';
// CLI argument shape: `<bin> <profileFlag> <profile> <promptFlag> <prompt>`.
const AGENT_CLI_PROFILE_FLAG = process.env.AGENT_CLI_PROFILE_FLAG || '-p';
const AGENT_CLI_PROMPT_FLAG = process.env.AGENT_CLI_PROMPT_FLAG || '-z';
// Subcommand used to create a task/card, comma separated (e.g. "kanban,create").
const AGENT_TASK_SUBCOMMAND = (process.env.AGENT_TASK_SUBCOMMAND || 'kanban,create')
  .split(',')
  .map((part) => part.trim())
  .filter(Boolean);
const AGENT_TASK_ASSIGNEE = process.env.AGENT_TASK_ASSIGNEE || 'default';
// Colon-separated allow-list of folders the search tool may read.
const AGENT_CONTEXT_PATHS = (process.env.AGENT_CONTEXT_PATHS || '.')
  .split(':')
  .map((part) => part.trim())
  .filter(Boolean);
// Where voice-note captures, transcripts and receipts are written.
const CAPTURE_ROOT = process.env.OS1_CAPTURE_ROOT || join(AGENT_WORKSPACE_DIR, 'os1-captures');
// Extra env passed to the agent CLI, as JSON (e.g. {"MY_CLI_FLAG":"1"}).
const AGENT_CLI_ENV = (() => {
  try {
    const parsed = JSON.parse(process.env.AGENT_CLI_ENV || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
})();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2';
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'marin';
const rawRealtimeVadThreshold = Number(process.env.OPENAI_REALTIME_VAD_THRESHOLD);
const OPENAI_REALTIME_VAD_THRESHOLD = Number.isFinite(rawRealtimeVadThreshold)
  ? Math.min(1, Math.max(0, rawRealtimeVadThreshold))
  : 0.15;
const rawRealtimeNoiseReduction = String(process.env.OPENAI_REALTIME_NOISE_REDUCTION || '').toLowerCase();
const OPENAI_REALTIME_NOISE_REDUCTION = ['near_field', 'far_field'].includes(rawRealtimeNoiseReduction)
  ? rawRealtimeNoiseReduction
  : 'far_field';
const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';
const NOTE_CAPTURE_MAX_JSON_BYTES = Number(process.env.OS1_NOTE_CAPTURE_MAX_JSON_BYTES) || 42 * 1024 * 1024;
const OPENAI_TRANSCRIPTION_MAX_AUDIO_BYTES = Number(process.env.OPENAI_TRANSCRIPTION_MAX_AUDIO_BYTES) || 24 * 1024 * 1024;
const RG_BIN = process.env.RG_BIN || 'rg';
const ORGO_CLI = process.env.ORGO_CLI || 'orgo';
const COCKPIT_URL = process.env.OS1_DASHBOARD_URL || 'http://127.0.0.1:4700';
const execFileAsync = promisify(execFile);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function unauthorized(res) {
  return json(res, 401, { error: 'locked' });
}

function requireApiAuth(req, res) {
  if (!ACCESS_TOKEN) return true;

  const headerToken = req.headers['x-os1-token'];
  const cookieToken = (req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('os1_token='))
    ?.slice('os1_token='.length);

  if (headerToken === ACCESS_TOKEN || cookieToken === ACCESS_TOKEN) {
    return true;
  }

  unauthorized(res);
  return false;
}

function fmtRelative(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - n));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function scrubText(value, max = 140) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function clampText(value, max = 20000) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated at ${max} chars]`;
}

function stripVerifierNoise(value) {
  const text = String(value ?? '').trim();
  const markerIndex = text.indexOf('File-mutation verifier:');
  if (markerIndex < 0) return text;
  const lineStart = text.lastIndexOf('\n', markerIndex);
  return text.slice(0, lineStart >= 0 ? lineStart : markerIndex).trim() || text;
}

function markdownSafe(value) {
  return String(value ?? '').replace(/```/g, "` ` `");
}

function readBody(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > maxBytes) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req, maxBytes = 32 * 1024) {
  const raw = await readBody(req, maxBytes);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function sqliteJSON(dbPath, sql) {
  const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], {
    maxBuffer: 4 * 1024 * 1024
  });
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

/* ---------- Demo data (no secrets, proves the shell) ---------- */

const demoSessions = {
  demo: true,
  items: [
    { id: 'sess-assistant', title: 'Assistant · chief of staff', status: 'running', updatedAt: '2m ago' },
    { id: 'sess-research', title: 'Research · web sweep', status: 'idle', updatedAt: '14m ago' },
    { id: 'sess-build', title: 'Build · compile and test', status: 'queued', updatedAt: '1h ago' }
  ]
};

const demoKanban = {
  demo: true,
  columns: [
    { name: 'Backlog', tickets: [{ id: 'k1', title: 'OS1 iOS thin client', meta: 'native · path 2' }] },
    { name: 'In progress', tickets: [{ id: 'k2', title: 'OS1 PWA shell', meta: 'this app' }, { id: 'k3', title: 'Orgo proxy', meta: 'server-side key' }] },
    { name: 'Done', tickets: [{ id: 'k4', title: 'Feasibility doc', meta: 'design' }] }
  ]
};

const demoFiles = {
  demo: true,
  items: [
    { name: 'workspace', type: 'dir' },
    { name: 'README.md', type: 'file', size: '8 KB' },
    { name: 'agent.log', type: 'file', size: '142 KB' }
  ]
};

/* ---------- Live Orgo forwarding ----------
 * The OS1 transport runs ops as a bash/exec POST against the computer and
 * parses JSON out. For the read-only PWA surfaces we keep the proxy thin:
 * a single helper that calls the Orgo computer endpoint. The exact response
 * shaping per surface (sessions/kanban/files) is implemented as the live
 * integration is wired to a real computer; until then DEMO short-circuits. */

async function orgoGet(pathSuffix) {
  const url = `${ORGO_BASE}/computers/${ORGO_COMPUTER_ID}/${pathSuffix}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${ORGO_API_KEY}` }
  });
  if (!res.ok) throw new Error(`Orgo ${res.status}`);
  return res.json();
}

async function orgoExec(code, timeout = 30) {
  const url = `${ORGO_BASE}/computers/${ORGO_COMPUTER_ID}/exec`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ORGO_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ code, timeout })
  });
  if (!res.ok) throw new Error(`Orgo ${res.status}`);
  const payload = await res.json();
  if (!payload.success) throw new Error(payload.output || payload.error || 'Orgo exec failed');
  return JSON.parse(payload.output);
}

async function localHealth() {
  const sessions = await sqliteJSON(
    join(AGENT_HOME, 'state.db'),
    'select count(*) as count from sessions where coalesce(archived,0)=0;'
  ).catch(() => [{ count: 0 }]);
  const tasks = await sqliteJSON(
    join(AGENT_HOME, 'kanban.db'),
    "select count(*) as count from tasks where status != 'archived';"
  ).catch(() => [{ count: 0 }]);

  return {
    ok: true,
    demo: false,
    configured: true,
    backend: 'local',
    agentHome: AGENT_HOME,
    sessions: sessions[0]?.count ?? 0,
    activeTasks: tasks[0]?.count ?? 0
  };
}

async function localSessions() {
  const rows = await sqliteJSON(
    join(AGENT_HOME, 'state.db'),
    `
      select
        s.id,
        s.title,
        s.model,
        s.message_count as messageCount,
        s.started_at as startedAt,
        coalesce((select max(m.timestamp) from messages m where m.session_id = s.id), s.ended_at, s.started_at) as lastActive,
        (
          select m.content
          from messages m
          where m.session_id = s.id
            and m.active = 1
            and m.content is not null
            and length(trim(m.content)) > 0
          order by m.timestamp desc
          limit 1
        ) as preview
      from sessions s
      where coalesce(s.archived, 0) = 0
      order by lastActive desc
      limit 24;
    `
  );

  return {
    demo: false,
    items: rows.map((row) => ({
      id: row.id,
      title: scrubText(row.title || row.preview || row.id, 84),
      model: row.model,
      status: row.ended_at ? 'closed' : 'active',
      updatedAt: fmtRelative(row.lastActive),
      messageCount: row.messageCount,
      preview: scrubText(row.preview)
    }))
  };
}

async function localKanban() {
  const rows = await sqliteJSON(
    join(AGENT_HOME, 'kanban.db'),
    `
      select
        id, title, status, assignee, priority,
        coalesce(last_heartbeat_at, started_at, completed_at, created_at) as activityAt
      from tasks
      where status != 'archived'
      order by activityAt desc
      limit 160;
    `
  );

  const statusOrder = ['running', 'blocked', 'scheduled', 'todo', 'done'];
  const labels = {
    running: 'Running',
    blocked: 'Blocked',
    scheduled: 'Scheduled',
    todo: 'Todo',
    done: 'Done'
  };
  const grouped = new Map(statusOrder.map((status) => [status, []]));
  for (const row of rows) {
    if (!grouped.has(row.status)) grouped.set(row.status, []);
    grouped.get(row.status).push({
      id: row.id,
      title: scrubText(row.title || row.id, 120),
      meta: [row.assignee, row.priority ? `p${row.priority}` : null, fmtRelative(row.activityAt)]
        .filter(Boolean)
        .join(' · ')
    });
  }

  return {
    demo: false,
    columns: [...grouped.entries()]
      .filter(([, tickets]) => tickets.length > 0)
      .map(([status, tickets]) => ({
        name: labels[status] || status,
        tickets: tickets.slice(0, 24)
      }))
  };
}

function safeFileItem(name) {
  const lower = name.toLowerCase();
  if (name.startsWith('.env')) return false;
  if (lower.includes('secret') || lower.includes('token') || lower.includes('auth') || lower.includes('credential')) return false;
  if (lower.endsWith('.key') || lower.endsWith('.pem')) return false;
  return true;
}

async function localFiles() {
  const entries = await readdir(AGENT_HOME, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!safeFileItem(entry.name)) continue;
    const fullPath = join(AGENT_HOME, entry.name);
    const st = await stat(fullPath).catch(() => null);
    items.push({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      size: st && !entry.isDirectory() ? `${Math.round(st.size / 1024)} KB` : null
    });
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { demo: false, items: items.slice(0, 80) };
}

/* ---------- Voice tools ----------
 * Voice is the realtime voice front door. It gets bounded tools through this
 * bridge; provider keys, Agent, Orgo credentials, and the filesystem stay on
 * the Mac. */

function parseMaybeJSON(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function repoRelative(absPath) {
  const prefix = `${AGENT_WORKSPACE_DIR}/`;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

function summarizeKanban(board, limit = 24) {
  const columns = (board.columns || []).map((column) => ({
    name: column.name,
    tickets: (column.tickets || []).slice(0, limit).map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      meta: ticket.meta || ''
    }))
  }));
  const total = columns.reduce((sum, column) => sum + column.tickets.length, 0);
  const summary = columns
    .map((column) => `${column.name}: ${column.tickets.length}`)
    .join(' · ');
  return { total, summary, columns };
}

function voiceToolDefinitions() {
  return [
    {
      type: 'function',
      name: 'get_active_kanban',
      description: 'Read the current agent Kanban snapshot. Use for status, priorities, blockers, and active work. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max cards per column to return.', minimum: 1, maximum: 40 }
        },
        additionalProperties: false
      }
    },
    {
      type: 'function',
      name: 'search_workspace_context',
      description: 'Full-text search the workspace folders listed in AGENT_CONTEXT_PATHS. Use before answering from memory. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Exact words or phrase to search for.' },
          limit: { type: 'integer', description: 'Max matching lines to return.', minimum: 1, maximum: 20 }
        },
        required: ['query'],
        additionalProperties: false
      }
    },
    {
      type: 'function',
      name: 'ask_assistant',
      description: 'Ask the assistant profile of the local agent CLI for deeper judgment or context. Read-only unless the assistant explicitly says to route work.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Concise question for the assistant.' },
          context: { type: 'string', description: 'Relevant voice-session context.' }
        },
        required: ['question'],
        additionalProperties: false
      }
    },
    {
      type: 'function',
      name: 'dispatch_task',
      description: 'Create a task/card for the router profile to pick up. Does not send messages, mutate credentials, spend money, post publicly, or change remote machines.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short task title.' },
          summary: { type: 'string', description: 'Markdown-ready work packet describing what the operator wants.' },
          risk_class: { type: 'string', description: 'Usually internal_reversible. Use gated_high_risk if money, credentials, outbound sends, public posts, or remote-machine mutation are involved.' },
          gate: { type: 'string', description: 'Any explicit approval gate or reason this must pause before action.' },
          dry_run: { type: 'boolean', description: 'Only true for bridge/tool smoke tests.' }
        },
        required: ['title', 'summary'],
        additionalProperties: false
      }
    },
    {
      type: 'function',
      name: 'orgo_status',
      description: 'Check local Orgo CLI sign-in and cloud-computer inventory from the Mac. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          include_computers: { type: 'boolean', description: 'Whether to include computer list if signed in.' }
        },
        additionalProperties: false
      }
    },
    {
      type: 'function',
      name: 'dashboard_status',
      description: 'Check whether the optional local dashboard is reachable from the Mac bridge. Read-only.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    }
  ];
}

function voiceInstructions() {
  return [
    'Voice mode.',
    'You are the realtime voice operator for the OS1 phone app, speaking to the person who owns this machine.',
    'Speak naturally and briefly. Talk like an operator, not a chatbot.',
    'Use tools whenever the operator asks about current workspace state, tasks, the dashboard, remote machines, or work routing.',
    'Read-only tools can run immediately. Internal, reversible work can be dispatched as a task.',
    'Never claim you completed high-risk work. High-risk means money, credentials, outbound sends to other people, public posting, or remote machine/runtime mutation.',
    'For high-risk requests, state the gate plainly and only dispatch a gated task if the operator asked you to prepare it.',
    'When a tool fails, say what failed and the one next thing needed. Do not fake progress.',
    'If the user asks for retained notes or a long recording, switch to note capture rather than holding raw detail in realtime context.',
    'Mode split: voice handles speech and tool routing, assistant handles judgment and context, the router executes queued tasks, notes capture long-form recordings.'
  ].join('\n');
}

async function runAgentProfile(profile, prompt, timeout = 180000) {
  const args = profile
    ? [AGENT_CLI_PROFILE_FLAG, profile, AGENT_CLI_PROMPT_FLAG, prompt]
    : [AGENT_CLI_PROMPT_FLAG, prompt];
  const { stdout, stderr } = await execFileAsync(AGENT_CLI_BIN, args, {
    cwd: AGENT_WORKSPACE_DIR,
    timeout,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      ...AGENT_CLI_ENV
    }
  });
  return stripVerifierNoise(scrubText(stdout || stderr || '', 12000));
}

async function runOrgoReadOnly(args, timeout = 20000) {
  try {
    const { stdout, stderr } = await execFileAsync(ORGO_CLI, ['--json', '--quiet', ...args], {
      cwd: AGENT_WORKSPACE_DIR,
      timeout,
      maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      NO_COLOR: '1'
    }
  });
    const output = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
    return { ok: true, output };
  } catch (e) {
    const output = `${e.stdout || ''}${e.stderr ? `\n${e.stderr}` : ''}`.trim();
    return { ok: false, output: output || String(e.message || e) };
  }
}

function parseOrgoOutput(result) {
  const output = scrubText(result.output || '', 12000);
  if (!result.ok || /not signed in/i.test(output)) {
    return {
      ok: false,
      authenticated: false,
      message: 'Orgo CLI is installed, but this Mac is not signed in for the bridge user. Run `orgo login` on the Mac.',
      raw: scrubText(output, 500)
    };
  }

  const parsed = parseMaybeJSON(output, null);
  return {
    ok: true,
    authenticated: true,
    data: parsed || output
  };
}

async function searchWorkspaceContext(args) {
  const query = scrubText(args.query || '', 160);
  const limit = clampNumber(args.limit, 1, 20, 8);
  if (query.length < 2) throw new Error('search query is too short');

  // Scoped, allow-listed search roots. Set AGENT_CONTEXT_PATHS to a
  // colon-separated list of paths (absolute, or relative to the workspace).
  // Default: the workspace root itself.
  const paths = AGENT_CONTEXT_PATHS.map((entry) => (
    entry.startsWith('/') ? entry : join(AGENT_WORKSPACE_DIR, entry)
  ));

  try {
    const { stdout } = await execFileAsync(RG_BIN, [
      '--no-heading',
      '--line-number',
      '--color',
      'never',
      '-i',
      '-F',
      '--',
      query,
      ...paths
    ], {
      cwd: AGENT_WORKSPACE_DIR,
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    const matches = stdout.trim().split('\n').filter(Boolean).slice(0, limit).map((line) => {
      const parts = line.split(':');
      const file = parts.shift() || '';
      const lineno = parts.shift() || '';
      return {
        file: repoRelative(file),
        line: Number(lineno) || null,
        text: scrubText(parts.join(':'), 260)
      };
    });
    return { ok: true, query, matches };
  } catch (e) {
    if (e.code === 1 || !e.stdout) return { ok: true, query, matches: [] };
    throw e;
  }
}

function looksHighRisk(text) {
  return /\b(send|text|email|post|publish|charge|pay|refund|credential|password|oauth|api key|delete|restart vm|remote vm|orgo start|orgo stop|orgo restart)\b/i.test(text);
}

async function createTaskHandoff(args) {
  const title = scrubText(args.title || 'OS1 voice handoff', 120) || 'OS1 voice handoff';
  const summary = clampText(args.summary || '', 6000);
  if (!summary) throw new Error('missing handoff summary');

  const riskClass = scrubText(args.risk_class || 'internal_reversible', 80) || 'internal_reversible';
  const gate = scrubText(args.gate || '', 300);
  const highRisk = riskClass === 'gated_high_risk' || looksHighRisk(`${title}\n${summary}\n${gate}`);
  if (args.dry_run) {
    return {
      ok: true,
      dryRun: true,
      wouldCreate: {
        title,
        assignee: AGENT_TASK_ASSIGNEE,
        status: highRisk ? 'blocked' : 'todo',
        riskClass,
        gate: gate || (highRisk ? 'approval required before execution' : '')
      }
    };
  }

  const body = [
    'source_surface: os1_voice',
    `owner: ${AGENT_PROFILE_ROUTER}`,
    `risk_class: ${riskClass}`,
    `gate: ${gate || (highRisk ? 'approval required before execution' : 'none')}`,
    '',
    '## User Intent Summary',
    '',
    markdownSafe(summary),
    '',
    '## Instructions',
    '',
    '- Treat this as a voice-originated work packet.',
    '- Load the relevant context before acting.',
    '- Leave a comment or log entry for any work done.',
    '- Do not move money, mutate credentials, send messages to other people, post publicly, or mutate a remote machine without an explicit approval gate.'
  ].join('\n');

  const cmd = [
    ...AGENT_TASK_SUBCOMMAND,
    title,
    '--json',
    '--body',
    body,
    '--assignee',
    AGENT_TASK_ASSIGNEE,
    '--workspace',
    `dir:${AGENT_WORKSPACE_DIR}`,
    '--created-by',
    'os1-voice',
    '--idempotency-key',
    `os1-voice-${randomUUID()}`
  ];
  if (highRisk) cmd.push('--initial-status', 'blocked');

  const { stdout } = await execFileAsync(AGENT_CLI_BIN, cmd, {
    cwd: AGENT_WORKSPACE_DIR,
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      ...AGENT_CLI_ENV
    }
  });
  const parsed = parseMaybeJSON(stdout, {});
  return {
    ok: true,
    title,
    status: highRisk ? 'blocked' : 'todo',
    riskClass,
    gate: gate || (highRisk ? 'approval required before execution' : 'none'),
    task: parsed
  };
}

async function executeAgentTool(name, rawArgs) {
  const args = parseMaybeJSON(rawArgs, {});
  switch (name) {
    case 'get_active_kanban': {
      const limit = clampNumber(args.limit, 1, 40, 16);
      const board = DEMO ? demoKanban : (BACKEND === 'local' ? await localKanban() : await orgoExec('import json\nprint(json.dumps({"columns": []}))'));
      return { ok: true, tool: name, ...summarizeKanban(board, limit) };
    }
    case 'search_workspace_context':
      return { tool: name, ...(await searchWorkspaceContext(args)) };
    case 'ask_assistant': {
      const question = clampText(args.question || '', 3000);
      if (!question) throw new Error('missing question');
      const context = clampText(args.context || '', 4000);
      const prompt = [
        'The voice mode is asking for assistant judgment during a live OS1 voice session.',
        'Reply short, direct, and useful for spoken delivery.',
        '',
        '## Question',
        question,
        '',
        '## Context',
        context || 'none'
      ].join('\n');
      const reply = await runAgentProfile(AGENT_PROFILE_ASSISTANT, prompt);
      return { ok: true, tool: name, reply };
    }
    case 'dispatch_task':
      return { tool: name, ...(await createTaskHandoff(args)) };
    case 'orgo_status': {
      const whoami = parseOrgoOutput(await runOrgoReadOnly(['whoami']));
      const result = { ok: whoami.ok, tool: name, whoami };
      if (whoami.ok && args.include_computers !== false) {
        result.computers = parseOrgoOutput(await runOrgoReadOnly(['computers', 'list']));
      }
      return result;
    }
    case 'dashboard_status': {
      try {
        const response = await fetch(COCKPIT_URL, { signal: AbortSignal.timeout(2500) });
        return {
          ok: response.ok,
          tool: name,
          reachable: response.ok,
          status: response.status,
          url: COCKPIT_URL
        };
      } catch (e) {
        return {
          ok: false,
          tool: name,
          reachable: false,
          url: COCKPIT_URL,
          error: scrubText(e.message || e, 300)
        };
      }
    }
    default:
      throw new Error(`unknown voice tool: ${name}`);
  }
}

async function handleVoiceTools(req, res) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  return json(res, 200, { ok: true, tools: voiceToolDefinitions() });
}

async function handleVoiceToolCall(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  try {
    const body = await readJsonBody(req, 256 * 1024);
    const name = scrubText(body.name || body.tool || '', 120);
    const args = body.arguments ?? body.argumentsJson ?? {};
    if (!name) return json(res, 400, { error: 'missing tool name' });
    const result = await executeAgentTool(name, args);
    console.log(`${new Date().toISOString()} voice-tool tool=${name} ok=${result.ok !== false}`);
    return json(res, 200, result);
  } catch (e) {
    const message = String(e.message || e);
    console.error(`${new Date().toISOString()} voice-tool-error error=${scrubText(message, 500)}`);
    return json(res, message === 'request too large' ? 413 : 502, { ok: false, error: message });
  }
}

function agentPrompt(agent, text, source = 'text') {
  const cleaned = scrubText(text, 6000);
  if (!cleaned) throw new Error('missing text');

  const base = [
    'You are being invoked from the native OS1 iPhone app.',
    'Reply in a concise spoken-answer style for the operator.',
    'Do not expose secrets. Do not perform high-risk actions without an explicit gate.',
    `Input source: ${source}.`,
    '',
    cleaned
  ].join('\n');

  if (agent === 'note') {
    return [
      'Note mode.',
      'Treat the user input as a voice note or capture request unless they ask a direct question.',
      'Return: one short acknowledgement, the useful cleaned notes, and any next action worth routing to the assistant.',
      '',
      base
    ].join('\n');
  }

  if (agent === 'voice') {
    return [
      'Voice mode.',
      'Answer as the OS1 realtime voice operator: short, direct, and action-oriented.',
      'If the input asks for work, state whether it should route to the assistant, the router, notes, Orgo, or the dashboard.',
      '',
      base
    ].join('\n');
  }

  return [
    'Assistant mode.',
    'Answer as the chief-of-staff assistant: direct, useful, and short. If the input asks for work, state the immediate move.',
    '',
    base
  ].join('\n');
}

function realtimeInstructions(agent) {
  const shared = [
    'You are speaking to the operator inside the native OS1 iPhone app.',
    'Use natural spoken conversation. Keep replies short unless asked for detail.',
    'Do not expose secrets. Do not perform high-risk actions without an explicit gate.',
    'If work needs the Mac, say the next concrete move and keep it brief.'
  ];

  if (agent === 'note') {
    return [
      'Note mode.',
      'Treat speech as live notes, capture requests, meeting fragments, or dictated thoughts.',
      'Acknowledge quickly, clean up the useful note, and name any next action the assistant should take.',
      ...shared
    ].join('\n');
  }

  if (agent === 'voice') {
    return [
      voiceInstructions(),
      ...shared
    ].join('\n');
  }

  return [
    'Assistant mode.',
    'You are the chief-of-staff assistant: direct, useful, and action-oriented.',
    'When the operator asks for work, respond with the immediate move and any constraint that matters.',
    ...shared
  ].join('\n');
}

async function handleRealtimeSession(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  try {
    const body = await readJsonBody(req);
    const agent = String(body.agent || 'assistant').toLowerCase();
    if (!['voice', 'assistant', 'note'].includes(agent)) {
      return json(res, 400, { error: 'unknown agent', allowed: ['voice', 'assistant', 'note'] });
    }
    if (!OPENAI_API_KEY) {
      return json(res, 503, { error: 'OpenAI API key is not available on the OS1 bridge' });
    }

    const payload = {
      session: {
        type: 'realtime',
        model: OPENAI_REALTIME_MODEL,
        instructions: realtimeInstructions(agent),
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            noise_reduction: { type: OPENAI_REALTIME_NOISE_REDUCTION },
            turn_detection: {
              type: 'server_vad',
              threshold: OPENAI_REALTIME_VAD_THRESHOLD,
              prefix_padding_ms: 500,
              silence_duration_ms: 600,
              create_response: true,
              interrupt_response: false
            }
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: OPENAI_REALTIME_VOICE
          }
        }
      }
    };
    if (agent === 'voice') {
      payload.session.tools = voiceToolDefinitions();
      payload.session.tool_choice = 'auto';
    }

    const openaiRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await openaiRes.json().catch(() => ({}));
    if (!openaiRes.ok) {
      const message = scrubText(data?.error?.message || `OpenAI ${openaiRes.status}`, 500);
      return json(res, openaiRes.status, { error: message });
    }

    const value = data?.value || data?.client_secret?.value;
    if (!value) {
      return json(res, 502, { error: 'OpenAI client secret response did not include a value' });
    }

    console.log(`${new Date().toISOString()} realtime-session agent=${agent} model=${OPENAI_REALTIME_MODEL} voice=${OPENAI_REALTIME_VOICE} vadThreshold=${OPENAI_REALTIME_VAD_THRESHOLD} noiseReduction=${OPENAI_REALTIME_NOISE_REDUCTION}`);
    return json(res, 200, {
      ok: true,
      agent,
      model: OPENAI_REALTIME_MODEL,
      voice: OPENAI_REALTIME_VOICE,
      vadThreshold: OPENAI_REALTIME_VAD_THRESHOLD,
      noiseReduction: OPENAI_REALTIME_NOISE_REDUCTION,
      clientSecret: value,
      tools: agent === 'voice' ? voiceToolDefinitions().map((tool) => tool.name) : [],
      expiresAt: data?.expires_at || data?.client_secret?.expires_at || null
    });
  } catch (e) {
    const message = String(e.message || e);
    const code = message === 'request too large' ? 413 : 502;
    return json(res, code, { error: message });
  }
}

function noteCapturePaths(captureId, now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  const month = date.slice(0, 7);
  const shortId = captureId.split('-').pop() || randomUUID().slice(0, 8);
  // Everything a capture writes lives under CAPTURE_ROOT (default:
  // <workspace>/os1-captures), partitioned by month.
  const receiptDir = join(CAPTURE_ROOT, 'receipts', month);
  const artifactDir = join(CAPTURE_ROOT, 'artifacts', month);
  const captureDir = join(CAPTURE_ROOT, 'captures', month);
  const os1ContextDir = join(CAPTURE_ROOT, 'transcripts', month);
  const routerQueueDir = join(CAPTURE_ROOT, 'queue', month);
  return {
    date,
    month,
    receiptDir,
    artifactDir,
    captureDir,
    os1ContextDir,
    routerQueueDir,
    capturePath: join(captureDir, `${date}-ios-note-capture-${shortId}.md`),
    os1ContextPath: join(os1ContextDir, `${captureId}.md`),
    routerQueuePath: join(routerQueueDir, `${captureId}.md`),
    transcriptArtifact: join(artifactDir, `${captureId}-transcript.md`),
    followupArtifact: join(artifactDir, `${captureId}-router-routing.md`),
    receiptPath: join(receiptDir, `${date}-os1-note-capture-${shortId}.md`)
  };
}

// Render a path relative to the capture root or workspace so absolute host
// paths are not echoed back to the phone.
function repoPath(absPath) {
  for (const prefix of [`${CAPTURE_ROOT}/`, `${AGENT_WORKSPACE_DIR}/`]) {
    if (prefix !== '/' && absPath.startsWith(prefix)) return absPath.slice(prefix.length);
  }
  return absPath;
}

async function transcribeAudioBuffer(audioBuffer, filename, mimeType) {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API key is not available on the OS1 bridge');
  }
  if (audioBuffer.byteLength > OPENAI_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    throw new Error(`audio too large: ${audioBuffer.byteLength} bytes`);
  }

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), filename);
  form.append('model', OPENAI_TRANSCRIPTION_MODEL);

  const openaiRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  const data = await openaiRes.json().catch(() => ({}));
  if (!openaiRes.ok) {
    const message = scrubText(data?.error?.message || `OpenAI transcription ${openaiRes.status}`, 700);
    throw new Error(message);
  }

  const text = String(data?.text || '').trim();
  if (!text) throw new Error('OpenAI transcription response was empty');
  return text;
}

async function writeTextArtifact(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

const OS1_LOCAL_TIME_ZONE = process.env.OS1_LOCAL_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function localDateTimeParts(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: OS1_LOCAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now).map((part) => [part.type, part.value]));

  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    timeZone: OS1_LOCAL_TIME_ZONE
  };
}

function os1NoteContextContents({
  captureId,
  transcript,
  durationSeconds,
  source,
  paths,
  now,
  routingStatus = 'queued_to_router',
  routingError = ''
}) {
  const local = localDateTimeParts(now);
  return [
    '---',
    `capture_id: ${captureId}`,
    'source_type: os1_note_voice_dump',
    `source: ${source}`,
    `created_at: ${now.toISOString()}`,
    `local_date: ${local.localDate}`,
    `local_time: ${local.localTime}`,
    `time_zone: ${local.timeZone}`,
    'capture_mode: voice_dump',
    `duration_seconds: ${durationSeconds}`,
    `transcription_model: ${OPENAI_TRANSCRIPTION_MODEL}`,
    'raw_audio_retention: not_retained',
    `capture_record: ${repoPath(paths.capturePath)}`,
    `transcript_artifact: ${repoPath(paths.transcriptArtifact)}`,
    `receipt: ${repoPath(paths.receiptPath)}`,
    `router_queue_packet: ${repoPath(paths.routerQueuePath)}`,
    `router_routing_artifact: ${repoPath(paths.followupArtifact)}`,
    `routing_status: ${routingStatus}`,
    ...(routingError ? [`routing_error: ${JSON.stringify(routingError)}`] : []),
    '---',
    '',
    `# OS1 Voice-Note Transcript - ${local.localDate} ${local.localTime}`,
    '',
    'Canonical transcript for an OS1 voice-note capture.',
    '',
    '## Transcript',
    '',
    '```text',
    markdownSafe(transcript),
    '```',
    ''
  ].join('\n');
}

function routerNoteQueueContents({
  captureId,
  durationSeconds,
  source,
  paths,
  now,
  routingStatus = 'queued_to_router',
  routingError = ''
}) {
  const local = localDateTimeParts(now);
  return [
    '---',
    `capture_id: ${captureId}`,
    'source_type: os1_note_voice_dump',
    `source: ${source}`,
    `created_at: ${now.toISOString()}`,
    `local_date: ${local.localDate}`,
    `local_time: ${local.localTime}`,
    `time_zone: ${local.timeZone}`,
    `duration_seconds: ${durationSeconds}`,
    `canonical_transcript: ${repoPath(paths.os1ContextPath)}`,
    `capture_record: ${repoPath(paths.capturePath)}`,
    `receipt: ${repoPath(paths.receiptPath)}`,
    `router_routing_artifact: ${repoPath(paths.followupArtifact)}`,
    `routing_status: ${routingStatus}`,
    ...(routingError ? [`routing_error: ${JSON.stringify(routingError)}`] : []),
    '---',
    '',
    `# OS1 Voice-Note Routing Packet - ${captureId}`,
    '',
    '## Task',
    '',
    'Read the canonical transcript, decide whether it needs a Kanban card, client/customer link, company-context update, or no action, and leave a routing summary in the routing artifact.',
    '',
    '## Source',
    '',
    `- Canonical transcript: ${repoPath(paths.os1ContextPath)}`,
    `- Capture record: ${repoPath(paths.capturePath)}`,
    `- Receipt: ${repoPath(paths.receiptPath)}`,
    `- Routing artifact: ${repoPath(paths.followupArtifact)}`,
    ''
  ].join('\n');
}

async function runTaskRouting({ captureId, transcript, durationSeconds, source, paths }) {
  const transcriptForPrompt = transcript.length > 12000
    ? `${transcript.slice(0, 12000)}\n\n[Full transcript continues at ${repoPath(paths.os1ContextPath)}]`
    : transcript;

  const prompt = [
    '# OS1 voice-note capture routing',
    '',
    'You are the task router for this workspace.',
    'A voice note recorded on the iPhone was just transcribed. This is internal routing only.',
    '',
    '## Inputs',
    `- capture_id: ${captureId}`,
    `- source: ${source}`,
    `- duration_seconds: ${durationSeconds}`,
    `- canonical_transcript: ${repoPath(paths.os1ContextPath)}`,
    `- transcript_artifact: ${repoPath(paths.transcriptArtifact)}`,
    `- queue_packet: ${repoPath(paths.routerQueuePath)}`,
    '',
    '## Task',
    '1. Read the canonical transcript if you need the full text.',
    '2. Decide where this belongs: existing Kanban/work order if obvious, or a bounded new/internal card when useful.',
    '3. Preserve gates: no money movement, public posts, outbound sends, credential mutation, or remote-machine mutation.',
    '4. Do not edit the capture, transcript, queue, receipt, or bridge artifacts. The OS1 bridge owns those files.',
    '5. Return a concise routing summary with any card ids, paths, or owners touched.',
    '',
    '## Transcript preview',
    '```text',
    markdownSafe(transcriptForPrompt),
    '```'
  ].join('\n');

  const { stdout, stderr } = await execFileAsync(AGENT_CLI_BIN, [AGENT_CLI_PROFILE_FLAG, AGENT_PROFILE_ROUTER, AGENT_CLI_PROMPT_FLAG, prompt], {
    cwd: AGENT_WORKSPACE_DIR,
    timeout: 240000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      ...AGENT_CLI_ENV
    }
  });

  return stripVerifierNoise(clampText(stdout || stderr || '', 24000));
}

async function handleNoteCapture(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  try {
    const body = await readJsonBody(req, NOTE_CAPTURE_MAX_JSON_BYTES);
    const source = scrubText(body.source || 'ios-native-note-capture', 80) || 'ios-native-note-capture';
    const mimeType = scrubText(body.mimeType || 'audio/mp4', 80) || 'audio/mp4';
    const filename = scrubText(body.filename || 'note-capture.m4a', 120).replace(/[^\w.\-]/g, '_') || 'note-capture.m4a';
    const durationSeconds = Math.max(0, Math.floor(Number(body.durationSeconds || 0) || 0));
    const audioBase64 = String(body.audioBase64 || '');
    if (!audioBase64) return json(res, 400, { error: 'missing audioBase64' });

    const audioBuffer = Buffer.from(audioBase64, 'base64');
    if (!audioBuffer.byteLength) return json(res, 400, { error: 'empty audio' });
    if (audioBuffer.byteLength > OPENAI_TRANSCRIPTION_MAX_AUDIO_BYTES) {
      return json(res, 413, { error: `audio too large; max ${OPENAI_TRANSCRIPTION_MAX_AUDIO_BYTES} bytes` });
    }

    const now = new Date();
    const captureId = `${now.toISOString().slice(0, 10)}-ios-note-${randomUUID().slice(0, 8)}`;
    const paths = noteCapturePaths(captureId, now);

    console.log(`${new Date().toISOString()} note-capture-start capture=${captureId} source=${source} bytes=${audioBuffer.byteLength} duration=${durationSeconds}`);
    const transcript = await transcribeAudioBuffer(audioBuffer, filename, mimeType);

    await mkdir(paths.captureDir, { recursive: true });
    await mkdir(paths.artifactDir, { recursive: true });
    await mkdir(paths.os1ContextDir, { recursive: true });
    await mkdir(paths.routerQueueDir, { recursive: true });

    await writeTextArtifact(paths.transcriptArtifact, [
      `# Note Capture Transcript ${captureId}`,
      '',
      `capture_id: ${captureId}`,
      `created_at: ${now.toISOString()}`,
      `source: ${source}`,
      `duration_seconds: ${durationSeconds}`,
      `transcription_model: ${OPENAI_TRANSCRIPTION_MODEL}`,
      `media_pointer: not_retained_bridge_memory_only`,
      '',
      '## Transcript',
      '',
      '```text',
      markdownSafe(transcript),
      '```',
      ''
    ].join('\n'));

    await writeTextArtifact(paths.os1ContextPath, os1NoteContextContents({
      captureId,
      transcript,
      durationSeconds,
      source,
      paths,
      now,
      routingStatus: 'queued_to_router'
    }));

    await writeTextArtifact(paths.routerQueuePath, routerNoteQueueContents({
      captureId,
      durationSeconds,
      source,
      paths,
      now,
      routingStatus: 'queued_to_router'
    }));

    await writeTextArtifact(paths.capturePath, [
      '---',
      `capture_id: ${captureId}`,
      'capture_mode: voice_dump',
      `source: ${source}`,
      `created_at: ${now.toISOString()}`,
      'media_pointer: not_retained_bridge_memory_only',
      `duration_seconds: ${durationSeconds}`,
      `canonical_transcript: ${repoPath(paths.os1ContextPath)}`,
      `transcript_artifact: ${repoPath(paths.transcriptArtifact)}`,
      `router_queue_packet: ${repoPath(paths.routerQueuePath)}`,
      `router_routing_artifact: ${repoPath(paths.followupArtifact)}`,
      'status: dispatched_to_router',
      '---',
      '',
      `# OS1 iPhone Voice-Note Capture ${captureId}`,
      '',
      '## Summary',
      '',
      '- The iPhone recorded the note locally and uploaded it after you stopped.',
      '- Bridge transcribed the audio once and did not retain raw audio in the repo.',
      '- Router dispatch was started for Kanban/workflow routing.',
      '',
      '## Artifacts',
      '',
      `- Canonical OS1 transcript: ${repoPath(paths.os1ContextPath)}`,
      `- Transcript: ${repoPath(paths.transcriptArtifact)}`,
      `- Router queue packet: ${repoPath(paths.routerQueuePath)}`,
      `- Router routing: ${repoPath(paths.followupArtifact)}`,
      `- Receipt: ${repoPath(paths.receiptPath)}`,
      ''
    ].join('\n'));

    await writeTextArtifact(paths.receiptPath, [
      '---',
      `date: ${paths.date}`,
      'agent: os1-bridge',
      'action: os1_note_capture',
      'outcome: dispatched_to_router',
      `capture_id: ${captureId}`,
      'capture_mode: voice_dump',
      `source: ${source}`,
      'media_pointer: not_retained_bridge_memory_only',
      `canonical_transcript: ${repoPath(paths.os1ContextPath)}`,
      `transcript_artifact: ${repoPath(paths.transcriptArtifact)}`,
      `capture_record: ${repoPath(paths.capturePath)}`,
      `router_queue_packet: ${repoPath(paths.routerQueuePath)}`,
      `router_routing_artifact: ${repoPath(paths.followupArtifact)}`,
      '---',
      '',
      `# OS1 Voice-Note Capture ${captureId}`,
      '',
      '## What happened',
      '',
      '- The iPhone recorded audio locally until the user stopped the capture.',
      `- Bridge transcribed the uploaded audio with ${OPENAI_TRANSCRIPTION_MODEL}.`,
      '- Router dispatch was started; routing output lands in the follow-up artifact.',
      '- Raw audio was not written into the workspace.',
      '',
      '## Proof',
      '',
      `- Capture record: ${repoPath(paths.capturePath)}`,
      `- Canonical OS1 transcript: ${repoPath(paths.os1ContextPath)}`,
      `- Transcript artifact: ${repoPath(paths.transcriptArtifact)}`,
      `- Router queue packet: ${repoPath(paths.routerQueuePath)}`,
      `- Router routing artifact: ${repoPath(paths.followupArtifact)}`,
      `- Transcript chars: ${transcript.length}`,
      ''
    ].join('\n'));

    void (async () => {
      const routerReply = await runTaskRouting({
        captureId,
        transcript,
        durationSeconds,
        source,
        paths
      });

      await writeTextArtifact(paths.followupArtifact, [
        `# Router Routing ${captureId}`,
        '',
        `capture_id: ${captureId}`,
        `created_at: ${new Date().toISOString()}`,
        `canonical_transcript: ${repoPath(paths.os1ContextPath)}`,
        `transcript_artifact: ${repoPath(paths.transcriptArtifact)}`,
        `queue_packet: ${repoPath(paths.routerQueuePath)}`,
        '',
        '## Router response',
        '',
        routerReply || 'No Router response returned.',
        ''
      ].join('\n'));

      await writeTextArtifact(paths.capturePath, [
        '---',
        `capture_id: ${captureId}`,
        'capture_mode: voice_dump',
        `source: ${source}`,
        `created_at: ${now.toISOString()}`,
        'media_pointer: not_retained_bridge_memory_only',
        `duration_seconds: ${durationSeconds}`,
        `canonical_transcript: ${repoPath(paths.os1ContextPath)}`,
        `transcript_artifact: ${repoPath(paths.transcriptArtifact)}`,
        `router_queue_packet: ${repoPath(paths.routerQueuePath)}`,
        `router_routing_artifact: ${repoPath(paths.followupArtifact)}`,
        'status: routed_to_router',
        '---',
        '',
        `# OS1 iPhone Voice-Note Capture ${captureId}`,
        '',
        '## Summary',
        '',
        '- The iPhone recorded the note locally and uploaded it after you stopped.',
        '- Bridge transcribed the audio once and did not retain raw audio in the repo.',
        '- Router received the transcript for Kanban/workflow routing.',
        '',
        '## Artifacts',
        '',
        `- Canonical OS1 transcript: ${repoPath(paths.os1ContextPath)}`,
        `- Transcript: ${repoPath(paths.transcriptArtifact)}`,
        `- Router queue packet: ${repoPath(paths.routerQueuePath)}`,
        `- Router routing: ${repoPath(paths.followupArtifact)}`,
        `- Receipt: ${repoPath(paths.receiptPath)}`,
        ''
      ].join('\n'));

      await writeTextArtifact(paths.os1ContextPath, os1NoteContextContents({
        captureId,
        transcript,
        durationSeconds,
        source,
        paths,
        now,
        routingStatus: 'routed_to_router'
      }));

      await writeTextArtifact(paths.routerQueuePath, routerNoteQueueContents({
        captureId,
        durationSeconds,
        source,
        paths,
        now,
        routingStatus: 'routed_to_router'
      }));

      await writeTextArtifact(paths.receiptPath, [
        '---',
        `date: ${paths.date}`,
        'agent: os1-bridge',
        'action: os1_note_capture',
        'outcome: routed_to_router',
        `capture_id: ${captureId}`,
        'capture_mode: voice_dump',
        `source: ${source}`,
        'media_pointer: not_retained_bridge_memory_only',
        `canonical_transcript: ${repoPath(paths.os1ContextPath)}`,
        `transcript_artifact: ${repoPath(paths.transcriptArtifact)}`,
        `capture_record: ${repoPath(paths.capturePath)}`,
        `router_queue_packet: ${repoPath(paths.routerQueuePath)}`,
        `router_routing_artifact: ${repoPath(paths.followupArtifact)}`,
        '---',
        '',
        `# OS1 Voice-Note Capture ${captureId}`,
        '',
        '## What happened',
        '',
        '- The iPhone recorded audio locally until the user stopped the capture.',
        `- Bridge transcribed the uploaded audio with ${OPENAI_TRANSCRIPTION_MODEL}.`,
        '- Router received the transcript and returned a Kanban routing summary.',
        '- Raw audio was not written into the workspace.',
        '',
        '## Proof',
        '',
        `- Capture record: ${repoPath(paths.capturePath)}`,
        `- Canonical OS1 transcript: ${repoPath(paths.os1ContextPath)}`,
        `- Transcript artifact: ${repoPath(paths.transcriptArtifact)}`,
        `- Router queue packet: ${repoPath(paths.routerQueuePath)}`,
        `- Router routing artifact: ${repoPath(paths.followupArtifact)}`,
        `- Transcript chars: ${transcript.length}`,
        ''
      ].join('\n'));

      console.log(`${new Date().toISOString()} note-capture-routed capture=${captureId} transcript_chars=${transcript.length}`);
    })().catch(async (error) => {
      const message = scrubText(error?.message || error, 1000);
      await writeTextArtifact(paths.followupArtifact, [
        `# Router Routing ${captureId}`,
        '',
        `capture_id: ${captureId}`,
        `created_at: ${new Date().toISOString()}`,
        `canonical_transcript: ${repoPath(paths.os1ContextPath)}`,
        `transcript_artifact: ${repoPath(paths.transcriptArtifact)}`,
        `queue_packet: ${repoPath(paths.routerQueuePath)}`,
        'status: router_routing_failed',
        '',
        '## Error',
        '',
        message || 'Router routing failed.',
        ''
      ].join('\n')).catch(() => {});
      await writeTextArtifact(paths.os1ContextPath, os1NoteContextContents({
        captureId,
        transcript,
        durationSeconds,
        source,
        paths,
        now,
        routingStatus: 'router_routing_failed',
        routingError: message
      })).catch(() => {});
      await writeTextArtifact(paths.routerQueuePath, routerNoteQueueContents({
        captureId,
        durationSeconds,
        source,
        paths,
        now,
        routingStatus: 'router_routing_failed',
        routingError: message
      })).catch(() => {});
      console.error(`${new Date().toISOString()} note-capture-routing-error capture=${captureId} error=${message}`);
    });

    console.log(`${new Date().toISOString()} note-capture-dispatched capture=${captureId} transcript_chars=${transcript.length}`);
    return json(res, 200, {
      ok: true,
      captureId,
      transcriptChars: transcript.length,
      reply: '',
      capturePath: repoPath(paths.capturePath),
      receiptPath: repoPath(paths.receiptPath),
      canonicalTranscript: repoPath(paths.os1ContextPath),
      transcriptArtifact: repoPath(paths.transcriptArtifact),
      routerQueuePacket: repoPath(paths.routerQueuePath),
      followupArtifact: repoPath(paths.followupArtifact)
    });
  } catch (e) {
    const message = String(e.message || e);
    const code =
      message === 'request too large' || message.startsWith('audio too large') ? 413 :
      message.includes('OpenAI API key') ? 503 :
      502;
    return json(res, code, { error: message });
  }
}

async function runAgentMode(agent, text, source) {
  const profile = agent === 'note' ? AGENT_PROFILE_NOTE : agent === 'assistant' ? AGENT_PROFILE_ASSISTANT : null;
  const reply = await runAgentProfile(profile, agentPrompt(agent, text, source));
  if (!reply) throw new Error('empty agent reply');
  return {
    ok: true,
    agent,
    source,
    reply
  };
}

async function handleAgentChat(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  try {
    const body = await readJsonBody(req);
    const agent = String(body.agent || 'assistant').toLowerCase();
    if (!['voice', 'assistant', 'note'].includes(agent)) {
      return json(res, 400, { error: 'unknown agent', allowed: ['voice', 'assistant', 'note'] });
    }
    const text = scrubText(body.text || body.transcript || '', 6000);
    const source = scrubText(body.source || 'text', 40) || 'text';
    if (!text) return json(res, 400, { error: 'missing text' });

    console.log(`${new Date().toISOString()} agent-chat agent=${agent} source=${source}`);
    const result = await runAgentMode(agent, text, source);
    return json(res, 200, result);
  } catch (e) {
    const message = String(e.message || e);
    const code = message === 'request too large' ? 413 : 502;
    return json(res, code, { error: message });
  }
}

async function handleVoiceEvent(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  try {
    const body = await readJsonBody(req);
    const agent = String(body.agent || 'assistant').toLowerCase();
    if (!['voice', 'assistant', 'note'].includes(agent)) {
      return json(res, 400, { error: 'unknown agent', allowed: ['voice', 'assistant', 'note'] });
    }

    const event = scrubText(body.event || 'unknown', 60);
    const source = scrubText(body.source || 'native', 40);
    const chars = Number(body.chars || 0);
    const safeChars = Number.isFinite(chars) && chars > 0 ? Math.min(Math.floor(chars), 6000) : 0;
    console.log(`${new Date().toISOString()} voice-event agent=${agent} source=${source} event=${event} chars=${safeChars}`);
    return json(res, 200, { ok: true });
  } catch (e) {
    const message = String(e.message || e);
    const code = message === 'request too large' ? 413 : 400;
    return json(res, code, { error: message });
  }
}

async function handleApi(req, res, url) {
  if (!requireApiAuth(req, res)) return;
  const route = url.pathname.replace(/^\/api/, '');

  if (route === '/health') {
    if (BACKEND === 'local') return json(res, 200, await localHealth());
    return json(res, 200, {
      ok: true,
      demo: DEMO,
      configured: !DEMO,
      backend: BACKEND,
      computerId: DEMO ? null : ORGO_COMPUTER_ID,
      base: ORGO_BASE
    });
  }

  // Read-only surfaces.
  try {
    if (route === '/sessions') {
      if (DEMO) return json(res, 200, demoSessions);
      if (BACKEND === 'local') return json(res, 200, await localSessions());
      // Live: OS1 lists sessions via the agent on the VM.
      const data = await orgoExec(`
import json
print(json.dumps({"items": []}))
`);
      return json(res, 200, data);
    }
    if (route === '/kanban') {
      if (DEMO) return json(res, 200, demoKanban);
      if (BACKEND === 'local') return json(res, 200, await localKanban());
      const data = await orgoExec(`
import json
print(json.dumps({"columns": []}))
`);
      return json(res, 200, data);
    }
    if (route === '/files') {
      if (DEMO) return json(res, 200, demoFiles);
      if (BACKEND === 'local') return json(res, 200, await localFiles());
      const data = await orgoExec(`
import json
print(json.dumps({"items": []}))
`);
      return json(res, 200, data);
    }
    if (route === '/agents/chat' || route === '/voice/transcript') {
      return await handleAgentChat(req, res);
    }
    if (route === '/voice/event') {
      return await handleVoiceEvent(req, res);
    }
    if (route === '/voice/tools') {
      return await handleVoiceTools(req, res);
    }
    if (route === '/voice/tool') {
      return await handleVoiceToolCall(req, res);
    }
    if (route === '/note/capture') {
      return await handleNoteCapture(req, res);
    }
    if (route === '/realtime/session') {
      return await handleRealtimeSession(req, res);
    }
  } catch (e) {
    return json(res, 502, { error: String(e.message || e) });
  }

  return json(res, 404, { error: 'unknown api route', route });
}

/* ---------- Static file serving ---------- */

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // Prevent path traversal.
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }

  try {
    const s = await stat(filePath);
    if (s.isDirectory()) throw new Error('is dir');
    const body = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(body);
  } catch {
    // SPA fallback for app routes; 404 for missing assets.
    if (extname(filePath)) {
      res.writeHead(404); res.end('not found');
    } else {
      const html = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(html);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ua = req.headers['user-agent'] || '';
  const client =
    ua.includes('iPhone') ? 'iphone' :
    ua.includes('Mobile') ? 'mobile' :
    ua.includes('Chrome') || ua.includes('Safari') ? 'browser' :
    'client';
  console.log(`${new Date().toISOString()} ${req.socket.remoteAddress} ${client} ${req.method} ${url.pathname}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    return await serveStatic(req, res, url);
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const mode = DEMO ? 'DEMO' : BACKEND === 'local' ? `LOCAL → ${AGENT_HOME}` : `ORGO → ${ORGO_COMPUTER_ID}`;
  console.log(`OS1 bridge on http://${HOST}:${PORT}  (${mode}${ACCESS_TOKEN ? ' · token-protected' : ''})`);
});
