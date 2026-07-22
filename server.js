#!/usr/bin/env node
/**
 * AI Agents View — Claude Code セッション可視化サーバー
 *
 * ~/.claude/projects/{project}/{sessionId}.jsonl を読み取り、
 * セッションのメタデータ・アクティビティを集計して JSON API として提供する。
 * 外部依存なし・外部通信なし(ローカル読み取りのみ)。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = process.env.PORT ? Number(process.env.PORT) : 4370;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOSTNAME = process.env.HOST_LABEL || os.hostname().split('.')[0];

/**
 * ピア(他のPCで動いている ai-agents-view)の一覧。
 * 環境変数 PEERS または peers.json で指定:
 *   PEERS="http://192.168.1.20:4370,mac-mini=http://mac-mini.tail1234.ts.net:4370"
 *   peers.json: { "peers": ["other-pc=http://other-pc.local:4370"] }
 * "ラベル=URL" 形式にするとホスト名表示を上書きできる。
 */
function loadPeers() {
  const entries = (process.env.PEERS || '').split(',');
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'peers.json'), 'utf8'));
    if (Array.isArray(j.peers)) entries.push(...j.peers);
  } catch { /* peers.json は任意 */ }
  const peers = [];
  for (const raw of entries) {
    const s = raw.trim();
    if (!s) continue;
    const m = s.match(/^([^=]+)=(https?:\/\/.+)$/);
    if (m) peers.push({ label: m[1].trim(), url: m[2].trim() });
    else peers.push({ label: null, url: s });
  }
  return peers;
}

function fetchPeer(peer) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  return fetch(peer.url.replace(/\/$/, '') + '/api/data?local=1', { signal: ctrl.signal })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .finally(() => clearTimeout(t));
}

// mtime+size をキーにしたパース結果キャッシュ(追記型ファイルなので再パースを回避)
const cache = new Map(); // filePath -> { key, summary }

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** 1 セッション (.jsonl) を集計する */
function parseSession(filePath, stat) {
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(filePath);
  if (hit && hit.key === key) return hit.summary;

  const summary = {
    sessionId: path.basename(filePath, '.jsonl'),
    title: null,
    cwd: null,
    gitBranch: null,
    model: null,
    firstTs: null,
    lastTs: null,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: {},        // name -> count
    totalToolCalls: 0,
    outputTokens: 0,
    inputTokens: 0,
    firstPrompt: null,
    fileMtime: stat.mtimeMs,
    fileSize: stat.size,
    hourly: {},           // 'YYYY-MM-DDTHH' -> event count (タイムライン用)
  };

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return summary;
  }

  for (const line of content.split('\n')) {
    if (!line) continue;
    const o = safeJson(line);
    if (!o) continue;

    if (o.type === 'ai-title' && o.aiTitle) summary.title = o.aiTitle;

    const ts = o.timestamp;
    if (ts) {
      if (!summary.firstTs || ts < summary.firstTs) summary.firstTs = ts;
      if (!summary.lastTs || ts > summary.lastTs) summary.lastTs = ts;
    }
    if (o.cwd && !summary.cwd) summary.cwd = o.cwd;
    if (o.gitBranch) summary.gitBranch = o.gitBranch;

    if (o.type === 'user' && o.message) {
      summary.userMessages++;
      if (!summary.firstPrompt && typeof o.message.content === 'string') {
        summary.firstPrompt = o.message.content.slice(0, 120);
      }
      if (ts) {
        const h = ts.slice(0, 13);
        summary.hourly[h] = (summary.hourly[h] || 0) + 1;
      }
    } else if (o.type === 'assistant' && o.message) {
      summary.assistantMessages++;
      const m = o.message;
      if (m.model) summary.model = m.model;
      if (m.usage) {
        summary.outputTokens += m.usage.output_tokens || 0;
        summary.inputTokens +=
          (m.usage.input_tokens || 0) +
          (m.usage.cache_creation_input_tokens || 0) +
          (m.usage.cache_read_input_tokens || 0);
      }
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c && c.type === 'tool_use' && c.name) {
            summary.toolCalls[c.name] = (summary.toolCalls[c.name] || 0) + 1;
            summary.totalToolCalls++;
          }
        }
      }
      if (ts) {
        const h = ts.slice(0, 13);
        summary.hourly[h] = (summary.hourly[h] || 0) + 1;
      }
    }
  }

  cache.set(filePath, { key, summary });
  return summary;
}

/**
 * セッションのサブエージェントを列挙する。
 * {projDir}/{sessionId}/subagents/agent-*.jsonl (+ .meta.json) を参照。
 */
const metaCache = new Map(); // metaPath -> parsed json
function parseAgents(sessionDir, now) {
  const dir = path.join(sessionDir, 'subagents');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f));
  } catch { return []; }

  const agents = [];
  for (const f of files) {
    const fp = path.join(dir, f);
    let stat;
    try { stat = fs.statSync(fp); } catch { continue; }
    const id = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const metaPath = path.join(dir, `agent-${id}.meta.json`);
    let meta = metaCache.get(metaPath);
    if (meta === undefined) {
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { meta = {}; }
      metaCache.set(metaPath, meta);
    }
    agents.push({
      id,
      agentType: meta.agentType || null,
      description: meta.description || null,
      lastMs: stat.mtimeMs,
      // 直近3分以内に追記があれば実行中とみなす
      running: now - stat.mtimeMs < 3 * 60e3,
    });
  }
  agents.sort((a, b) => b.lastMs - a.lastMs);
  return agents;
}

function sessionStatus(s, now) {
  const last = s.lastTs ? Date.parse(s.lastTs) : s.fileMtime;
  const ageMin = (now - last) / 60000;
  if (ageMin < 3) return 'active';
  if (ageMin < 60) return 'recent';
  return 'idle';
}

/** 全プロジェクトを走査して集計を返す */
function collect() {
  const now = Date.now();
  const projects = [];

  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch {
    return { generatedAt: now, projects: [], error: `not found: ${PROJECTS_DIR}` };
  }

  for (const d of dirs) {
    const projDir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try {
      files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
    } catch { continue; }
    if (files.length === 0) continue;

    const sessions = [];
    for (const f of files) {
      const fp = path.join(projDir, f);
      let stat;
      try { stat = fs.statSync(fp); } catch { continue; }
      const s = parseSession(fp, stat);
      s.status = sessionStatus(s, now);
      s.agents = parseAgents(path.join(projDir, s.sessionId), now);
      s.totalAgents = s.agents.length;
      s.runningAgents = s.agents.filter((a) => a.running).length;
      sessions.push(s);
    }
    sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));

    // フォルダ名からプロジェクト表示名を復元 ("-Users-x-foo-bar" -> "foo/bar" 末尾側)
    const cwd = sessions.find((s) => s.cwd)?.cwd;
    const name = cwd ? path.basename(cwd) : d.name.split('-').filter(Boolean).slice(-2).join('/');

    const agg = {
      dirName: d.name,
      name,
      cwd: cwd || null,
      sessionCount: sessions.length,
      status: sessions.some((s) => s.status === 'active') ? 'active'
        : sessions.some((s) => s.status === 'recent') ? 'recent' : 'idle',
      lastTs: sessions[0]?.lastTs || null,
      totalToolCalls: sessions.reduce((a, s) => a + s.totalToolCalls, 0),
      outputTokens: sessions.reduce((a, s) => a + s.outputTokens, 0),
      inputTokens: sessions.reduce((a, s) => a + s.inputTokens, 0),
      userMessages: sessions.reduce((a, s) => a + s.userMessages, 0),
      assistantMessages: sessions.reduce((a, s) => a + s.assistantMessages, 0),
      totalAgents: sessions.reduce((a, s) => a + s.totalAgents, 0),
      runningAgents: sessions.reduce((a, s) => a + s.runningAgents, 0),
      sessions,
    };
    projects.push(agg);
  }

  projects.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  for (const p of projects) {
    p.host = HOSTNAME;
    p.remote = false;
    p.id = `${HOSTNAME}:${p.dirName}`;
  }
  return { generatedAt: now, host: HOSTNAME, projectsDir: PROJECTS_DIR, projects };
}

/** ローカル + ピアの集計をマージして返す */
async function collectAll() {
  const data = collect();
  const peers = loadPeers();
  if (peers.length === 0) return data;

  const results = await Promise.allSettled(peers.map(fetchPeer));
  data.peers = [];
  results.forEach((r, i) => {
    const peer = peers[i];
    if (r.status === 'fulfilled') {
      const d = r.value || {};
      const host = peer.label || d.host || new URL(peer.url).hostname;
      for (const p of d.projects || []) {
        p.host = host;
        p.remote = true;
        p.id = `${host}:${p.dirName}`;
        data.projects.push(p);
      }
      data.peers.push({ url: peer.url, host, ok: true, projects: (d.projects || []).length });
    } else {
      data.peers.push({ url: peer.url, host: peer.label, ok: false, error: String(r.reason).slice(0, 120) });
    }
  });
  data.projects.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  return data;
}

/* ══════════ Google カレンダー / ToDo (Tasks) 連携 ══════════
 * OAuth 2.0 (デスクトップアプリ / ループバック) を外部ライブラリなしで実装。
 *   1. Google Cloud Console で OAuth クライアント(種類: デスクトップアプリ)を作成
 *   2. google-credentials.json に保存 (ダウンロードした JSON そのままで可)
 *   3. ダッシュボードの「Google と連携」→ ブラウザで許可 → google-token.json に保存
 * トークン・認証情報はこのフォルダ内にのみ保存され、Google 以外への送信はない。
 */
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks';
const CRED_PATH = path.join(__dirname, 'google-credentials.json');
const TOKEN_PATH = path.join(__dirname, 'google-token.json');

/* 秘書アシスタントの設定。3つの動作モードを自動選択する:
 *   - 'api': Anthropic API キー(従量課金)。環境変数 ANTHROPIC_API_KEY か
 *            anthropic-credentials.json の { "apiKey": "sk-ant-..." }。
 *   - 'cli': この PC の Claude Code CLI をヘッドレス実行(サブスクのログインを使用)。
 *            API キーが無く claude コマンドがあれば自動で使う。
 *   - 'off': どちらも無い → 定型ブリーフィングにフォールバック(無料)。
 * provider を明示するには SECRETARY_PROVIDER=api|cli|auto|off または設定ファイルの "provider"。 */
const ANTHROPIC_CRED_PATH = path.join(__dirname, 'anthropic-credentials.json');
const DEFAULT_SECRETARY_MODEL = 'claude-haiku-4-5-20251001';

function resolveClaudeCli(pref) {
  const list = [
    pref, process.env.CLAUDE_CLI_PATH,
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
  ].filter(Boolean);
  for (const p of list) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

function loadSecretaryConfig() {
  let apiKey = process.env.ANTHROPIC_API_KEY || null;
  let model = process.env.SECRETARY_MODEL || null;
  let provider = process.env.SECRETARY_PROVIDER || null;
  let cliPref = process.env.CLAUDE_CLI_PATH || null;
  try {
    const j = JSON.parse(fs.readFileSync(ANTHROPIC_CRED_PATH, 'utf8'));
    if (!apiKey && j.apiKey) apiKey = j.apiKey;
    if (!model && j.model) model = j.model;
    if (!provider && j.provider) provider = j.provider;
    if (!cliPref && j.cliPath) cliPref = j.cliPath;
  } catch { /* 未設定 */ }
  model = model || DEFAULT_SECRETARY_MODEL;
  const cli = resolveClaudeCli(cliPref);
  provider = provider || 'auto';
  let mode;
  if (provider === 'off') mode = 'off';
  else if (provider === 'api') mode = apiKey ? 'api' : 'off';
  else if (provider === 'cli') mode = cli ? 'cli' : 'off';
  else mode = apiKey ? 'api' : (cli ? 'cli' : 'off'); // auto
  return { mode, apiKey, model, cli };
}

/** 会話履歴を CLI 用の単一プロンプト文字列に平坦化する */
function flattenForCli(messages) {
  const hist = messages.slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'ユーザー' : '秘書'}: ${m.content}`).join('\n');
  const last = messages[messages.length - 1].content;
  return (hist ? `これまでの会話:\n${hist}\n\n` : '') + `ユーザー: ${last}`;
}

/** Claude Code CLI をヘッドレス(-p)で実行して応答テキストを返す */
function runClaudeCli({ cli, model, system, prompt }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--model', model,
      '--system-prompt', system,
      '--output-format', 'json',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      // 純粋な相談用途なのでツール類は無効化(高速化・安全)
      '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'WebSearch', 'Task', 'Glob', 'Grep',
    ];
    let child;
    try {
      child = spawn(cli || 'claude', args, { env: process.env, cwd: os.tmpdir() });
    } catch (e) { reject(new Error('起動失敗: ' + e.message)); return; }
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('タイムアウト(60秒)')); }, 60e3);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('起動失敗: ' + e.message)); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(String(j.result || 'CLI エラー').slice(0, 160)));
        resolve(String(j.result || '').trim());
      } catch {
        reject(new Error((err || out || '応答なし').slice(0, 160)));
      }
    });
  });
}

function loadGoogleCreds() {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET };
  }
  try {
    const j = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    const c = j.installed || j.web || j;
    if (c.client_id && c.client_secret) return { client_id: c.client_id, client_secret: c.client_secret };
  } catch { /* 未設定 */ }
  return null;
}

function loadGoogleToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}
function saveGoogleToken(t) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(t, null, 2), { mode: 0o600 });
}

async function getGoogleAccessToken() {
  const creds = loadGoogleCreds();
  const tok = loadGoogleToken();
  if (!creds || !tok || !tok.refresh_token) return null;
  if (tok.access_token && tok.expiry && Date.now() < tok.expiry - 60e3) return tok.access_token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: tok.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error('トークン更新に失敗: ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  tok.access_token = j.access_token;
  tok.expiry = Date.now() + (j.expires_in || 3600) * 1000;
  saveGoogleToken(tok);
  return tok.access_token;
}

async function gApi(url, opts = {}) {
  const token = await getGoogleAccessToken();
  if (!token) { const e = new Error('unauthorized'); e.status = 401; throw e; }
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) {
    const e = new Error(`Google API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  return r.status === 204 ? null : r.json();
}

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hm(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 今日の予定 (カレンダー) + タスク (ToDo) を集める。30秒キャッシュ。 */
let agendaCache = { at: 0, data: null };
async function fetchAgenda() {
  if (agendaCache.data && Date.now() - agendaCache.at < 30e3) return agendaCache.data;

  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86400e3);
  const evUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams({
    timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '50',
  });
  const [evRes, listRes] = await Promise.all([
    gApi(evUrl),
    gApi('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=20'),
  ]);

  const events = (evRes.items || [])
    .filter((e) => e.status !== 'cancelled')
    .map((e) => ({
      id: e.id,
      summary: e.summary || '(無題)',
      allDay: !!(e.start && e.start.date),
      start: e.start?.dateTime || e.start?.date || null,
      end: e.end?.dateTime || e.end?.date || null,
      location: e.location || null,
      meetLink: e.hangoutLink || null,
    }));

  const today = localDateStr();
  const taskLists = await Promise.all((listRes.items || []).map(async (l) => {
    const tr = await gApi(
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(l.id)}/tasks?` +
      new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100' }));
    const tasks = (tr.items || [])
      .filter((t) => t.title)
      // 未完了すべて + 今日完了したものだけ表示
      .filter((t) => t.status !== 'completed' || (t.completed || '').slice(0, 10) === today)
      .map((t) => ({
        id: t.id,
        title: t.title,
        notes: t.notes || null,
        due: t.due ? t.due.slice(0, 10) : null,
        completed: t.status === 'completed',
      }));
    tasks.sort((a, b) => (a.completed === b.completed ? 0 : a.completed ? 1 : -1)
      || (a.due || '9999').localeCompare(b.due || '9999'));
    return { id: l.id, title: l.title, tasks };
  }));

  const data = { generatedAt: Date.now(), date: today, events, taskLists };
  agendaCache = { at: Date.now(), data };
  return data;
}

/* ══════════ 秘書アシスタント ══════════
 * 今日の予定 (カレンダー) + タスク (ToDo) を文脈として Anthropic API に渡し、
 * 予定のまとめ・やるべきこと・準備の相談に答える。API キー未設定時は定型ブリーフィング。 */

/** 今日の予定・タスクを LLM 用のテキスト文脈にする */
async function secretaryContext() {
  const creds = loadGoogleCreds();
  const tok = loadGoogleToken();
  if (!creds || !tok || !tok.refresh_token) {
    return { linked: false, text: 'Google カレンダー / ToDo は未連携のため、今日の予定・タスク情報はありません。' };
  }
  let a;
  try {
    a = await fetchAgenda();
  } catch (e) {
    return { linked: false, text: `(予定・タスクの取得に失敗しました: ${String(e.message).slice(0, 120)})` };
  }

  const lines = [`日付: ${a.date}`, '', '■ 今日の予定'];
  if (!a.events.length) lines.push('  なし');
  for (const e of a.events) {
    const time = e.allDay ? '終日' : `${hm(e.start)}–${hm(e.end)}`;
    let l = `  - ${time} ${e.summary}`;
    if (e.location) l += ` @${e.location}`;
    if (e.meetLink) l += '（オンライン/Meet）';
    lines.push(l);
  }
  lines.push('', '■ タスク (ToDo)');
  let any = false;
  for (const list of a.taskLists) {
    for (const t of list.tasks) {
      any = true;
      const box = t.completed ? '[完了]' : '[未]';
      let l = `  ${box} ${t.title}`;
      if (t.due) l += `（期日 ${t.due}${!t.completed && t.due < a.date ? ' ※期限切れ' : ''}）`;
      if (t.notes) l += ` — ${String(t.notes).slice(0, 60)}`;
      lines.push(l);
    }
  }
  if (!any) lines.push('  なし');
  return { linked: true, text: lines.join('\n'), data: a };
}

function secretarySystemPrompt(ctxText) {
  const now = new Date();
  const nowStr = `${localDateStr(now)} ${hm(now)}`;
  return `あなたはユーザー専属の有能な日本語の秘書です。現在時刻は ${nowStr} です。
下記「今日の情報」(Google カレンダーの予定と Google ToDo のタスク) を踏まえてユーザーの相談に答えます。

方針:
- 今日の予定の要点、優先してやるべきタスク、締め切り、各予定に向けて準備すべきものを、具体的かつ実務的に助言する。
- 簡潔に。要点は短い箇条書き(・)でまとめ、前置きや定型的な挨拶は最小限にする。
- 時刻・期日は正確に扱い、「進行中」「次の予定」「期限切れ」を意識する。
- 情報にないことは推測で断定せず「情報にありません」と述べる。Markdown の見出し(#)は使わない。
- 常に日本語で回答する。

【今日の情報】
${ctxText}`;
}

/** API キー未設定時の定型ブリーフィング */
function fallbackSecretaryReply(ctx) {
  const note = 'ℹ️ Anthropic API キーが未設定のため、自由な会話の代わりに今日の情報をまとめました。'
    + '(server.js を起動する環境で ANTHROPIC_API_KEY を設定するか、anthropic-credentials.json に {"apiKey":"sk-ant-..."} を置くと、秘書と自由に会話できます。)\n\n';
  if (!ctx.linked || !ctx.data) {
    return note + ctx.text + '\n\nGoogle と連携すると、今日の予定・タスクに基づいた助言ができます。';
  }
  const a = ctx.data;
  const now = Date.now();
  const timed = a.events.filter((e) => !e.allDay);
  const nowEv = timed.find((e) => Date.parse(e.start) <= now && Date.parse(e.end) > now);
  const nextEv = timed.find((e) => Date.parse(e.start) > now);
  const out = [`【${a.date} の予定】 ${a.events.length}件`];
  if (nowEv) out.push(`・進行中: ${nowEv.summary}(〜${hm(nowEv.end)})`);
  if (nextEv) out.push(`・次: ${hm(nextEv.start)} ${nextEv.summary}`);
  for (const e of a.events) {
    out.push(`  - ${e.allDay ? '終日' : `${hm(e.start)}–${hm(e.end)}`} ${e.summary}`
      + (e.meetLink ? ' 🎥' : '') + (e.location ? ` 📍${e.location}` : ''));
  }

  const todos = [];
  for (const l of a.taskLists) for (const t of l.tasks) if (!t.completed) todos.push(t);
  todos.sort((x, y) => (x.due || '9999').localeCompare(y.due || '9999'));
  out.push('', `【やるべきタスク】 残り ${todos.length}件`);
  if (!todos.length) out.push('・未処理のタスクはありません。');
  for (const t of todos) {
    const over = t.due && t.due < a.date;
    out.push(`・${t.title}` + (t.due ? `(期日 ${t.due}${over ? ' ⚠期限切れ' : ''})` : ''));
  }

  const hints = [];
  if (timed.some((e) => e.meetLink)) hints.push('オンライン会議あり → 事前に接続確認・共有資料の準備を。');
  if (timed.some((e) => e.location)) hints.push('外出/移動を伴う予定あり → 出発時刻と持ち物の確認を。');
  if (todos.some((t) => t.due && t.due < a.date)) hints.push('期限切れタスクあり → 今日、最優先で対応を。');
  if (hints.length) { out.push('', '【準備・アドバイス】'); for (const h of hints) out.push('・' + h); }
  return note + out.join('\n');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  /* ── Google 連携 ─────────────────────────── */
  if (url.pathname === '/api/agenda') {
    const creds = loadGoogleCreds();
    const tok = loadGoogleToken();
    if (!creds) { sendJson(res, 200, { configured: false, authorized: false }); return; }
    if (!tok || !tok.refresh_token) { sendJson(res, 200, { configured: true, authorized: false }); return; }
    fetchAgenda()
      .then((data) => sendJson(res, 200, { configured: true, authorized: true, ...data }))
      .catch((e) => {
        if (e.status === 401 || e.status === 403) {
          sendJson(res, 200, { configured: true, authorized: false, error: String(e.message) });
        } else {
          sendJson(res, 502, { configured: true, authorized: true, error: String(e.message) });
        }
      });
    return;
  }

  if (url.pathname === '/auth/google') {
    const creds = loadGoogleCreds();
    if (!creds) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('google-credentials.json がありません。README の手順で OAuth クライアントを作成してください。');
      return;
    }
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: creds.client_id,
      redirect_uri: `http://localhost:${PORT}/oauth2callback`,
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
    });
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  if (url.pathname === '/oauth2callback') {
    const code = url.searchParams.get('code');
    const creds = loadGoogleCreds();
    if (!code || !creds) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('認証コードがありません: ' + (url.searchParams.get('error') || 'code missing'));
      return;
    }
    fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        redirect_uri: `http://localhost:${PORT}/oauth2callback`,
        grant_type: 'authorization_code',
      }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.text()).slice(0, 300));
        return r.json();
      })
      .then((j) => {
        saveGoogleToken({
          refresh_token: j.refresh_token,
          access_token: j.access_token,
          expiry: Date.now() + (j.expires_in || 3600) * 1000,
          scope: j.scope,
        });
        agendaCache = { at: 0, data: null };
        res.writeHead(302, { Location: '/' });
        res.end();
      })
      .catch((e) => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Google 認証に失敗しました: ' + String(e.message));
      });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks/toggle') {
    readJsonBody(req)
      .then(({ listId, taskId, completed }) => {
        if (!listId || !taskId) throw new Error('listId / taskId が必要です');
        return gApi(
          `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify(completed
              ? { status: 'completed' }
              : { status: 'needsAction', completed: null }),
          });
      })
      .then((t) => { agendaCache = { at: 0, data: null }; sendJson(res, 200, { ok: true, task: t }); })
      .catch((e) => sendJson(res, e.status === 401 ? 401 : 500, { ok: false, error: String(e.message) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks/add') {
    readJsonBody(req)
      .then(({ listId, title, due }) => {
        if (!listId || !title) throw new Error('listId / title が必要です');
        const body = { title: String(title).slice(0, 200) };
        if (due) body.due = `${due}T00:00:00.000Z`; // Tasks API は日付のみ有効
        return gApi(
          `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`,
          { method: 'POST', body: JSON.stringify(body) });
      })
      .then((t) => { agendaCache = { at: 0, data: null }; sendJson(res, 200, { ok: true, task: t }); })
      .catch((e) => sendJson(res, e.status === 401 ? 401 : 500, { ok: false, error: String(e.message) }));
    return;
  }

  /* ── 秘書アシスタント ─────────────────────── */
  if (url.pathname === '/api/secretary/status') {
    const cfg = loadSecretaryConfig();
    const creds = loadGoogleCreds();
    const tok = loadGoogleToken();
    sendJson(res, 200, {
      configured: cfg.mode !== 'off',
      mode: cfg.mode,
      model: cfg.model,
      calendarLinked: !!(creds && tok && tok.refresh_token),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/secretary/chat') {
    readJsonBody(req)
      .then(async (body) => {
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const clean = msgs
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
        if (!clean.length || clean[clean.length - 1].role !== 'user') {
          throw new Error('ユーザーのメッセージがありません');
        }
        const ctx = await secretaryContext();
        const cfg = loadSecretaryConfig();
        const system = secretarySystemPrompt(ctx.text);

        if (cfg.mode === 'off') {
          sendJson(res, 200, { reply: fallbackSecretaryReply(ctx), fallback: true, linked: ctx.linked });
          return;
        }

        if (cfg.mode === 'cli') {
          try {
            const reply = await runClaudeCli({ cli: cfg.cli, model: cfg.model, system, prompt: flattenForCli(clean) });
            sendJson(res, 200, { reply: reply || '(応答がありませんでした)', provider: 'claude-cli', model: cfg.model, linked: ctx.linked });
          } catch (e) {
            // CLI 失敗時は定型ブリーフィングにフォールバック(理由を添える)
            sendJson(res, 200, {
              reply: `⚠️ Claude CLI を利用できませんでした(${String(e.message)})。\n`
                + 'サーバーを起動した端末で「claude」にログイン済みかご確認ください(未ログインなら claude を一度起動して /login)。\n\n'
                + fallbackSecretaryReply(ctx),
              fallback: true, linked: ctx.linked,
            });
          }
          return;
        }

        // cfg.mode === 'api'
        const ar = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: cfg.model,
            max_tokens: 1024,
            system,
            messages: clean,
          }),
        });
        if (!ar.ok) {
          const t = await ar.text();
          sendJson(res, 502, { error: `Anthropic API ${ar.status}: ${t.slice(0, 200)}` });
          return;
        }
        const j = await ar.json();
        const reply = (j.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
          .trim() || '(応答がありませんでした)';
        sendJson(res, 200, { reply, provider: 'api', model: cfg.model, linked: ctx.linked });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  if (url.pathname === '/api/data') {
    // ?local=1 はピアからの問い合わせ: 再帰的なピア取得を防ぐためローカルのみ返す
    const localOnly = url.searchParams.get('local') === '1';
    Promise.resolve(localOnly ? collect() : collectAll())
      .then((data) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      })
      .catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      });
    return;
  }

  // 静的ファイル配信
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const fp = path.join(PUBLIC_DIR, file);
  if (!fp.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`エラー: ポート ${PORT} は既に使用中です。`);
    console.error(`既にこのサーバーが起動している可能性があります → http://localhost:${PORT} を開いて確認してください。`);
    console.error(`  使用中のプロセス確認: lsof -ti:${PORT}   (Linux: ss -ltnp | grep ${PORT})`);
    console.error(`  停止して起動し直す:   kill $(lsof -ti:${PORT}) && node server.js`);
    console.error(`  別ポートで起動する:   PORT=4380 node server.js`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`AI Agents View: http://localhost:${PORT}`);
  console.log(`watching: ${PROJECTS_DIR}`);
});
