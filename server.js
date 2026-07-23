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
  if (explorerRunning) return;
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

/** 全 ToDo リストのタスク(未完了すべて + 今日完了分)を取得する */
async function fetchTaskLists() {
  const listRes = await gApi('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=20');
  const today = localDateStr();
  return Promise.all((listRes.items || []).map(async (l) => {
    const tr = await gApi(
      `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(l.id)}/tasks?` +
      new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100' }));
    const tasks = (tr.items || [])
      .filter((t) => t.title)
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
  const [events, taskLists] = await Promise.all([
    fetchCalendarEvents(timeMin, timeMax, 250),
    fetchTaskLists(),
  ]);
  const data = { date: localDateStr(now), events, taskLists };
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

方針:
- 予定の要点、優先してやるべきタスク、締め切り、各予定に向けて準備すべきものを、具体的かつ実務的に助言する。
- 「明日」「今週」などの相対的な指定は、現在時刻を基準に正確な日付へ読み替える(渡した各予定には日付と曜日、今日/明日/N日後 などの相対ラベルが付いている)。
- 簡潔に。要点は短い箇条書き(・)でまとめ、前置きや定型的な挨拶は最小限にする。
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
        if (explorerRunning) { sendJson(res, 200, { error: '別の調査を実行中です。少し待ってから再度お試しください。', running: true }); return; }
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
