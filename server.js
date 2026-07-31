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
const DATA_DIR = path.join(__dirname, 'data');
const HUSTLER_DIR = path.join(DATA_DIR, 'hustler');
const HUSTLER_OUTPUTS_DIR = path.join(HUSTLER_DIR, 'outputs');
const HUSTLER_JOBS_PATH = path.join(HUSTLER_DIR, 'jobs.json');
const HUSTLER_REVENUE_PATH = path.join(HUSTLER_DIR, 'revenue.json');
const HUSTLER_CONFIG_PATH = path.join(__dirname, 'hustler-config.json');
const HUSTLER_WINDOW_MS = 5 * 60 * 60 * 1000;
const HUSTLER_CHECK_MS = 10 * 60 * 1000;
const HUSTLER_TOKEN_HEADROOM = 120000;

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

// ピア取得のタイムアウト(Tailscale 等の遅延に耐えるよう長めに)と
// 失敗時に直近の成功データを使うための猶予時間。
const PEER_TIMEOUT_MS = process.env.PEER_TIMEOUT_MS ? Number(process.env.PEER_TIMEOUT_MS) : 8000;
const PEER_STALE_MS = process.env.PEER_STALE_MS ? Number(process.env.PEER_STALE_MS) : 90000;
// ピアの取得結果キャッシュ: url -> { at(最終成功ms), data, ok(最終試行の成否), lastTry, error }
// 取得はバックグラウンドで定期実行し、/api/data はこのキャッシュを即座に返す。
const peerCache = new Map();
let peerRefreshing = false;

function fetchPeer(peer) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PEER_TIMEOUT_MS);
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

/** user メッセージが「実際の依頼(テキスト発話)」か。tool_result / 画像のみ / 空 は false */
function isUserPrompt(message) {
  if (!message || message.role !== 'user') return false;
  const c = message.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  if (c.some((b) => b && b.type === 'tool_result')) return false;
  return c.some((b) => b && b.type === 'text' && String(b.text || '').trim().length > 0);
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
    promptCount: 0,      // ユーザーが実際に打った依頼(tool_result/画像のみのターンは除く)
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
  Object.defineProperty(summary, 'usageEvents', { value: [], enumerable: false, writable: true });

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
      if (!o.isSidechain && isUserPrompt(o.message)) summary.promptCount++;
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
        const outputTokens = m.usage.output_tokens || 0;
        const baseInputTokens = m.usage.input_tokens || 0;
        const cacheCreationInputTokens = m.usage.cache_creation_input_tokens || 0;
        const cacheReadInputTokens = m.usage.cache_read_input_tokens || 0;
        const inputTokens = baseInputTokens + cacheCreationInputTokens + cacheReadInputTokens;
        summary.outputTokens += outputTokens;
        summary.inputTokens += inputTokens;
        if (ts) {
          const atMs = Date.parse(ts);
          if (Number.isFinite(atMs) && (inputTokens || outputTokens)) {
            summary.usageEvents.push({
              atMs,
              inputTokens,
              outputTokens,
              baseInputTokens,
              cacheCreationInputTokens,
              cacheReadInputTokens,
            });
          }
        }
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
// ピアをバックグラウンドで取得し peerCache を更新する。遅いピアがいても
// /api/data の応答は待たされない(応答は下の collectAll がキャッシュを即返す)。
async function refreshPeers() {
  if (peerRefreshing) return;
  peerRefreshing = true;
  try {
    const peers = loadPeers();
    await Promise.allSettled(peers.map(async (peer) => {
      const now = Date.now();
      try {
        const d = (await fetchPeer(peer)) || {};
        peerCache.set(peer.url, { at: now, data: d, ok: true, lastTry: now });
      } catch (e) {
        const prev = peerCache.get(peer.url) || {};
        peerCache.set(peer.url, { ...prev, ok: false, lastTry: now, error: String(e && e.message || e).slice(0, 120) });
      }
    }));
  } finally {
    peerRefreshing = false;
  }
}

// ローカル集計に、キャッシュ済みのピアデータをマージして即座に返す(await しない)。
function collectAll() {
  const data = collect();
  const peers = loadPeers();
  if (peers.length === 0) return data;

  data.peers = [];
  const now = Date.now();
  for (const peer of peers) {
    const c = peerCache.get(peer.url);
    // 直近の成功データが猶予内なら利用。最後の取得が失敗なら stale 表示。
    if (c && c.data && now - c.at < PEER_STALE_MS) {
      const stale = !c.ok;
      const host = peer.label || c.data.host || new URL(peer.url).hostname;
      for (const p of c.data.projects || []) {
        p.host = host;
        p.remote = true;
        p.id = `${host}:${p.dirName}`;
        data.projects.push(p);
      }
      data.peers.push({ url: peer.url, host, ok: true, stale, projects: (c.data.projects || []).length });
    } else {
      data.peers.push({ url: peer.url, host: peer.label, ok: false, error: (c && c.error) || 'offline' });
    }
  }
  data.projects.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
  // 取得を待たずにバックグラウンド更新をキック
  refreshPeers();
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
  const seen = new Set();
  for (const p of list) {
    seen.add(p);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const p = path.join(dir, 'claude');
    if (seen.has(p)) continue;
    seen.add(p);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
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

/* ── 探検家(トピック調査)────────────────────
 * 指定トピックのニュース・論文を Web 検索で調べ、hot トピック/注目論文/
 * 分野の潮流をまとめる。実行手段は秘書と同じ設定(cli/api)を流用するが、
 * 秘書と違い Web 検索を有効化する点が異なる。結果は explorer-state.json に
 * 保存し、週に一度(月曜9時)自動で更新する。 */
const EXPLORER_STATE_PATH = path.join(__dirname, 'explorer-state.json');
const EXPLORER_MAX_TOPICS = 8;
let explorerRunning = false; // 多重実行防止(オンデマンド + 週次で共有)

function loadExplorerState() {
  try {
    const j = JSON.parse(fs.readFileSync(EXPLORER_STATE_PATH, 'utf8'));
    return {
      topics: Array.isArray(j.topics) ? j.topics.filter((t) => typeof t === 'string') : [],
      reports: (j.reports && typeof j.reports === 'object') ? j.reports : {},
      lastWeeklyRun: Number(j.lastWeeklyRun) || 0,
    };
  } catch { return { topics: [], reports: {}, lastWeeklyRun: 0 }; }
}
function saveExplorerState(s) {
  try { fs.writeFileSync(EXPLORER_STATE_PATH, JSON.stringify(s, null, 2)); }
  catch (e) { console.error('explorer-state 保存失敗:', e.message); }
}

/* 秘書チャット履歴のサーバー保存(PC・スマホなど端末間で共有)。約1日で失効。 */
const SECRETARY_STATE_PATH = path.join(__dirname, 'secretary-state.json');
const SECRETARY_TTL_MS = 24 * 60 * 60 * 1000; // 約1日
function sanitizeSecretaryMsgs(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-40)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000), hidden: !!m.hidden }));
}
function loadSecretaryHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(SECRETARY_STATE_PATH, 'utf8'));
    if (!j || !Array.isArray(j.messages) || !j.at) return { messages: [], at: 0 };
    if ((Date.now() - Number(j.at)) > SECRETARY_TTL_MS) return { messages: [], at: 0 };
    return { messages: sanitizeSecretaryMsgs(j.messages), at: Number(j.at) };
  } catch { return { messages: [], at: 0 }; }
}
function saveSecretaryHistory(messages) {
  const clean = sanitizeSecretaryMsgs(messages);
  try { fs.writeFileSync(SECRETARY_STATE_PATH, JSON.stringify({ at: Date.now(), messages: clean }, null, 2)); }
  catch (e) { console.error('secretary-state 保存失敗:', e.message); }
  return clean;
}

/** 探検家の実行設定。基本は秘書設定を流用し、EXPLORER_* があれば上書きする */
function loadExplorerConfig() {
  const base = loadSecretaryConfig();
  const provider = process.env.EXPLORER_PROVIDER || null;
  const model = process.env.EXPLORER_MODEL || null;
  let mode = base.mode;
  if (provider === 'off') mode = 'off';
  else if (provider === 'api') mode = base.apiKey ? 'api' : 'off';
  else if (provider === 'cli') mode = base.cli ? 'cli' : 'off';
  else if (provider === 'auto') mode = base.apiKey ? 'api' : (base.cli ? 'cli' : 'off');
  return { mode, apiKey: base.apiKey, model: model || base.model, cli: base.cli };
}

const DEFAULT_HUSTLER_CONFIG = {
  enabled: false,
  activeHours: '22-8',
  idleMinutes: 15,
  tokenBudget5h: 2000000,
  maxRunsPerDay: 8,
};

let hustlerRunning = false; // 多重実行防止(手動 + 定期実行で共有)

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureHustlerStorage() {
  ensureDir(HUSTLER_OUTPUTS_DIR);
  if (!fs.existsSync(HUSTLER_JOBS_PATH)) fs.writeFileSync(HUSTLER_JOBS_PATH, '[]\n');
  if (!fs.existsSync(HUSTLER_REVENUE_PATH)) fs.writeFileSync(HUSTLER_REVENUE_PATH, '[]\n');
  if (!fs.existsSync(HUSTLER_CONFIG_PATH)) {
    fs.writeFileSync(HUSTLER_CONFIG_PATH, JSON.stringify(DEFAULT_HUSTLER_CONFIG, null, 2) + '\n');
  }
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readJsonFileSafe(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function parseClockMinutes(raw) {
  const m = String(raw).trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2] || 0);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || mm < 0 || mm > 59) return null;
  if (hh === 24 && mm === 0) return 24 * 60;
  if (hh < 0 || hh > 23) return null;
  return hh * 60 + mm;
}

function normalizeActiveHours(raw) {
  const src = typeof raw === 'string' ? raw : '';
  const parts = src.split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^([^-\s]+)\s*-\s*([^-\s]+)$/);
    if (!m) continue;
    const start = parseClockMinutes(m[1]);
    const end = parseClockMinutes(m[2]);
    if (start == null || end == null) continue;
    out.push(`${m[1].trim()}-${m[2].trim()}`);
  }
  return out.join(',') || DEFAULT_HUSTLER_CONFIG.activeHours;
}

function isWithinActiveHours(spec, now = new Date()) {
  const parts = String(spec || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const part of parts) {
    const m = part.match(/^([^-\s]+)\s*-\s*([^-\s]+)$/);
    if (!m) continue;
    const start = parseClockMinutes(m[1]);
    const end = parseClockMinutes(m[2]);
    if (start == null || end == null) continue;
    if (start === end) return true;
    if (start < end && cur >= start && cur < end) return true;
    if (start > end && (cur >= start || cur < end)) return true;
  }
  return false;
}

function sanitizeHustlerConfig(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return {
    enabled: !!src.enabled,
    activeHours: normalizeActiveHours(src.activeHours),
    idleMinutes: Math.max(1, Math.min(180, Number(src.idleMinutes) || DEFAULT_HUSTLER_CONFIG.idleMinutes)),
    tokenBudget5h: Math.max(10000, Math.min(20000000, Math.round(Number(src.tokenBudget5h) || DEFAULT_HUSTLER_CONFIG.tokenBudget5h))),
    maxRunsPerDay: Math.max(1, Math.min(48, Math.round(Number(src.maxRunsPerDay) || DEFAULT_HUSTLER_CONFIG.maxRunsPerDay))),
  };
}

function loadHustlerConfig() {
  const stored = readJsonFileSafe(HUSTLER_CONFIG_PATH, DEFAULT_HUSTLER_CONFIG);
  return sanitizeHustlerConfig({ ...DEFAULT_HUSTLER_CONFIG, ...stored });
}

function saveHustlerConfig(config) {
  const clean = sanitizeHustlerConfig(config);
  fs.writeFileSync(HUSTLER_CONFIG_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

function normalizeHustlerJob(job) {
  if (!job || typeof job !== 'object') return null;
  const type = ['article_draft', 'sns_pack', 'idea_research', 'custom'].includes(job.type) ? job.type : 'custom';
  return {
    id: typeof job.id === 'string' ? job.id : makeId('job'),
    type,
    topic: typeof job.topic === 'string' ? job.topic.slice(0, 500) : '',
    prompt: typeof job.prompt === 'string' ? job.prompt.slice(0, 12000) : '',
    status: ['pending', 'running', 'done', 'error'].includes(job.status) ? job.status : 'pending',
    createdAt: typeof job.createdAt === 'string' ? job.createdAt : new Date().toISOString(),
    startedAt: typeof job.startedAt === 'string' ? job.startedAt : null,
    finishedAt: typeof job.finishedAt === 'string' ? job.finishedAt : null,
    outputId: typeof job.outputId === 'string' ? job.outputId : null,
    error: typeof job.error === 'string' ? job.error.slice(0, 500) : null,
  };
}

function loadHustlerJobs() {
  ensureHustlerStorage();
  const arr = readJsonFileSafe(HUSTLER_JOBS_PATH, []);
  return Array.isArray(arr) ? arr.map(normalizeHustlerJob).filter(Boolean) : [];
}

function saveHustlerJobs(jobs) {
  ensureHustlerStorage();
  fs.writeFileSync(HUSTLER_JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
}

function resetStaleHustlerJobs() {
  const jobs = loadHustlerJobs();
  let changed = false;
  for (const job of jobs) {
    if (job.status === 'running') {
      job.status = 'pending';
      job.error = 'サーバー再起動により待機へ戻しました';
      changed = true;
    }
  }
  if (changed) saveHustlerJobs(jobs);
}

function loadHustlerRevenue() {
  ensureHustlerStorage();
  const arr = readJsonFileSafe(HUSTLER_REVENUE_PATH, []);
  return Array.isArray(arr)
    ? arr
      .filter((x) => x && typeof x === 'object')
      .map((x) => ({
        id: typeof x.id === 'string' ? x.id : makeId('rev'),
        date: typeof x.date === 'string' ? x.date.slice(0, 10) : localDateStr(),
        amount: Number(x.amount) || 0,
        memo: typeof x.memo === 'string' ? x.memo.slice(0, 200) : '',
      }))
    : [];
}

function saveHustlerRevenue(items) {
  ensureHustlerStorage();
  fs.writeFileSync(HUSTLER_REVENUE_PATH, JSON.stringify(items, null, 2) + '\n');
}

function listLocalSessions({ minMtimeMs = 0, skipPrivate = false } = {}) {
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch { return []; }
  const out = [];
  for (const d of dirs) {
    if (skipPrivate && d.name.startsWith('-private')) continue;
    const projDir = path.join(PROJECTS_DIR, d.name);
    let files;
    try { files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(projDir, f);
      let stat;
      try { stat = fs.statSync(fp); } catch { continue; }
      if (stat.mtimeMs < minMtimeMs) continue;
      const session = parseSession(fp, stat);
      const lastMs = session.lastTs ? Date.parse(session.lastTs) : stat.mtimeMs;
      out.push({ dirName: d.name, filePath: fp, stat, session, lastMs });
    }
  }
  return out;
}

function getWindow5hUsageStats() {
  const cutoff = Date.now() - HUSTLER_WINDOW_MS;
  const sessions = listLocalSessions({ minMtimeMs: cutoff });
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  const contributing = new Set();
  for (const item of sessions) {
    for (const ev of item.session.usageEvents || []) {
      if (ev.atMs >= cutoff) {
        inputTokens += (ev.baseInputTokens || 0) + (ev.cacheCreationInputTokens || 0);
        outputTokens += ev.outputTokens || 0;
        cacheReadTokens += ev.cacheReadInputTokens || 0;
        contributing.add(`${item.dirName}:${item.session.sessionId}`);
      }
    }
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens,
    sessions: contributing.size,
  };
}

function getLatestLocalActivityMs() {
  let latest = 0;
  for (const item of listLocalSessions()) {
    if (item.lastMs && item.lastMs > latest) latest = item.lastMs;
  }
  return latest;
}

function loadHustlerProviderConfig() {
  const base = loadSecretaryConfig();
  const provider = process.env.HUSTLER_PROVIDER || 'auto';
  const model = process.env.HUSTLER_MODEL || base.model || DEFAULT_SECRETARY_MODEL;
  let mode;
  if (provider === 'off') mode = 'off';
  else if (provider === 'api') mode = base.apiKey ? 'api' : 'off';
  else if (provider === 'cli') mode = base.cli ? 'cli' : 'off';
  else mode = base.cli ? 'cli' : (base.apiKey ? 'api' : 'off'); // auto: CLI 優先
  return { mode, apiKey: base.apiKey, model, cli: base.cli };
}

async function runClaudeApiText({ apiKey, model, system, prompt, maxTokens = 2200 }) {
  const ar = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!ar.ok) throw new Error(`Anthropic API ${ar.status}: ${(await ar.text()).slice(0, 200)}`);
  const j = await ar.json();
  return (j.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

function pickExplorerContext(topic) {
  const trimmed = String(topic || '').trim();
  if (!trimmed) return [];
  const reports = loadExplorerState().reports || {};
  const hits = [];
  for (const [name, info] of Object.entries(reports)) {
    if (!info || !info.report) continue;
    if (name === trimmed || name.includes(trimmed) || trimmed.includes(name)) {
      hits.push({ topic: name, report: info.report, at: info.at || 0 });
    }
  }
  hits.sort((a, b) => b.at - a.at);
  return hits.slice(0, 2);
}

function hustlerSystemPrompt() {
  const now = new Date();
  return `あなたはユーザーの遊休時間を使って収益化可能な成果物を作る、日本語の実務型「商人(内職)エージェント」です。現在時刻は ${localDateStr(now)} ${hm(now)} です。

方針:
- すぐ再利用・販売・投稿できる成果物を優先する。
- 内容は具体的で、アウトラインだけで終わらせず最低限の本文まで書く。
- 情報が不足する場合は、与えられた文脈から妥当な前提を置いて前へ進める。ただし断定しすぎない。
- 前置きは短く、成果物本体を Markdown でそのまま出力する。
- 常に日本語で出力する。`;
}

function buildHustlerJobPrompt(job) {
  const subject = (job.topic || job.prompt || '').trim();
  const explorerBits = job.type === 'article_draft' ? pickExplorerContext(subject) : [];
  const explorerText = explorerBits.length
    ? `\n\n参考に使える保存済みの探検家レポート:\n${explorerBits.map((x) => `### ${x.topic}\n${x.report}`).join('\n\n')}`
    : '';
  if (job.type === 'article_draft') {
    return {
      prompt: `テーマ: ${subject || '未指定'}

Zenn / 技術ブログ向けの Markdown 記事ドラフトを作ってください。必ず次の順番で構成してください。

# タイトル案
- 3案

# 見出し構成
- H2/H3 レベルで、読み進めやすい構成

# 本文
- そのまま下書きとして編集できる分量まで書く
- 具体例、背景、読者が得るメリット、最後のまとめまで含める
- 読者は実務で使える知見を求めるエンジニアや個人開発者を想定する

トーン:
- 実務的で読みやすい
- 誇張しすぎない
- 箇条書きに逃げず、本文は段落としてしっかり書く${explorerText}`,
      useResearch: false,
    };
  }
  if (job.type === 'sns_pack') {
    return {
      prompt: `題材: ${subject || '未指定'}

次の2点を Markdown で作成してください。

# X投稿案
- 5本
- それぞれ切り口を変える
- フック、要点、CTA を短く入れる
- 必要なら絵文字は最小限

# note紹介文
- 記事や企画の導入として使える 300〜500字程度
- 読み手が続きを見たくなる流れにする

入力が記事本文の場合は要約して活用し、トピックだけの場合は投稿向けの切り口を自分で補ってください。`,
      useResearch: false,
    };
  }
  if (job.type === 'idea_research') {
    return {
      prompt: `テーマ: ${subject || '未指定'}

収益化ネタのリサーチ結果を Markdown でまとめてください。必ず次の見出しを使ってください。

## 需要
## 競合
## 狙い目の切り口
## まずやること

- 需要は誰のどんな悩みかまで具体化する
- 競合は強み/弱みも短く整理する
- 切り口は差別化案を3つ以上
- 次アクションは今日から着手できる粒度にする`,
      useResearch: true,
    };
  }
  return {
    prompt: subject || '収益化につながる日本語の Markdown 成果物を1つ作成してください。',
    useResearch: false,
  };
}

function outputFrontMatter(job, createdAt) {
  const lines = [
    '---',
    `type: ${job.type}`,
    `topic: ${JSON.stringify(job.topic || job.prompt || '')}`,
    `createdAt: ${createdAt}`,
    `jobId: ${job.id}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

function saveHustlerOutput(job, content) {
  ensureHustlerStorage();
  const outputId = makeId('out');
  const createdAt = new Date().toISOString();
  const body = outputFrontMatter(job, createdAt) + String(content || '').trim() + '\n';
  fs.writeFileSync(path.join(HUSTLER_OUTPUTS_DIR, `${outputId}.md`), body);
  return { outputId, createdAt };
}

function parseOutputFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let meta = {};
  let body = raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      meta[key] = value.startsWith('"') ? JSON.parse(value) : value;
    }
  }
  return { meta, body };
}

function listHustlerOutputs() {
  ensureHustlerStorage();
  let files = [];
  try { files = fs.readdirSync(HUSTLER_OUTPUTS_DIR).filter((f) => f.endsWith('.md')); } catch { return []; }
  const out = [];
  for (const file of files) {
    const filePath = path.join(HUSTLER_OUTPUTS_DIR, file);
    try {
      const { meta, body } = parseOutputFile(filePath);
      out.push({
        id: file.replace(/\.md$/, ''),
        type: meta.type || 'custom',
        topic: meta.topic || '',
        createdAt: meta.createdAt || new Date(fs.statSync(filePath).mtimeMs).toISOString(),
        jobId: meta.jobId || null,
        preview: body.trim().split('\n').find(Boolean)?.slice(0, 120) || '',
      });
    } catch { /* ignore broken file */ }
  }
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return out;
}

function getHustlerOutput(id) {
  if (!/^[a-z0-9-]+$/i.test(id || '')) return null;
  const filePath = path.join(HUSTLER_OUTPUTS_DIR, `${id}.md`);
  if (!fs.existsSync(filePath)) return null;
  const { meta, body } = parseOutputFile(filePath);
  return {
    id,
    type: meta.type || 'custom',
    topic: meta.topic || '',
    createdAt: meta.createdAt || null,
    jobId: meta.jobId || null,
    body,
  };
}

function summarizeRevenueByMonth(items) {
  const map = new Map();
  for (const item of items) {
    const month = String(item.date || '').slice(0, 7);
    if (!month) continue;
    map.set(month, (map.get(month) || 0) + (Number(item.amount) || 0));
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, total]) => ({ month, total }));
}

function getHustlerStatus() {
  const config = loadHustlerConfig();
  const window5h = getWindow5hUsageStats();
  const lastActivityMs = getLatestLocalActivityMs();
  const idle = !lastActivityMs || (Date.now() - lastActivityMs) >= config.idleMinutes * 60 * 1000;
  const withinHours = isWithinActiveHours(config.activeHours);
  const jobs = loadHustlerJobs();
  const today = localDateStr();
  const runsToday = jobs.filter((j) => j.startedAt && String(j.startedAt).slice(0, 10) === today).length;
  const pendingJobs = jobs.filter((j) => j.status === 'pending').length;
  const lastRun = jobs
    .map((j) => j.finishedAt || j.startedAt || '')
    .filter(Boolean)
    .sort()
    .pop() || null;
  const provider = loadHustlerProviderConfig();
  const canRun = !!(
    config.enabled &&
    pendingJobs > 0 &&
    !hustlerRunning &&
    !explorerRunning &&
    provider.mode !== 'off' &&
    withinHours &&
    idle &&
    (window5h.totalTokens + HUSTLER_TOKEN_HEADROOM) < config.tokenBudget5h &&
    runsToday < config.maxRunsPerDay
  );
  return {
    enabled: config.enabled,
    activeHours: config.activeHours,
    window5h,
    tokenBudget5h: config.tokenBudget5h,
    idleMinutes: config.idleMinutes,
    idle,
    withinHours,
    runsToday,
    maxRunsPerDay: config.maxRunsPerDay,
    canRun,
    pendingJobs,
    lastRun,
    running: hustlerRunning,
    mode: provider.mode,
  };
}

async function executeHustlerJob(jobId) {
  if (hustlerRunning) throw new Error('別の内職ジョブを実行中です。');
  if (explorerRunning) throw new Error('探検家が調査中のため、少し待ってから実行してください。');
  const cfg = loadHustlerProviderConfig();
  if (cfg.mode === 'off') {
    throw new Error('商人の実行には Claude CLI か Anthropic API キーが必要です。');
  }

  const jobs = loadHustlerJobs();
  const idx = jobs.findIndex((j) => j.id === jobId);
  if (idx < 0) throw new Error('ジョブが見つかりません');
  if (jobs[idx].status === 'running') throw new Error('このジョブはすでに実行中です');

  jobs[idx] = {
    ...jobs[idx],
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  saveHustlerJobs(jobs);

  hustlerRunning = true;
  try {
    const job = jobs[idx];
    const task = buildHustlerJobPrompt(job);
    let content;
    if (task.useResearch && cfg.mode === 'api') {
      content = await runResearchApi({ apiKey: cfg.apiKey, model: cfg.model, prompt: task.prompt });
    } else if (task.useResearch && cfg.mode === 'cli') {
      content = await runResearchCli({ cli: cfg.cli, model: cfg.model, prompt: task.prompt });
    } else if (cfg.mode === 'cli') {
      content = await runClaudeCli({ cli: cfg.cli, model: cfg.model, system: hustlerSystemPrompt(), prompt: task.prompt });
    } else {
      content = await runClaudeApiText({ apiKey: cfg.apiKey, model: cfg.model, system: hustlerSystemPrompt(), prompt: task.prompt });
    }
    const saved = saveHustlerOutput(job, content || '(成果物が空でした)');
    const nextJobs = loadHustlerJobs();
    const nextIdx = nextJobs.findIndex((j) => j.id === job.id);
    if (nextIdx >= 0) {
      nextJobs[nextIdx] = {
        ...nextJobs[nextIdx],
        status: 'done',
        finishedAt: saved.createdAt,
        outputId: saved.outputId,
        error: null,
      };
      saveHustlerJobs(nextJobs);
      return nextJobs[nextIdx];
    }
    return { ...job, status: 'done', finishedAt: saved.createdAt, outputId: saved.outputId };
  } catch (e) {
    const nextJobs = loadHustlerJobs();
    const nextIdx = nextJobs.findIndex((j) => j.id === jobId);
    if (nextIdx >= 0) {
      nextJobs[nextIdx] = {
        ...nextJobs[nextIdx],
        status: 'error',
        finishedAt: new Date().toISOString(),
        error: String(e.message || e).slice(0, 500),
      };
      saveHustlerJobs(nextJobs);
    }
    throw e;
  } finally {
    hustlerRunning = false;
  }
}

async function maybeRunHustlerScheduled() {
  const status = getHustlerStatus();
  if (!status.canRun) return null;
  const jobs = loadHustlerJobs().filter((j) => j.status === 'pending');
  if (!jobs.length) return null;
  jobs.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  console.log(`[hustler] 定期実行を開始: ${jobs[0].id} (${jobs[0].type})`);
  return executeHustlerJob(jobs[0].id);
}

function researchPrompt(topic) {
  return `あなたは「${topic}」分野を追う調査担当です。Web 検索を複数回おこない、直近1〜2週間の最新情報を十分に調べたうえで、日本語の Markdown レポートにまとめてください。

必ず次の3セクションを見出し(## )で構成し、各セクションを充実させてください:
## 🔥 hot なトピック
いま盛り上がっている話題・ニュースを最低4件、各1〜2行で。
## 📄 注目の論文
arXiv などの新着・話題の論文を最低4本、「タイトル — 要点(著者/所属)」の形で。可能な限り [タイトル](URL) のリンクを付ける。
## 🌊 分野の潮流
この分野で進んでいる大きな流れ・トレンドを最低3件、簡潔に。

- 各セクションで指定した件数を必ず満たすこと。情報が足りなければ追加で Web 検索する。
- 事実に基づき、憶測は避ける。各項目に可能な限り出典リンク([表示テキスト](URL))を付ける。
- 前置きや結びの挨拶は不要。`;
}

/** CLI で Web 検索を許可して調査(タイムアウト180秒) */
function runResearchCli({ cli, model, prompt }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--model', model,
      '--output-format', 'json',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      // 秘書と違い Web 検索/取得を許可(調査用途)
      '--allowedTools', 'WebSearch', 'WebFetch',
    ];
    let child;
    try { child = spawn(cli || 'claude', args, { env: process.env, cwd: os.tmpdir() }); }
    catch (e) { reject(new Error('起動失敗: ' + e.message)); return; }
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('タイムアウト(180秒)')); }, 180e3);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('起動失敗: ' + e.message)); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(String(j.result || 'CLI エラー').slice(0, 200)));
        resolve(String(j.result || '').trim());
      } catch { reject(new Error((err || out || '応答なし').slice(0, 200))); }
    });
  });
}

/** API で web_search ツールを付けて調査 */
async function runResearchApi({ apiKey, model, prompt }) {
  const ar = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }),
  });
  if (!ar.ok) throw new Error(`Anthropic API ${ar.status}: ${(await ar.text()).slice(0, 200)}`);
  const j = await ar.json();
  return (j.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

/** トピックを調査してレポートを返し、結果を explorer-state に保存する */
async function doResearch(topic) {
  const cfg = loadExplorerConfig();
  const prompt = researchPrompt(topic);
  let report, provider;
  if (cfg.mode === 'api') {
    report = await runResearchApi({ apiKey: cfg.apiKey, model: cfg.model, prompt });
    provider = 'api';
  } else if (cfg.mode === 'cli') {
    report = await runResearchCli({ cli: cfg.cli, model: cfg.model, prompt });
    provider = 'claude-cli';
  } else {
    throw new Error('調査には Claude CLI(サブスク)か Anthropic API キーが必要です。秘書アシスタントと同じ設定で有効化できます。');
  }
  report = report || '(調査結果が空でした)';
  const st = loadExplorerState();
  st.reports[topic] = { report, at: Date.now(), provider };
  if (!st.topics.includes(topic)) st.topics.unshift(topic);
  st.topics = st.topics.slice(0, EXPLORER_MAX_TOPICS);
  saveExplorerState(st);
  return { topic, report, at: st.reports[topic].at, provider };
}

/** 直近の「月曜9:00」を跨いでいたら、保存トピックを順次調査する */
async function checkWeekly() {
  if (explorerRunning || hustlerRunning) return;
  const st = loadExplorerState();
  if (!st.topics.length) return;
  const now = new Date();
  const boundary = new Date(now);
  boundary.setHours(9, 0, 0, 0);
  const backToMon = (boundary.getDay() + 6) % 7; // 月曜(1)までの日数
  boundary.setDate(boundary.getDate() - backToMon);
  const boundaryMs = boundary.getTime();
  // 初回(未実行)は即時の一斉調査や手動調査との競合を避けるため、
  // 過去分を遡って実行せず基準時刻だけ記録して次の月曜を待つ。
  if (!st.lastWeeklyRun) {
    st.lastWeeklyRun = now.getTime();
    saveExplorerState(st);
    return;
  }
  if (!(st.lastWeeklyRun < boundaryMs && boundaryMs <= now.getTime())) return;

  explorerRunning = true;
  console.log(`[explorer] 週次調査を開始: ${st.topics.join(', ')}`);
  try {
    for (const t of st.topics) {
      try { await doResearch(t); console.log(`[explorer] 完了: ${t}`); }
      catch (e) { console.error(`[explorer] 失敗(${t}): ${e.message}`); }
    }
  } finally {
    const s2 = loadExplorerState();
    s2.lastWeeklyRun = Date.now();
    saveExplorerState(s2);
    explorerRunning = false;
  }
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

function mapEvent(e) {
  return {
    id: e.id,
    summary: e.summary || '(無題)',
    allDay: !!(e.start && e.start.date),
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
    location: e.location || null,
    meetLink: e.hangoutLink || null,
  };
}

/** 指定期間のカレンダー予定を取得する(繰り返しは展開・開始時刻順) */
async function fetchCalendarEvents(timeMin, timeMax, maxResults = 100) {
  const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams({
    timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: String(maxResults),
  });
  const res = await gApi(url);
  return (res.items || []).filter((e) => e.status !== 'cancelled').map(mapEvent);
}

/** 1 リストのタスクを nextPageToken を辿って全件取得する */
async function fetchTasksPaged(listId, params) {
  const out = [];
  let pageToken = null, guard = 0;
  do {
    const p = new URLSearchParams(params);
    if (pageToken) p.set('pageToken', pageToken);
    const r = await gApi(
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks?` + p);
    out.push(...(r.items || []));
    pageToken = r.nextPageToken;
  } while (pageToken && ++guard < 20);
  return out;
}

/**
 * 全 ToDo リストのタスクを取得する。
 * 既定(opts なし)は「未完了すべて + 今日完了分」(オフィス表示/当日ブリーフィング用)。
 * opts.completedSinceMs を渡すと「未完了すべて + その時刻以降に完了したタスク」を集める。
 * 完了タスクは位置順 100 件上限に埋もれる恐れがあるため、completedMin + ページングで確実に取得する。
 */
async function fetchTaskLists(opts = {}) {
  const sinceMs = opts.completedSinceMs || null;
  const listRes = await gApi('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=20');
  const today = localDateStr();
  return Promise.all((listRes.items || []).map(async (l) => {
    let raw;
    if (sinceMs) {
      // 未完了(全件) と 期間内の完了タスク を別々に確実に取得してマージ
      const [inc, comp] = await Promise.all([
        fetchTasksPaged(l.id, { showCompleted: 'false', maxResults: '100' }),
        fetchTasksPaged(l.id, { showCompleted: 'true', showHidden: 'true', maxResults: '100',
          completedMin: new Date(sinceMs).toISOString() }),
      ]);
      const seen = new Set();
      raw = [];
      for (const t of [...inc, ...comp]) { if (t.id && !seen.has(t.id)) { seen.add(t.id); raw.push(t); } }
    } else {
      const tr = await gApi(
        `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(l.id)}/tasks?` +
        new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100' }));
      raw = tr.items || [];
    }
    const tasks = raw
      .filter((t) => t.title)
      .filter((t) => {
        if (t.status !== 'completed') return true;
        if (sinceMs) return !!t.completed && Date.parse(t.completed) >= sinceMs;
        return (t.completed || '').slice(0, 10) === today;
      })
      .map((t) => ({
        id: t.id,
        title: t.title,
        notes: t.notes || null,
        due: t.due ? t.due.slice(0, 10) : null,
        completed: t.status === 'completed',
        completedAt: t.completed || null,
      }));
    tasks.sort((a, b) => (a.completed === b.completed ? 0 : a.completed ? 1 : -1)
      || (a.due || '9999').localeCompare(b.due || '9999'));
    return { id: l.id, title: l.title, tasks };
  }));
}

/** 今日の予定 (カレンダー) + タスク (ToDo) を集める。30秒キャッシュ。 */
let agendaCache = { at: 0, data: null };
async function fetchAgenda() {
  if (agendaCache.data && Date.now() - agendaCache.at < 30e3) return agendaCache.data;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86400e3);
  const [events, taskLists] = await Promise.all([
    fetchCalendarEvents(dayStart, dayEnd, 50),
    fetchTaskLists(),
  ]);
  const data = { generatedAt: Date.now(), date: localDateStr(), events, taskLists };
  agendaCache = { at: Date.now(), data };
  return data;
}

/* ══════════ 秘書アシスタント ══════════
 * カレンダーの予定(過去〜先の一定期間)+ タスク (ToDo) を文脈として渡し、
 * 予定のまとめ・やるべきこと・準備の相談に答える。API キー未設定時は定型ブリーフィング。
 * 期間は SECRETARY_CAL_PAST_DAYS / SECRETARY_CAL_FUTURE_DAYS で調整可(既定 過去7日〜先14日)。 */
const SEC_PAST_DAYS = Math.max(0, Number(process.env.SECRETARY_CAL_PAST_DAYS || 7));
const SEC_FUTURE_DAYS = Math.max(1, Number(process.env.SECRETARY_CAL_FUTURE_DAYS || 14));
// 週報作成の材料として、過去に完了した ToDo タスクを何日分渡すか(既定 14 日)
const SEC_DONE_DAYS = Math.max(1, Number(process.env.SECRETARY_TASK_DONE_DAYS || 14));
// 週報・月次振り返りの材料として、Claude Code のセッション作業ログを何日分渡すか(既定 30 日)
const SEC_SESSION_DAYS = Math.max(1, Number(process.env.SECRETARY_SESSION_DAYS || 30));
// 文脈肥大を防ぐためのセッション表示上限(新しい順にこの件数まで。超過分は件数のみ通知)
const SEC_SESSION_MAX = Math.max(10, Number(process.env.SECRETARY_SESSION_MAX || 200));
// セッション作業ログを秘書に渡すか(既定 ON。SECRETARY_INCLUDE_SESSIONS=0 で無効)
const SEC_INCLUDE_SESSIONS = process.env.SECRETARY_INCLUDE_SESSIONS !== '0';

/**
 * 過去 days 日分の Claude Code セッションを走査し、週報の材料になる作業ログを返す。
 * 各セッションの ai-title・プロジェクト(cwd)・実依頼数・稼働時間帯を抽出する。
 * 巨大 jsonl を毎回開かないよう mtime で期間外ファイルを足切りし、parseSession のキャッシュを再利用する。
 * 一時セッション(-private* ディレクトリ)は対象外。
 */
function buildSessionDigest(days) {
  const now = Date.now();
  const cutoff = now - days * 86400e3;
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch { return []; }

  const out = [];
  for (const d of dirs) {
    if (d.name.startsWith('-private')) continue; // 一時 / SDK セッションは除外
    const projDir = path.join(PROJECTS_DIR, d.name);
    let files;
    try { files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(projDir, f);
      let stat;
      try { stat = fs.statSync(fp); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue; // 期間外は開かない(足切り)
      const s = parseSession(fp, stat);
      const lastMs = s.lastTs ? Date.parse(s.lastTs) : stat.mtimeMs;
      if (!lastMs || lastMs < cutoff) continue;
      if (!s.title && !s.promptCount) continue; // 空セッションは除外
      out.push({
        project: s.cwd ? path.basename(s.cwd) : d.name.replace(/^-/, '').split('-').pop(),
        title: s.title || '(無題セッション)',
        prompts: s.promptCount || 0,
        firstMs: s.firstTs ? Date.parse(s.firstTs) : lastMs,
        lastMs,
      });
    }
  }
  out.sort((a, b) => b.lastMs - a.lastMs); // 新しい順(上限で古い分を落とすため)
  return out;
}

const DOW_JA = '日月火水木金土';
function dowJa(dateStr) { return DOW_JA[new Date(dateStr + 'T00:00:00').getDay()]; }
function eventDateKey(e) { return e.allDay ? String(e.start).slice(0, 10) : localDateStr(new Date(e.start)); }
function relDayLabel(dateStr, today) {
  const diff = Math.round((new Date(dateStr + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400e3);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === 2) return '明後日';
  if (diff === -1) return '昨日';
  return diff > 0 ? `${diff}日後` : `${-diff}日前`;
}

/** 秘書用のデータ(広い期間の予定 + タスク)を取得する。30秒キャッシュ。 */
let secDataCache = { at: 0, data: null };
async function fetchSecretaryData() {
  if (secDataCache.data && Date.now() - secDataCache.at < 30e3) return secDataCache.data;
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const timeMin = new Date(todayStart.getTime() - SEC_PAST_DAYS * 86400e3);
  const timeMax = new Date(todayStart.getTime() + (SEC_FUTURE_DAYS + 1) * 86400e3);
  const completedSinceMs = todayStart.getTime() - SEC_DONE_DAYS * 86400e3;
  const [events, taskLists] = await Promise.all([
    fetchCalendarEvents(timeMin, timeMax, 250),
    fetchTaskLists({ completedSinceMs }),
  ]);
  let sessions = null;
  if (SEC_INCLUDE_SESSIONS) {
    try { sessions = buildSessionDigest(SEC_SESSION_DAYS); }
    catch { sessions = null; }
  }
  const data = { date: localDateStr(now), events, taskLists, sessions };
  secDataCache = { at: Date.now(), data };
  return data;
}

/** 予定(期間)・タスクを LLM 用のテキスト文脈にする */
async function secretaryContext() {
  const creds = loadGoogleCreds();
  const tok = loadGoogleToken();
  if (!creds || !tok || !tok.refresh_token) {
    return { linked: false, text: 'Google カレンダー / ToDo は未連携のため、予定・タスク情報はありません。' };
  }
  let a;
  try {
    a = await fetchSecretaryData();
  } catch (e) {
    return { linked: false, text: `(予定・タスクの取得に失敗しました: ${String(e.message).slice(0, 120)})` };
  }

  const now = new Date();
  const lines = [
    `今日: ${a.date} (${dowJa(a.date)}) / 現在時刻: ${hm(now)}`,
    '',
    `■ 予定(過去${SEC_PAST_DAYS}日〜先${SEC_FUTURE_DAYS}日)`,
  ];
  // 日付ごとにグループ化
  const groups = new Map();
  for (const e of a.events) {
    const k = eventDateKey(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  if (!groups.size) lines.push('  この期間の予定はありません');
  for (const k of [...groups.keys()].sort()) {
    lines.push(`[${k} (${dowJa(k)}) ${relDayLabel(k, a.date)}]`);
    for (const e of groups.get(k)) {
      const time = e.allDay ? '終日' : `${hm(e.start)}–${hm(e.end)}`;
      let l = `  - ${time} ${e.summary}`;
      if (e.location) l += ` @${e.location}`;
      if (e.meetLink) l += '(オンライン/Meet)';
      lines.push(l);
    }
  }

  // 未完了 / 完了 に分けて渡す(完了分は週報の材料)
  const openTasks = [];
  const doneTasks = [];
  for (const list of a.taskLists) {
    for (const t of list.tasks) (t.completed ? doneTasks : openTasks).push({ ...t, list: list.title });
  }

  lines.push('', '■ 未完了タスク (ToDo)');
  if (!openTasks.length) lines.push('  なし');
  for (const t of openTasks) {
    let l = `  [未] ${t.title}`;
    if (t.due) l += `（期日 ${t.due}${t.due < a.date ? ' ※期限切れ' : ''}）`;
    if (t.notes) l += ` — ${String(t.notes).slice(0, 200)}`;
    lines.push(l);
  }

  lines.push('', `■ 完了した作業(過去${SEC_DONE_DAYS}日 / 週報・振り返りの材料)`);
  if (!doneTasks.length) {
    lines.push('  なし');
  } else {
    // 完了日(ローカル日付)ごとにグループ化し、新しい順に並べる
    const byDay = new Map();
    for (const t of doneTasks) {
      const d = t.completedAt ? localDateStr(new Date(t.completedAt)) : '不明';
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(t);
    }
    for (const d of [...byDay.keys()].sort().reverse()) {
      const label = d === '不明' ? '完了日不明'
        : `${d} (${dowJa(d)}) ${relDayLabel(d, a.date)}`;
      lines.push(`[${label}]`);
      for (const t of byDay.get(d)) {
        let l = `  ✓ ${t.title}`;
        if (t.list) l += ` 〔${t.list}〕`;
        if (t.notes) l += ` — ${String(t.notes).slice(0, 200)}`;
        lines.push(l);
      }
    }
  }

  // Claude Code の作業ログ(週報の材料)。作業日ごとに新しい順で並べる
  if (a.sessions) {
    lines.push('', `■ Claude Code 作業ログ(過去${SEC_SESSION_DAYS}日 / 週報の材料)`);
    if (!a.sessions.length) {
      lines.push('  記録なし');
    } else {
      // 新しい順に上限まで表示。超過分は件数のみ知らせる(文脈肥大の防止)
      const shown = a.sessions.slice(0, SEC_SESSION_MAX);
      const omitted = a.sessions.length - shown.length;
      const byDay = new Map();
      for (const s of shown) {
        const d = localDateStr(new Date(s.lastMs));
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(s);
      }
      for (const d of [...byDay.keys()].sort().reverse()) {
        lines.push(`[${d} (${dowJa(d)}) ${relDayLabel(d, a.date)}]`);
        for (const s of byDay.get(d).sort((x, y) => x.lastMs - y.lastMs)) {
          const meta = [];
          if (s.prompts) meta.push(`依頼${s.prompts}件`);
          // 同日で完結したセッションは時刻レンジ、日をまたぐ場合は開始日から明記(逆転表示を防ぐ)
          meta.push(localDateStr(new Date(s.firstMs)) === d
            ? `${hm(s.firstMs)}–${hm(s.lastMs)}`
            : `${localDateStr(new Date(s.firstMs))} ${hm(s.firstMs)}〜${hm(s.lastMs)}`);
          lines.push(`  ・[${s.project}] ${s.title}(${meta.join(', ')})`);
        }
      }
      if (omitted > 0) lines.push(`(ほか古いセッション ${omitted} 件は省略)`);
    }
  }

  // 定型ブリーフィング(フォールバック)は「今日」に絞ったデータを使う
  const todayEvents = a.events.filter((e) => eventDateKey(e) === a.date);
  return { linked: true, text: lines.join('\n'), data: { date: a.date, events: todayEvents, taskLists: a.taskLists } };
}

function secretarySystemPrompt(ctxText) {
  const now = new Date();
  const nowStr = `${localDateStr(now)} ${hm(now)}`;
  return `あなたはユーザー専属の有能な日本語の秘書です。現在時刻は ${nowStr} です。
下記「予定・タスク情報」(Google カレンダーの予定と Google ToDo のタスク) を踏まえてユーザーの相談に答えます。
予定は今日だけでなく過去〜先の一定期間を日付ごとに渡しているので、「明日の予定」「来週の会議」「先週なにをしていたか」など他の日についても答えられます。
タスクは「未完了タスク」と「完了した作業(過去${SEC_DONE_DAYS}日・完了日ごと)」を分けて渡しています。完了した作業は週報や振り返りの材料に使えます。
さらに「Claude Code 作業ログ(過去${SEC_SESSION_DAYS}日)」として、日付ごとに各作業セッションのタイトル・プロジェクト・依頼件数・稼働時間帯を渡しています。これは実際に PC 上でどの案件にどれだけ取り組んだかの記録で、週報作成時に完了タスク・予定と突き合わせて使えます(タイトルはセッションの自動要約なので、内容を補足的に推測しても構いませんが、事実として断定しない)。

方針:
- 予定の要点、優先してやるべきタスク、締め切り、各予定に向けて準備すべきものを、具体的かつ実務的に助言する。
- 「今週の作業を週報にまとめて」等を頼まれたら、「完了した作業」と「Claude Code 作業ログ」を作業日ごとに突き合わせ、関連する予定(会議・イベント)も踏まえて、実務的な週次レポートを作成する。事実に基づき、行っていない作業を創作しない。
- 「明日」「今週」などの相対的な指定は、現在時刻を基準に正確な日付へ読み替える(渡した各予定には日付と曜日、今日/明日/N日後 などの相対ラベルが付いている)。
- 簡潔に。要点は短い箇条書き(・)でまとめ、前置きや定型的な挨拶は最小限にする(週報などまとまった成果物を求められた場合はこの限りではない)。
- 時刻・期日は正確に扱い、「進行中」「次の予定」「期限切れ」を意識する。
- 渡した期間の外(遠い未来や過去)は情報がない旨を伝える。推測で断定せず「情報にありません」と述べる。Markdown の見出し(#)は使わない。
- 常に日本語で回答する。

【予定・タスク情報】
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

  // 会話履歴の取得・保存(端末間で共有)
  if (url.pathname === '/api/secretary/history') {
    if (req.method === 'GET') {
      const h = loadSecretaryHistory();
      sendJson(res, 200, { messages: h.messages, at: h.at });
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req)
        .then((body) => sendJson(res, 200, { ok: true, messages: saveSecretaryHistory(body.messages) }))
        .catch((e) => sendJson(res, 500, { error: String(e.message) }));
      return;
    }
  }

  /* ── 探検家(トピック調査)─────────────────── */
  if (url.pathname === '/api/explorer/status') {
    const cfg = loadExplorerConfig();
    const st = loadExplorerState();
    const reports = {};
    for (const [t, r] of Object.entries(st.reports)) reports[t] = { at: r.at, provider: r.provider };
    sendJson(res, 200, {
      configured: cfg.mode !== 'off',
      mode: cfg.mode,
      model: cfg.model,
      topics: st.topics,
      reports,
      running: explorerRunning,
    });
    return;
  }

  if (url.pathname === '/api/explorer/report') {
    const topic = url.searchParams.get('topic') || '';
    const r = loadExplorerState().reports[topic];
    sendJson(res, 200, r ? { topic, report: r.report, at: r.at, provider: r.provider } : { topic, report: null });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/explorer/research') {
    readJsonBody(req)
      .then(async (body) => {
        const topic = (typeof body.topic === 'string' ? body.topic : '').trim().slice(0, 80);
        if (!topic) throw new Error('トピックを入力してください');
        if (explorerRunning || hustlerRunning) { sendJson(res, 200, { error: '別の調査/内職を実行中です。少し待ってから再度お試しください。', running: true }); return; }
        explorerRunning = true;
        try {
          sendJson(res, 200, await doResearch(topic));
        } finally { explorerRunning = false; }
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/explorer/topics') {
    readJsonBody(req)
      .then((body) => {
        const topics = Array.isArray(body.topics)
          ? [...new Set(body.topics
              .filter((t) => typeof t === 'string')
              .map((t) => t.trim()).filter(Boolean)
              .map((t) => t.slice(0, 80)))].slice(0, EXPLORER_MAX_TOPICS)
          : [];
        const st = loadExplorerState();
        st.topics = topics;
        // トピックから外れたレポートは破棄(チップ削除＝完全削除)
        const keep = {};
        for (const t of topics) if (st.reports[t]) keep[t] = st.reports[t];
        st.reports = keep;
        saveExplorerState(st);
        sendJson(res, 200, { ok: true, topics: st.topics });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  /* ── 商人(内職)──────────────────────────── */
  if (url.pathname === '/api/hustler/status') {
    sendJson(res, 200, getHustlerStatus());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/hustler/config') {
    readJsonBody(req)
      .then((body) => {
        const config = saveHustlerConfig(body || {});
        sendJson(res, 200, { ok: true, config, status: getHustlerStatus() });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  if (url.pathname === '/api/hustler/jobs') {
    if (req.method === 'GET') {
      const jobs = loadHustlerJobs().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      sendJson(res, 200, { jobs });
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const type = ['article_draft', 'sns_pack', 'idea_research', 'custom'].includes(body.type) ? body.type : 'custom';
          const topic = typeof body.topic === 'string' ? body.topic.trim().slice(0, 500) : '';
          const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 12000) : '';
          if (type === 'custom' ? !prompt : !topic) throw new Error(type === 'custom' ? 'プロンプトを入力してください' : 'トピックを入力してください');
          const jobs = loadHustlerJobs();
          const job = normalizeHustlerJob({
            id: makeId('job'),
            type,
            topic,
            prompt,
            status: 'pending',
            createdAt: new Date().toISOString(),
          });
          jobs.push(job);
          saveHustlerJobs(jobs);
          sendJson(res, 200, { ok: true, job });
        })
        .catch((e) => sendJson(res, 500, { error: String(e.message) }));
      return;
    }
  }

  if (req.method === 'DELETE' && /^\/api\/hustler\/jobs\/[^/]+$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const jobs = loadHustlerJobs();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx < 0) { sendJson(res, 404, { error: 'ジョブが見つかりません' }); return; }
    if (jobs[idx].status === 'running') { sendJson(res, 409, { error: '実行中ジョブは削除できません' }); return; }
    const removed = jobs.splice(idx, 1)[0];
    saveHustlerJobs(jobs);
    sendJson(res, 200, { ok: true, job: removed });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/hustler/run') {
    readJsonBody(req)
      .then(async (body) => {
        const jobs = loadHustlerJobs();
        const target = body && body.id
          ? jobs.find((j) => j.id === String(body.id))
          : jobs
            .filter((j) => j.status === 'pending')
            .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))[0];
        if (!target) throw new Error('実行できるジョブがありません');
        sendJson(res, 200, { ok: true, job: await executeHustlerJob(target.id) });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  if (url.pathname === '/api/hustler/outputs') {
    if (req.method === 'GET') {
      sendJson(res, 200, { outputs: listHustlerOutputs() });
      return;
    }
  }

  if (req.method === 'GET' && /^\/api\/hustler\/outputs\/[^/]+$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const output = getHustlerOutput(id);
    if (!output) { sendJson(res, 404, { error: '成果物が見つかりません' }); return; }
    sendJson(res, 200, output);
    return;
  }

  if (url.pathname === '/api/hustler/revenue') {
    if (req.method === 'GET') {
      const items = loadHustlerRevenue().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      sendJson(res, 200, { items, monthly: summarizeRevenueByMonth(items) });
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const amount = Number(body.amount);
          if (!Number.isFinite(amount)) throw new Error('金額を入力してください');
          const item = {
            id: makeId('rev'),
            date: typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : localDateStr(),
            amount,
            memo: typeof body.memo === 'string' ? body.memo.trim().slice(0, 200) : '',
          };
          const items = loadHustlerRevenue();
          items.push(item);
          saveHustlerRevenue(items);
          sendJson(res, 200, { ok: true, item, monthly: summarizeRevenueByMonth(items) });
        })
        .catch((e) => sendJson(res, 500, { error: String(e.message) }));
      return;
    }
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
  let file = url.pathname === '/' ? '/index.html'
    : url.pathname === '/sessions' ? '/sessions.html'
    : url.pathname;
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

ensureHustlerStorage();
resetStaleHustlerJobs();

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

// ピアを起動時に温め、以降も定期更新する(/api/data はキャッシュを即返す)。
refreshPeers();
setInterval(refreshPeers, 5000);

// 探検家の週次調査(月曜9時)。サーバー起動中のみ動作する。
const runWeekly = () => checkWeekly().catch((e) => console.error('[explorer] 週次エラー:', e.message));
runWeekly();
setInterval(runWeekly, 30 * 60 * 1000);

const runHustler = () => maybeRunHustlerScheduled().catch((e) => console.error('[hustler] 定期実行エラー:', e.message));
runHustler();
setInterval(runHustler, HUSTLER_CHECK_MS);
