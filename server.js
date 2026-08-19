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
const { spawn, execFile } = require('child_process');

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
const CREATOR_DIR = path.join(DATA_DIR, 'creator');
const CREATOR_VIDEOS_DIR = path.join(CREATOR_DIR, 'videos');
const CREATOR_WORK_DIR = path.join(CREATOR_DIR, 'work');
const CREATOR_JOBS_PATH = path.join(CREATOR_DIR, 'jobs.json');
const CREATOR_CONFIG_PATH = path.join(__dirname, 'creator-config.json');
const TRADER_DIR = path.join(DATA_DIR, 'trader');
const TRADER_PRICES_PATH = path.join(TRADER_DIR, 'prices.jsonl');
const TRADER_PORTFOLIO_PATH = path.join(TRADER_DIR, 'portfolio.json');
const TRADER_CONFIG_PATH = path.join(__dirname, 'trader-config.json');
const TRADER_STATE_PATH = path.join(TRADER_DIR, 'state.json');
const APPRAISER_DIR = path.join(DATA_DIR, 'appraiser');
const APPRAISER_REPORTS_DIR = path.join(APPRAISER_DIR, 'reports');
const APPRAISER_ITEMS_PATH = path.join(APPRAISER_DIR, 'items.json');
const APPRAISER_SEEN_PATH = path.join(APPRAISER_DIR, 'seen.json');
const APPRAISER_STATE_PATH = path.join(APPRAISER_DIR, 'state.json');
const APPRAISER_CONFIG_PATH = path.join(__dirname, 'appraiser-config.json');
const ZONE_OVERRIDES_PATH = path.join(__dirname, 'zone-overrides.json');
const CREATOR_REF_IMAGE_PATH = path.join(__dirname, 'assets', 'h3', 'character_ref.png');
const HUSTLER_WINDOW_MS = 5 * 60 * 60 * 1000;
const HUSTLER_CHECK_MS = 10 * 60 * 1000;
const HUSTLER_TOKEN_HEADROOM = 120000;
const HUSTLER_JOB_TYPES = new Set(['article_draft', 'affiliate_article', 'sns_pack', 'idea_research', 'custom']);
const HUSTLER_REVIEW_JOB_TYPES = new Set(['article_draft', 'affiliate_article']);
const HUSTLER_PUBLISH_TARGETS = new Set(['zenn', 'generic', 'none']);
const CREATOR_PRIVACY_STATUSES = new Set(['public', 'private', 'unlisted']);
const CREATOR_JOB_STATUSES = new Set(['pending', 'scripting', 'rendering', 'reviewing', 'approved', 'pending_review', 'publishing', 'published', 'error']);
const CREATOR_RESTARTABLE_STATUSES = new Set(['scripting', 'rendering', 'reviewing', 'publishing']);
const CREATOR_UNFINISHED_STATUSES = new Set(['pending', 'scripting', 'rendering', 'reviewing', 'approved', 'pending_review', 'publishing']);
const APPRAISER_ITEM_STATUSES = new Set(['pending', 'classifying', 'researching', 'testing', 'done', 'error']);
const APPRAISER_CATEGORIES = new Set(['research', 'money', 'tool', 'other']);
const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const TRADER_ACTIONS = new Set(['buy', 'sell', 'hold']);
const SESSION_ZONE_AUTO = 'auto';
const SESSION_ZONE_INTERACTIVE = 'interactive';
const AUTO_PROMPT_CHARS = 220;
const TMUX_PANE_FORMAT = '#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_active}\t#{window_activity}';
const TMUX_ALLOWED_KEYS = {
  enter: 'Enter',
  y: 'y',
  n: 'n',
  esc: 'Escape',
  up: 'Up',
  down: 'Down',
  1: '1',
  2: '2',
  3: '3',
  tab: 'Tab',
  'ctrl-c': 'C-c',
};
const DEFAULT_TRADER_PATHS = {
  dir: TRADER_DIR,
  pricesPath: TRADER_PRICES_PATH,
  portfolioPath: TRADER_PORTFOLIO_PATH,
  configPath: TRADER_CONFIG_PATH,
  statePath: TRADER_STATE_PATH,
};

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

function extractUserPromptText(message) {
  if (!message || message.role !== 'user') return '';
  const c = message.content;
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b && b.type === 'text' && String(b.text || '').trim())
    .map((b) => String(b.text || '').trim())
    .join('\n')
    .trim();
}

/** user メッセージが「実際の依頼(テキスト発話)」か。tool_result / 画像のみ / 空 は false */
function isUserPrompt(message) {
  if (!message || message.role !== 'user') return false;
  const c = message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return false;
  return extractUserPromptText(message).length > 0;
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
    firstPromptChars: 0,
    fileMtime: stat.mtimeMs,
    fileSize: stat.size,
    hourly: {},           // 'YYYY-MM-DDTHH' -> event count (タイムライン用)
    tailKind: null,       // 末尾メッセージ種別: 'user' | 'assistant'(待ち状態判定用)
    tailStop: null,       // 末尾 assistant の stop_reason ('end_turn' | 'tool_use' 等)
    lastUserToolResult: false, // 末尾 user がツール結果か(承認待ち判定用)
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
      summary.tailKind = 'user'; summary.tailStop = null;
      summary.lastUserToolResult = Array.isArray(o.message.content)
        && o.message.content.some((b) => b && b.type === 'tool_result');
      if (!o.isSidechain && isUserPrompt(o.message)) summary.promptCount++;
      const promptText = extractUserPromptText(o.message);
      if (!summary.firstPrompt && promptText) {
        summary.firstPrompt = promptText.slice(0, 120);
        summary.firstPromptChars = promptText.length;
      }
      if (ts) {
        const h = ts.slice(0, 13);
        summary.hourly[h] = (summary.hourly[h] || 0) + 1;
      }
    } else if (o.type === 'assistant' && o.message) {
      summary.assistantMessages++;
      const m = o.message;
      summary.tailKind = 'assistant'; summary.tailStop = m.stop_reason || null;
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

function isSubPath(parent, target) {
  if (!parent || !target) return false;
  const rel = path.relative(parent, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function classifySessionZone(session) {
  if (session.cwd && isSubPath(os.tmpdir(), session.cwd)) return SESSION_ZONE_AUTO;
  if (session.promptCount === 1 && session.firstPromptChars >= AUTO_PROMPT_CHARS) return SESSION_ZONE_AUTO;
  return SESSION_ZONE_INTERACTIVE;
}

function normalizePathForMatch(inputPath) {
  if (!inputPath) return null;
  try {
    return fs.realpathSync.native(inputPath);
  } catch {
    try {
      return fs.realpathSync(inputPath);
    } catch {
      return path.resolve(inputPath);
    }
  }
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function isTmuxCommandMissing(error) {
  return !!(error && error.code === 'ENOENT');
}

function isTmuxPermissionError(error) {
  const message = String((error && error.stderr) || (error && error.message) || '');
  return /operation not permitted|permission denied/i.test(message);
}

function isTmuxNoServerError(error) {
  const message = String((error && error.stderr) || (error && error.message) || '');
  return /no server running/i.test(message);
}

async function listAllTmuxPanes() {
  try {
    const { stdout } = await execFileText('tmux', ['list-panes', '-a', '-F', TMUX_PANE_FORMAT]);
    const panes = stdout.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [paneId, target, command, panePath, active, lastActivity] = line.split('\t');
        const activityNum = Number(lastActivity);
        return {
          paneId,
          target,
          command: command || '',
          path: panePath || '',
          active: active === '1',
          lastActivity: Number.isFinite(activityNum) ? activityNum : 0,
          normalizedPath: normalizePathForMatch(panePath),
        };
      })
      .filter((pane) => /^%\d+$/.test(pane.paneId));
    return { available: true, panes };
  } catch (error) {
    if (isTmuxCommandMissing(error) || isTmuxPermissionError(error)) return { available: false, panes: [] };
    if (isTmuxNoServerError(error)) return { available: true, panes: [] };
    throw error;
  }
}

function tmuxCommandRank(command) {
  return /^(claude|node)$/i.test(String(command || '').trim()) ? 1 : 0;
}

async function listProjectTmuxPanes(projectName) {
  const name = String(projectName || '').trim();
  const tmux = await listAllTmuxPanes();
  if (!tmux.available || !name) return { available: tmux.available, panes: [] };

  const projectPaths = new Set(
    (collect().projects || [])
      .filter((project) => !project.remote && project.name === name && project.cwd)
      .map((project) => normalizePathForMatch(project.cwd))
      .filter(Boolean)
  );
  if (!projectPaths.size) return { available: true, panes: [] };

  const panes = tmux.panes
    .filter((pane) => pane.normalizedPath && projectPaths.has(pane.normalizedPath))
    .sort((a, b) => (tmuxCommandRank(b.command) - tmuxCommandRank(a.command))
      || ((b.lastActivity || 0) - (a.lastActivity || 0)))
    .map((pane, index) => ({
      paneId: pane.paneId,
      target: pane.target,
      command: pane.command,
      path: pane.path,
      active: pane.active,
      lastActivity: pane.lastActivity,
      recommended: index === 0,
    }));
  return { available: true, panes };
}

function sanitizeTmuxPaneId(value) {
  const paneId = String(value || '').trim();
  return /^%\d+$/.test(paneId) ? paneId : null;
}

function sanitizeTmuxKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return TMUX_ALLOWED_KEYS[key] ? key : null;
}

async function sendTmuxText(paneId, text) {
  await execFileText('tmux', ['send-keys', '-t', paneId, '-l', '--', text]);
  await execFileText('tmux', ['send-keys', '-t', paneId, 'Enter']);
}

async function sendTmuxKey(paneId, key) {
  await execFileText('tmux', ['send-keys', '-t', paneId, TMUX_ALLOWED_KEYS[key]]);
}

function chooseProjectZone(sessions) {
  const counts = { [SESSION_ZONE_AUTO]: 0, [SESSION_ZONE_INTERACTIVE]: 0 };
  for (const session of sessions) counts[session.zone] = (counts[session.zone] || 0) + 1;
  if (counts.auto !== counts.interactive) {
    return counts.auto > counts.interactive ? SESSION_ZONE_AUTO : SESSION_ZONE_INTERACTIVE;
  }
  return sessions[0]?.zone || SESSION_ZONE_INTERACTIVE;
}

// この時間、Claude の応答が進まなければ「対応待ち(承認プロンプト等で停止)」とみなす。
const APPROVAL_IDLE_MS = 15000;
/**
 * セッションが人の対応(承認プロンプト等)を待って停止しているか判定する。
 * 手動承認の保留中は、保留中の tool_use が記録に書き出されないため、末尾は
 * 直前の tool_result(user) のまま止まる。そこで「ツール実行が未完了のまま
 * 一定時間 Claude の出力が進まない」状態を対応待ちとみなす:
 *   - 末尾が assistant の未完了 tool_use のまま停止(自動承認だが長時間 等)
 *   - 末尾が user のツール結果のまま無応答で停止(承認プロンプトの典型)
 * いずれも「作業が途中で止まっている」ことを表す。end_turn(会話終了)は対象外。
 */
function sessionWaiting(s, now) {
  const last = s.lastTs ? Date.parse(s.lastTs) : s.fileMtime;
  if ((now - last) <= APPROVAL_IDLE_MS) return null;   // 実行中/生成中はまだ待ちとしない
  if (s.tailKind === 'assistant' && s.tailStop === 'tool_use') return 'approval';
  if (s.tailKind === 'user' && s.lastUserToolResult) return 'approval';
  return null;
}

/** 全プロジェクトを走査して集計を返す */
function collect() {
  const now = Date.now();
  const projects = [];
  const zoneOverrides = loadZoneOverrides();

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
      // 待ち状態は人が居る(active/recent)セッションのみ対象にする
      s.waiting = (s.status === 'active' || s.status === 'recent') ? sessionWaiting(s, now) : null;
      s.agents = parseAgents(path.join(projDir, s.sessionId), now);
      s.totalAgents = s.agents.length;
      s.runningAgents = s.agents.filter((a) => a.running).length;
      s.zone = classifySessionZone(s);
      sessions.push(s);
    }
    sessions.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));

    // フォルダ名からプロジェクト表示名を復元 ("-Users-x-foo-bar" -> "foo/bar" 末尾側)
    const cwd = sessions.find((s) => s.cwd)?.cwd;
    const name = cwd ? path.basename(cwd) : d.name.split('-').filter(Boolean).slice(-2).join('/');
    const inferredZone = chooseProjectZone(sessions);
    const overrideZone = zoneOverrides[name] || null;

    const agg = {
      dirName: d.name,
      name,
      cwd: cwd || null,
      zone: overrideZone || inferredZone,
      zoneOverride: overrideZone,
      inferredZone,
      sessionCount: sessions.length,
      status: sessions.some((s) => s.status === 'active') ? 'active'
        : sessions.some((s) => s.status === 'recent') ? 'recent' : 'idle',
      // 待ち: 承認待ちを優先、次に入力待ち(手を上げる表示に使う)
      waiting: sessions.some((s) => s.waiting === 'approval') ? 'approval'
        : sessions.some((s) => s.waiting === 'input') ? 'input' : null,
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
const GOOGLE_SCOPES = `https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks ${YOUTUBE_UPLOAD_SCOPE}`;
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
function runClaudeCli({ cli, model, system, prompt, timeoutSec = 60 }) {
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
    const timeoutMs = Math.max(1, Number(timeoutSec) || 60) * 1000;
    let settled = false;
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settleReject(new Error(`タイムアウト(${Math.max(1, Math.round(timeoutMs / 1000))}秒)`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => settleReject(new Error('起動失敗: ' + e.message)));
    child.on('close', () => {
      if (settled) return;
      try {
        const j = JSON.parse(out);
        if (j.is_error) return settleReject(new Error(String(j.result || 'CLI エラー').slice(0, 160)));
        settleResolve(String(j.result || '').trim());
      } catch {
        settleReject(new Error((err || out || '応答なし').slice(0, 160)));
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
  qualityThreshold: 75,
  maxRevisions: 2,
  autoFromExplorer: true,
  cliTimeoutSec: 300,
  publish: {
    enabled: false,
    mode: 'zenn-git',
    repoPath: '',
    genericRepoPath: '',
    genericDir: 'content/posts',
    genericFrontmatter: 'hugo',
    articleType: 'tech',
    price: 0,
    topics: [],
    publishedFlag: true,
  },
  affiliate: {
    enabled: false,
    disclosure: '※本記事にはアフィリエイトリンクが含まれます。',
    links: [],
  },
};

const DEFAULT_CREATOR_CONFIG = {
  enabled: false,
  comfyUrl: 'http://127.0.0.1:8188',
  dailyLimit: 2,
  sceneCount: 3,
  sceneSeconds: 5,
  resolution: '768x1344',
  draftResolution: '512x896',
  qualityThreshold: 70,
  autoFromExplorer: true,
  publish: {
    enabled: false,
    privacyStatus: 'public',
    categoryId: '28',
    disclosureText: 'この動画はAIによって生成されています。',
  },
};

const DEFAULT_TRADER_CONFIG = {
  enabled: false,
  assets: ['bitcoin', 'ethereum'],
  vsCurrency: 'jpy',
  priceIntervalMin: 15,
  analysisHour: 7,
  startBalance: 100000,
  priceProvider: 'auto',
  symbolMap: {
    bitcoin: 'BTC-JPY',
    ethereum: 'ETH-JPY',
  },
};
const DEFAULT_TRADER_FETCH_STATE = {
  currentProvider: null,
  providerMemoUntil: 0,
  lastFetchAt: null,
  lastFetchOk: null,
  lastFetchError: '',
  lastFetchProvider: null,
};
const DEFAULT_APPRAISER_CONFIG = {
  handsOn: false,
  testTimeoutSec: 900,
  interestProfile: 'AI/ロボティクス研究、AIエージェントの収益化、個人開発での技術活用に関心が高い。',
  xApi: {
    bearerToken: '',
    userId: '',
    pollBookmarks: true,
    pollLikes: false,
    intervalHours: 6,
  },
};
const DEFAULT_APPRAISER_SEEN = {
  bookmarks: [],
  likes: [],
};
const DEFAULT_APPRAISER_STATE = {
  xPolling: {
    lastPollAt: null,
    lastSuccessAt: null,
    lastImported: { bookmarks: 0, likes: 0 },
    lastError: '',
    authError: null,
  },
};
const TRADER_PRICE_PROVIDERS = new Set(['auto', 'coingecko', 'yahoo']);
const TRADER_PROVIDER_MEMO_MS = 60 * 60 * 1000;

let hustlerRunning = false; // 多重実行防止(手動 + 定期実行で共有)
let creatorRunning = false; // 多重実行防止(手動 + 定期実行で共有)
let traderRunning = false; // 多重実行防止(手動 + 定期実行で共有)
let appraiserRunning = false; // 多重実行防止(手動 + 定期実行で共有)
let appraiserRunningItemId = null;
const HUSTLER_JOB_STATUSES = new Set(['pending', 'running', 'evaluating', 'revising', 'approved', 'rejected', 'published', 'error']);
const HUSTLER_RESTARTABLE_STATUSES = new Set(['running', 'evaluating', 'revising']);
const HUSTLER_UNFINISHED_TOPIC_STATUSES = new Set(['pending', 'running', 'evaluating', 'revising', 'approved']);

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

function ensureCreatorStorage() {
  ensureDir(CREATOR_DIR);
  ensureDir(CREATOR_VIDEOS_DIR);
  ensureDir(CREATOR_WORK_DIR);
  if (!fs.existsSync(CREATOR_JOBS_PATH)) fs.writeFileSync(CREATOR_JOBS_PATH, '[]\n');
  if (!fs.existsSync(CREATOR_CONFIG_PATH)) {
    fs.writeFileSync(CREATOR_CONFIG_PATH, JSON.stringify(DEFAULT_CREATOR_CONFIG, null, 2) + '\n');
  }
}

function traderPaths(paths = null) {
  return { ...DEFAULT_TRADER_PATHS, ...(paths || {}) };
}

function sanitizeCreatorResolution(value, fallback) {
  const m = String(value || '').trim().match(/^(\d{2,5})x(\d{2,5})$/i);
  if (!m) return fallback;
  const width = Math.max(32, Math.min(4096, Math.round(Number(m[1]) || 0)));
  const height = Math.max(32, Math.min(4096, Math.round(Number(m[2]) || 0)));
  if (!width || !height) return fallback;
  return `${width}x${height}`;
}

function parseCreatorResolution(value, fallback = DEFAULT_CREATOR_CONFIG.resolution) {
  const safe = sanitizeCreatorResolution(value, fallback);
  const [width, height] = safe.split('x').map((n) => Number(n));
  return { width, height, value: safe };
}

function sanitizeCreatorPublishConfig(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return {
    enabled: !!src.enabled,
    privacyStatus: CREATOR_PRIVACY_STATUSES.has(src.privacyStatus) ? src.privacyStatus : DEFAULT_CREATOR_CONFIG.publish.privacyStatus,
    categoryId: typeof src.categoryId === 'string' && src.categoryId.trim()
      ? src.categoryId.trim().replace(/[^\d]/g, '').slice(0, 12) || DEFAULT_CREATOR_CONFIG.publish.categoryId
      : DEFAULT_CREATOR_CONFIG.publish.categoryId,
    disclosureText: typeof src.disclosureText === 'string' && src.disclosureText.trim()
      ? src.disclosureText.trim().slice(0, 300)
      : DEFAULT_CREATOR_CONFIG.publish.disclosureText,
  };
}

function sanitizeCreatorConfig(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return {
    enabled: !!src.enabled,
    comfyUrl: typeof src.comfyUrl === 'string' && /^https?:\/\//.test(src.comfyUrl.trim())
      ? src.comfyUrl.trim().replace(/\/+$/, '')
      : DEFAULT_CREATOR_CONFIG.comfyUrl,
    dailyLimit: Math.max(1, Math.min(24, Math.round(Number(src.dailyLimit) || DEFAULT_CREATOR_CONFIG.dailyLimit))),
    sceneCount: Math.max(1, Math.min(8, Math.round(Number(src.sceneCount) || DEFAULT_CREATOR_CONFIG.sceneCount))),
    sceneSeconds: Math.max(2, Math.min(15, Math.round(Number(src.sceneSeconds) || DEFAULT_CREATOR_CONFIG.sceneSeconds))),
    resolution: sanitizeCreatorResolution(src.resolution, DEFAULT_CREATOR_CONFIG.resolution),
    draftResolution: sanitizeCreatorResolution(src.draftResolution, DEFAULT_CREATOR_CONFIG.draftResolution),
    qualityThreshold: Math.max(0, Math.min(100, Math.round(Number(src.qualityThreshold) || DEFAULT_CREATOR_CONFIG.qualityThreshold))),
    autoFromExplorer: src.autoFromExplorer !== false,
    publish: sanitizeCreatorPublishConfig({ ...DEFAULT_CREATOR_CONFIG.publish, ...(src.publish || {}) }),
  };
}

function loadCreatorConfig() {
  ensureCreatorStorage();
  const stored = readJsonFileSafe(CREATOR_CONFIG_PATH, DEFAULT_CREATOR_CONFIG);
  return sanitizeCreatorConfig({ ...DEFAULT_CREATOR_CONFIG, ...stored });
}

function saveCreatorConfig(config) {
  ensureCreatorStorage();
  const clean = sanitizeCreatorConfig(config);
  fs.writeFileSync(CREATOR_CONFIG_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

function sanitizeTraderAssetIds(items) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const asset = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60);
    if (!asset || seen.has(asset)) continue;
    seen.add(asset);
    out.push(asset);
    if (out.length >= 8) break;
  }
  return out.length ? out : DEFAULT_TRADER_CONFIG.assets.slice();
}

function sanitizeTraderProvider(value) {
  return TRADER_PRICE_PROVIDERS.has(value) ? value : DEFAULT_TRADER_CONFIG.priceProvider;
}

function sanitizeTraderSymbol(value) {
  const symbol = typeof value === 'string'
    ? value.trim().toUpperCase().replace(/[^A-Z0-9=._-]/g, '').slice(0, 32)
    : '';
  return symbol || '';
}

function sanitizeTraderSymbolMap(input, assets = DEFAULT_TRADER_CONFIG.assets) {
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const clean = {};
  const source = { ...DEFAULT_TRADER_CONFIG.symbolMap, ...src };
  for (const asset of assets) {
    const key = sanitizeTraderAssetIds([asset])[0];
    if (!key) continue;
    const symbol = sanitizeTraderSymbol(source[key]);
    if (symbol) clean[key] = symbol;
  }
  return clean;
}

function sanitizeTraderConfig(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const assets = sanitizeTraderAssetIds(src.assets);
  const vsCurrency = typeof src.vsCurrency === 'string'
    ? src.vsCurrency.trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 12)
    : '';
  return {
    enabled: !!src.enabled,
    assets,
    vsCurrency: vsCurrency || DEFAULT_TRADER_CONFIG.vsCurrency,
    priceIntervalMin: Math.max(5, Math.min(24 * 60, Math.round(Number(src.priceIntervalMin) || DEFAULT_TRADER_CONFIG.priceIntervalMin))),
    analysisHour: Math.max(0, Math.min(23, Math.round(Number(src.analysisHour) || DEFAULT_TRADER_CONFIG.analysisHour))),
    startBalance: Math.max(1000, Math.min(1000000000, Math.round(Number(src.startBalance) || DEFAULT_TRADER_CONFIG.startBalance))),
    priceProvider: sanitizeTraderProvider(src.priceProvider),
    symbolMap: sanitizeTraderSymbolMap(src.symbolMap, assets),
  };
}

function sanitizeTraderFetchState(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const currentProvider = src.currentProvider === 'coingecko' || src.currentProvider === 'yahoo'
    ? src.currentProvider
    : null;
  const lastFetchProvider = src.lastFetchProvider === 'coingecko' || src.lastFetchProvider === 'yahoo'
    ? src.lastFetchProvider
    : null;
  return {
    currentProvider,
    providerMemoUntil: Math.max(0, Number(src.providerMemoUntil) || 0),
    lastFetchAt: typeof src.lastFetchAt === 'string' ? src.lastFetchAt : null,
    lastFetchOk: typeof src.lastFetchOk === 'boolean' ? src.lastFetchOk : null,
    lastFetchError: typeof src.lastFetchError === 'string' ? src.lastFetchError.slice(0, 500) : '',
    lastFetchProvider,
  };
}

function traderPriceField(vsCurrency) {
  return String(vsCurrency || DEFAULT_TRADER_CONFIG.vsCurrency).toLowerCase();
}

function traderChangeField(vsCurrency) {
  return `${traderPriceField(vsCurrency)}_24h_change`;
}

function makeDefaultTraderPortfolio(startBalance = DEFAULT_TRADER_CONFIG.startBalance) {
  return {
    cash: Math.max(0, Number(startBalance) || DEFAULT_TRADER_CONFIG.startBalance),
    positions: {},
    trades: [],
    equityHistory: [],
    lastAnalysis: null,
  };
}

function sanitizeTraderSignalEntry(input, config) {
  const src = (input && typeof input === 'object') ? input : {};
  const asset = String(src.asset || '').trim().toLowerCase();
  if (!config.assets.includes(asset)) return null;
  const action = TRADER_ACTIONS.has(src.action) ? src.action : 'hold';
  const sizePct = Math.max(0, Math.min(30, Number(src.sizePct) || 0));
  const confidence = Math.max(0, Math.min(1, Number(src.confidence) || 0));
  return {
    asset,
    action,
    sizePct: Math.round(sizePct * 100) / 100,
    confidence: Math.round(confidence * 1000) / 1000,
    reasoning: typeof src.reasoning === 'string' ? src.reasoning.trim().slice(0, 1200) : '',
  };
}

function sanitizeTraderTrade(input, config) {
  const src = (input && typeof input === 'object') ? input : {};
  const asset = String(src.asset || '').trim().toLowerCase();
  return {
    ts: typeof src.ts === 'string' ? src.ts : new Date().toISOString(),
    asset: config.assets.includes(asset) ? asset : (config.assets[0] || 'bitcoin'),
    side: TRADER_ACTIONS.has(src.side) ? src.side : 'hold',
    qty: Math.max(0, Number(src.qty) || 0),
    price: Math.max(0, Number(src.price) || 0),
    reasoning: typeof src.reasoning === 'string' ? src.reasoning.slice(0, 1200) : '',
    sizePct: Math.max(0, Math.min(30, Number(src.sizePct) || 0)),
    confidence: Math.max(0, Math.min(1, Number(src.confidence) || 0)),
  };
}

function sanitizeTraderPortfolio(input, config) {
  const src = (input && typeof input === 'object') ? input : {};
  const clean = makeDefaultTraderPortfolio(config.startBalance);
  clean.cash = Math.max(0, Number.isFinite(Number(src.cash)) ? Number(src.cash) : clean.cash);
  clean.positions = {};
  for (const asset of config.assets) {
    const pos = src.positions && src.positions[asset];
    if (!pos || typeof pos !== 'object') continue;
    const qty = Math.max(0, Number(pos.qty) || 0);
    const avgCost = Math.max(0, Number(pos.avgCost) || 0);
    if (qty > 0) clean.positions[asset] = { qty, avgCost };
  }
  clean.trades = (Array.isArray(src.trades) ? src.trades : []).map((x) => sanitizeTraderTrade(x, config)).slice(-500);
  clean.equityHistory = (Array.isArray(src.equityHistory) ? src.equityHistory : [])
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      date: typeof x.date === 'string' ? x.date.slice(0, 10) : localDateStr(),
      equity: Math.max(0, Number(x.equity) || 0),
    }))
    .slice(-365);
  if (src.lastAnalysis && typeof src.lastAnalysis === 'object') {
    clean.lastAnalysis = {
      ts: typeof src.lastAnalysis.ts === 'string' ? src.lastAnalysis.ts : null,
      marketNote: typeof src.lastAnalysis.marketNote === 'string' ? src.lastAnalysis.marketNote.slice(0, 2000) : '',
      provider: typeof src.lastAnalysis.provider === 'string' ? src.lastAnalysis.provider.slice(0, 40) : '',
      signals: (Array.isArray(src.lastAnalysis.signals) ? src.lastAnalysis.signals : [])
        .map((x) => sanitizeTraderSignalEntry(x, config))
        .filter(Boolean),
    };
  }
  return clean;
}

function ensureTraderStorage(paths = null) {
  const p = traderPaths(paths);
  ensureDir(p.dir);
  if (!fs.existsSync(p.pricesPath)) fs.writeFileSync(p.pricesPath, '');
  if (!fs.existsSync(p.configPath)) {
    fs.writeFileSync(p.configPath, JSON.stringify(DEFAULT_TRADER_CONFIG, null, 2) + '\n');
  }
  if (!fs.existsSync(p.portfolioPath)) {
    fs.writeFileSync(p.portfolioPath, JSON.stringify(makeDefaultTraderPortfolio(DEFAULT_TRADER_CONFIG.startBalance), null, 2) + '\n');
  }
  if (!fs.existsSync(p.statePath)) {
    fs.writeFileSync(p.statePath, JSON.stringify(DEFAULT_TRADER_FETCH_STATE, null, 2) + '\n');
  }
  return p;
}

function ensureAppraiserStorage() {
  ensureDir(APPRAISER_DIR);
  ensureDir(APPRAISER_REPORTS_DIR);
  if (!fs.existsSync(APPRAISER_ITEMS_PATH)) fs.writeFileSync(APPRAISER_ITEMS_PATH, '[]\n');
  if (!fs.existsSync(APPRAISER_SEEN_PATH)) fs.writeFileSync(APPRAISER_SEEN_PATH, JSON.stringify(DEFAULT_APPRAISER_SEEN, null, 2) + '\n');
  if (!fs.existsSync(APPRAISER_STATE_PATH)) fs.writeFileSync(APPRAISER_STATE_PATH, JSON.stringify(DEFAULT_APPRAISER_STATE, null, 2) + '\n');
  if (!fs.existsSync(APPRAISER_CONFIG_PATH)) fs.writeFileSync(APPRAISER_CONFIG_PATH, JSON.stringify(DEFAULT_APPRAISER_CONFIG, null, 2) + '\n');
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readJsonFileSafe(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function sanitizeZone(value) {
  return value === SESSION_ZONE_AUTO || value === SESSION_ZONE_INTERACTIVE ? value : null;
}

function loadZoneOverrides() {
  const raw = readJsonFileSafe(ZONE_OVERRIDES_PATH, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = {};
  for (const [projectName, zone] of Object.entries(raw)) {
    const name = String(projectName || '').trim();
    const normalized = sanitizeZone(zone);
    if (name && normalized) clean[name] = normalized;
  }
  return clean;
}

function saveZoneOverrides(overrides) {
  const clean = loadZoneOverrides();
  for (const [projectName, zone] of Object.entries(overrides || {})) {
    const name = String(projectName || '').trim();
    const normalized = sanitizeZone(zone);
    if (!name) continue;
    if (normalized) clean[name] = normalized;
    else delete clean[name];
  }
  fs.writeFileSync(ZONE_OVERRIDES_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
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

function uniqStrings(items, maxItems = 8, maxLength = 60) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(items) ? items : []) {
    const s = String(raw || '').trim().slice(0, maxLength);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePublishTarget(target, fallback = 'none') {
  return HUSTLER_PUBLISH_TARGETS.has(target) ? target : fallback;
}

function defaultPublishTargetForType(type) {
  if (type === 'affiliate_article') return 'generic';
  if (type === 'article_draft') return 'zenn';
  return 'none';
}

function requiresHustlerReview(type) {
  return HUSTLER_REVIEW_JOB_TYPES.has(type);
}

function sanitizeAffiliateLink(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return {
    label: typeof src.label === 'string' ? src.label.trim().slice(0, 120) : '',
    url: typeof src.url === 'string' ? src.url.trim().slice(0, 2000) : '',
    note: typeof src.note === 'string' ? src.note.trim().slice(0, 240) : '',
  };
}

function sanitizeAffiliateConfig(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const links = [];
  const seen = new Set();
  for (const raw of Array.isArray(src.links) ? src.links : []) {
    const link = sanitizeAffiliateLink(raw);
    if (!link.label || !link.url) continue;
    const key = normalizeTopicKey(link.label);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
    if (links.length >= 50) break;
  }
  return {
    enabled: !!src.enabled,
    disclosure: typeof src.disclosure === 'string' && src.disclosure.trim()
      ? src.disclosure.trim().slice(0, 300)
      : DEFAULT_HUSTLER_CONFIG.affiliate.disclosure,
    links,
  };
}

function sanitizeGenericDir(raw) {
  const src = typeof raw === 'string' ? raw.trim() : '';
  const safe = src
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/(?:^|\/)\.\.(?=\/|$)/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  return safe || DEFAULT_HUSTLER_CONFIG.publish.genericDir;
}

function normalizeHustlerState(state, fallback = 'pending') {
  if (state === 'done') return 'approved';
  return HUSTLER_JOB_STATUSES.has(state) ? state : fallback;
}

function normalizeReviewPayload(input) {
  if (!input || typeof input !== 'object') return null;
  const scoreNum = Number(input.score);
  const score = Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : null;
  return {
    score,
    verdict: typeof input.verdict === 'string' ? input.verdict.trim().slice(0, 120) : '',
    strengths: uniqStrings(input.strengths, 8, 240),
    issues: uniqStrings(input.issues, 8, 240),
    fixInstructions: typeof input.fixInstructions === 'string' ? input.fixInstructions.trim().slice(0, 4000) : '',
  };
}

function normalizeStateHistory(history, fallbackState = 'pending', fallbackAt = null) {
  const out = [];
  for (const item of Array.isArray(history) ? history : []) {
    if (!item || typeof item !== 'object') continue;
    out.push({
      state: normalizeHustlerState(item.state, fallbackState),
      at: typeof item.at === 'string' ? item.at : (fallbackAt || new Date().toISOString()),
      note: typeof item.note === 'string' ? item.note.slice(0, 240) : '',
    });
  }
  return out;
}

function appendStateHistory(history, state, note = '', at = null) {
  const nextAt = at || new Date().toISOString();
  const clean = normalizeStateHistory(history, state, nextAt);
  clean.push({
    state: normalizeHustlerState(state),
    at: nextAt,
    note: typeof note === 'string' ? note.slice(0, 240) : '',
  });
  return clean;
}

function alignCreatorFrameCount(frameCount) {
  let n = Math.max(5, Math.round(Number(frameCount) || 5));
  while (n % 17 !== 5) n++;
  return n;
}

function secondsToCreatorFrameCount(seconds) {
  return alignCreatorFrameCount(Math.round(Math.max(0.25, Number(seconds) || 0) * 24));
}

function normalizeCreatorState(state, fallback = 'pending') {
  return CREATOR_JOB_STATUSES.has(state) ? state : fallback;
}

function normalizeCreatorStateHistory(history, fallbackState = 'pending', fallbackAt = null) {
  const out = [];
  for (const item of Array.isArray(history) ? history : []) {
    if (!item || typeof item !== 'object') continue;
    out.push({
      state: normalizeCreatorState(item.state, fallbackState),
      at: typeof item.at === 'string' ? item.at : (fallbackAt || new Date().toISOString()),
      note: typeof item.note === 'string' ? item.note.slice(0, 240) : '',
    });
  }
  return out;
}

function appendCreatorStateHistory(history, state, note = '', at = null) {
  const nextAt = at || new Date().toISOString();
  const clean = normalizeCreatorStateHistory(history, state, nextAt);
  clean.push({
    state: normalizeCreatorState(state),
    at: nextAt,
    note: typeof note === 'string' ? note.slice(0, 240) : '',
  });
  return clean;
}

function creatorVideoMetaPath(videoId) {
  return path.join(CREATOR_VIDEOS_DIR, `${videoId}.json`);
}

function creatorVideoFilePath(videoId) {
  return path.join(CREATOR_VIDEOS_DIR, `${videoId}.mp4`);
}

function normalizeCreatorScene(scene, fallbackCharacter = '') {
  const src = (scene && typeof scene === 'object') ? scene : {};
  const visualPrompt = typeof src.visualPrompt === 'string' ? src.visualPrompt.trim().slice(0, 4000) : '';
  const dialogue = typeof src.dialogue === 'string' ? src.dialogue.trim().slice(0, 280) : '';
  const caption = typeof src.caption === 'string' ? src.caption.trim().slice(0, 120) : '';
  const withCharacter = fallbackCharacter && !visualPrompt.toLowerCase().includes(fallbackCharacter.toLowerCase())
    ? `${fallbackCharacter}. ${visualPrompt}`.trim()
    : visualPrompt;
  return {
    visualPrompt: withCharacter,
    dialogue,
    caption,
  };
}

function normalizeCreatorScript(script, fallbackCharacter = '') {
  const src = (script && typeof script === 'object') ? script : {};
  return {
    title: typeof src.title === 'string' ? src.title.trim().slice(0, 120) : '',
    description: typeof src.description === 'string' ? src.description.trim().slice(0, 5000) : '',
    tags: uniqStrings(src.tags, 15, 50),
    scenes: (Array.isArray(src.scenes) ? src.scenes : []).map((scene) => normalizeCreatorScene(scene, fallbackCharacter)).filter((scene) => scene.visualPrompt || scene.dialogue || scene.caption),
  };
}

function normalizeCreatorReview(input) {
  if (!input || typeof input !== 'object') return null;
  const scoreNum = Number(input.score);
  return {
    score: Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : null,
    verdict: typeof input.verdict === 'string' ? input.verdict.trim().slice(0, 40) : '',
    strengths: uniqStrings(input.strengths, 8, 240),
    issues: uniqStrings(input.issues, 8, 240),
    fixInstructions: typeof input.fixInstructions === 'string' ? input.fixInstructions.trim().slice(0, 2000) : '',
  };
}

function normalizeCreatorJob(job) {
  if (!job || typeof job !== 'object') return null;
  const createdAt = typeof job.createdAt === 'string' ? job.createdAt : new Date().toISOString();
  const character = creatorCharacterPrompt();
  const script = normalizeCreatorScript(job.script, character);
  const review = normalizeCreatorReview(job.review);
  return {
    id: typeof job.id === 'string' ? job.id : makeId('cjob'),
    topic: typeof job.topic === 'string' ? job.topic.trim().slice(0, 300) : '',
    source: typeof job.source === 'string' ? job.source.trim().slice(0, 80) : '',
    status: normalizeCreatorState(job.status, 'pending'),
    createdAt,
    startedAt: typeof job.startedAt === 'string' ? job.startedAt : null,
    finishedAt: typeof job.finishedAt === 'string' ? job.finishedAt : null,
    stateHistory: normalizeCreatorStateHistory(job.stateHistory, job.status || 'pending', createdAt),
    videoId: typeof job.videoId === 'string' ? job.videoId : null,
    currentScene: Math.max(0, Math.min(99, Math.round(Number(job.currentScene) || 0))),
    sceneCount: Math.max(0, Math.min(99, Math.round(Number(job.sceneCount) || 0))),
    error: typeof job.error === 'string' ? job.error.slice(0, 500) : null,
    script,
    score: review && review.score != null ? review.score : (Number.isFinite(Number(job.score)) ? Math.max(0, Math.min(100, Math.round(Number(job.score)))) : null),
    review,
    publishError: typeof job.publishError === 'string' ? job.publishError.slice(0, 500) : null,
    publishedAt: typeof job.publishedAt === 'string' ? job.publishedAt : null,
    youtubeVideoId: typeof job.youtubeVideoId === 'string' ? job.youtubeVideoId.slice(0, 40) : null,
    youtubeUrl: typeof job.youtubeUrl === 'string' ? job.youtubeUrl.slice(0, 300) : null,
  };
}

function transitionCreatorJob(job, state, extra = {}, note = '') {
  const nextState = normalizeCreatorState(state, job.status || 'pending');
  const at = extra.finishedAt || extra.startedAt || new Date().toISOString();
  return normalizeCreatorJob({
    ...job,
    ...extra,
    status: nextState,
    stateHistory: appendCreatorStateHistory(extra.stateHistory != null ? extra.stateHistory : job.stateHistory, nextState, note, at),
  });
}

function loadCreatorJobs() {
  ensureCreatorStorage();
  const arr = readJsonFileSafe(CREATOR_JOBS_PATH, []);
  return Array.isArray(arr) ? arr.map(normalizeCreatorJob).filter(Boolean) : [];
}

function saveCreatorJobs(jobs) {
  ensureCreatorStorage();
  fs.writeFileSync(CREATOR_JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
}

function updateCreatorJobById(jobId, updater) {
  const jobs = loadCreatorJobs();
  const idx = jobs.findIndex((job) => job.id === jobId);
  if (idx < 0) return null;
  jobs[idx] = normalizeCreatorJob(updater(jobs[idx]));
  saveCreatorJobs(jobs);
  return jobs[idx];
}

function normalizeCreatorVideoRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString();
  const id = typeof record.id === 'string' ? record.id : makeId('cvid');
  const character = creatorCharacterPrompt();
  const script = normalizeCreatorScript(record.script, character);
  const review = normalizeCreatorReview(record.review);
  const publish = (record.publish && typeof record.publish === 'object') ? record.publish : {};
  return {
    id,
    jobId: typeof record.jobId === 'string' ? record.jobId : null,
    createdAt,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : createdAt,
    state: normalizeCreatorState(record.state, 'pending'),
    title: typeof record.title === 'string' ? record.title.trim().slice(0, 120) : script.title,
    description: typeof record.description === 'string' ? record.description.trim().slice(0, 5000) : script.description,
    tags: uniqStrings(record.tags || script.tags, 15, 50),
    topic: typeof record.topic === 'string' ? record.topic.trim().slice(0, 300) : '',
    score: review && review.score != null ? review.score : (Number.isFinite(Number(record.score)) ? Math.max(0, Math.min(100, Math.round(Number(record.score)))) : null),
    review,
    script,
    sceneCount: Math.max(0, Math.min(99, Math.round(Number(record.sceneCount) || script.scenes.length || 0))),
    sceneSeconds: Math.max(0, Math.min(60, Math.round(Number(record.sceneSeconds) || 0))),
    resolution: sanitizeCreatorResolution(record.resolution, DEFAULT_CREATOR_CONFIG.resolution),
    fileName: `${id}.mp4`,
    hasFile: !!record.hasFile,
    currentScene: Math.max(0, Math.min(99, Math.round(Number(record.currentScene) || 0))),
    stateHistory: normalizeCreatorStateHistory(record.stateHistory, record.state || 'pending', createdAt),
    error: typeof record.error === 'string' ? record.error.slice(0, 500) : null,
    publish: {
      attemptedAt: typeof publish.attemptedAt === 'string' ? publish.attemptedAt : null,
      publishedAt: typeof publish.publishedAt === 'string' ? publish.publishedAt : null,
      videoId: typeof publish.videoId === 'string' ? publish.videoId.slice(0, 40) : null,
      url: typeof publish.url === 'string' ? publish.url.slice(0, 300) : null,
      privacyStatus: CREATOR_PRIVACY_STATUSES.has(publish.privacyStatus) ? publish.privacyStatus : DEFAULT_CREATOR_CONFIG.publish.privacyStatus,
      error: typeof publish.error === 'string' ? publish.error.slice(0, 500) : null,
    },
  };
}

function readCreatorVideoRecord(videoId) {
  if (!/^[a-z0-9-]+$/i.test(videoId || '')) return null;
  const filePath = creatorVideoMetaPath(videoId);
  if (!fs.existsSync(filePath)) return null;
  const record = normalizeCreatorVideoRecord(readJsonFileSafe(filePath, null));
  if (!record) return null;
  record.hasFile = fs.existsSync(creatorVideoFilePath(videoId));
  return record;
}

function saveCreatorVideoRecord(record) {
  ensureCreatorStorage();
  const clean = normalizeCreatorVideoRecord(record);
  if (!clean) return null;
  fs.writeFileSync(creatorVideoMetaPath(clean.id), JSON.stringify(clean, null, 2) + '\n');
  clean.hasFile = fs.existsSync(creatorVideoFilePath(clean.id));
  return clean;
}

function transitionCreatorVideo(record, state, extra = {}, note = '') {
  const nextState = normalizeCreatorState(state, record.state || 'pending');
  const updatedAt = extra.updatedAt || new Date().toISOString();
  return normalizeCreatorVideoRecord({
    ...record,
    ...extra,
    state: nextState,
    updatedAt,
    stateHistory: appendCreatorStateHistory(extra.stateHistory != null ? extra.stateHistory : record.stateHistory, nextState, note, updatedAt),
  });
}

function updateCreatorVideoRecord(videoId, updater) {
  const current = readCreatorVideoRecord(videoId);
  if (!current) return null;
  const next = updater(current) || current;
  return saveCreatorVideoRecord({ ...current, ...next, id: videoId });
}

function listCreatorVideos() {
  ensureCreatorStorage();
  let files = [];
  try { files = fs.readdirSync(CREATOR_VIDEOS_DIR).filter((file) => file.endsWith('.json')); } catch { return []; }
  return files
    .map((file) => readCreatorVideoRecord(file.replace(/\.json$/, '')))
    .filter(Boolean)
    .map((video) => ({
      id: video.id,
      jobId: video.jobId,
      title: video.title,
      description: video.description,
      topic: video.topic,
      tags: video.tags,
      score: video.score,
      sceneCount: video.sceneCount,
      sceneSeconds: video.sceneSeconds,
      resolution: video.resolution,
      state: video.state,
      currentScene: video.currentScene,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
      hasFile: video.hasFile,
      publish: video.publish,
    }))
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
}

function creatorCharacterPrompt() {
  return 'A teal-haired AI news anchor woman with a sleek bob haircut, clear expressive eyes, modern broadcast makeup, and a polished futuristic wardrobe';
}

function sanitizeHustlerPublishConfig(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return {
    enabled: !!src.enabled,
    mode: src.mode === 'generic-git' ? 'generic-git' : 'zenn-git',
    repoPath: typeof src.repoPath === 'string' ? src.repoPath.trim().slice(0, 1000) : '',
    genericRepoPath: typeof src.genericRepoPath === 'string' ? src.genericRepoPath.trim().slice(0, 1000) : '',
    genericDir: sanitizeGenericDir(src.genericDir),
    genericFrontmatter: src.genericFrontmatter === 'jekyll' ? 'jekyll' : 'hugo',
    articleType: src.articleType === 'idea' ? 'idea' : 'tech',
    price: Math.max(0, Math.min(50000, Math.round(Number(src.price) || 0))),
    topics: uniqStrings(src.topics, 5, 40).map((s) => s.replace(/\s+/g, '-')),
    publishedFlag: src.publishedFlag !== false,
  };
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
    qualityThreshold: Math.max(0, Math.min(100, Math.round(Number(src.qualityThreshold) || DEFAULT_HUSTLER_CONFIG.qualityThreshold))),
    maxRevisions: Math.max(0, Math.min(5, Math.round(Number(src.maxRevisions) || DEFAULT_HUSTLER_CONFIG.maxRevisions))),
    autoFromExplorer: src.autoFromExplorer !== false,
    cliTimeoutSec: Math.max(1, Math.min(1800, Math.round(Number(src.cliTimeoutSec) || DEFAULT_HUSTLER_CONFIG.cliTimeoutSec))),
    publish: sanitizeHustlerPublishConfig({ ...DEFAULT_HUSTLER_CONFIG.publish, ...(src.publish || {}) }),
    affiliate: sanitizeAffiliateConfig({ ...DEFAULT_HUSTLER_CONFIG.affiliate, ...(src.affiliate || {}) }),
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

function loadTraderConfig(paths = null) {
  const p = ensureTraderStorage(paths);
  const stored = readJsonFileSafe(p.configPath, DEFAULT_TRADER_CONFIG);
  return sanitizeTraderConfig({ ...DEFAULT_TRADER_CONFIG, ...stored });
}

function saveTraderConfig(config, paths = null) {
  const p = ensureTraderStorage(paths);
  const clean = sanitizeTraderConfig(config);
  fs.writeFileSync(p.configPath, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

function loadTraderFetchState(paths = null) {
  const p = ensureTraderStorage(paths);
  const stored = readJsonFileSafe(p.statePath, DEFAULT_TRADER_FETCH_STATE);
  return sanitizeTraderFetchState({ ...DEFAULT_TRADER_FETCH_STATE, ...stored });
}

function saveTraderFetchState(state, paths = null) {
  const p = ensureTraderStorage(paths);
  const clean = sanitizeTraderFetchState({ ...DEFAULT_TRADER_FETCH_STATE, ...(state || {}) });
  fs.writeFileSync(p.statePath, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

function loadTraderPortfolio(paths = null, config = loadTraderConfig(paths)) {
  const p = ensureTraderStorage(paths);
  const stored = readJsonFileSafe(p.portfolioPath, makeDefaultTraderPortfolio(config.startBalance));
  return sanitizeTraderPortfolio(stored, config);
}

function saveTraderPortfolio(portfolio, paths = null, config = loadTraderConfig(paths)) {
  const p = ensureTraderStorage(paths);
  const clean = sanitizeTraderPortfolio(portfolio, config);
  fs.writeFileSync(p.portfolioPath, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

function resetTraderPortfolio(paths = null, config = loadTraderConfig(paths)) {
  return saveTraderPortfolio(makeDefaultTraderPortfolio(config.startBalance), paths, config);
}

function normalizeTraderPriceRecord(input, config) {
  const vs = traderPriceField(config.vsCurrency);
  const changeKey = traderChangeField(config.vsCurrency);
  const src = (input && typeof input === 'object') ? input : {};
  const prices = {};
  for (const asset of config.assets) {
    const raw = src.prices && src.prices[asset];
    if (!raw || typeof raw !== 'object') continue;
    const price = Number(raw[vs]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const item = { [vs]: price };
    const change = Number(raw[changeKey]);
    if (Number.isFinite(change)) item[changeKey] = change;
    prices[asset] = item;
  }
  return {
    ts: typeof src.ts === 'string' ? src.ts : new Date().toISOString(),
    prices,
  };
}

function loadTraderPriceHistory(paths = null, config = loadTraderConfig(paths)) {
  const p = ensureTraderStorage(paths);
  let text = '';
  try { text = fs.readFileSync(p.pricesPath, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = normalizeTraderPriceRecord(JSON.parse(line), config);
      if (Object.keys(row.prices).length) out.push(row);
    } catch { /* ignore broken line */ }
  }
  return out.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
}

function appendTraderPriceRecord(prices, paths = null, config = loadTraderConfig(paths), ts = new Date().toISOString()) {
  const p = ensureTraderStorage(paths);
  const record = normalizeTraderPriceRecord({ ts, prices }, config);
  if (!Object.keys(record.prices).length) throw new Error('価格データが空です');
  fs.appendFileSync(p.pricesPath, JSON.stringify(record) + '\n');
  return record;
}

function buildTraderSeries(records, asset, vsCurrency) {
  const field = traderPriceField(vsCurrency);
  const changeKey = traderChangeField(vsCurrency);
  return records
    .map((row) => {
      const atMs = Date.parse(row.ts);
      const price = Number(row.prices && row.prices[asset] && row.prices[asset][field]);
      const change24h = Number(row.prices && row.prices[asset] && row.prices[asset][changeKey]);
      if (!Number.isFinite(atMs) || !Number.isFinite(price) || price <= 0) return null;
      return { ts: row.ts, atMs, price, api24hChange: Number.isFinite(change24h) ? change24h : null };
    })
    .filter(Boolean)
    .sort((a, b) => a.atMs - b.atMs);
}

function averageNumbers(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function findTraderReferencePrice(series, targetMs) {
  let before = null;
  let after = null;
  for (const point of series) {
    if (point.atMs <= targetMs) before = point;
    else if (!after) after = point;
  }
  return before || after || null;
}

function computeRsi(series, periods = 14) {
  if (series.length <= periods) return null;
  const tail = series.slice(-(periods + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < tail.length; i++) {
    const diff = tail[i].price - tail[i - 1].price;
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / periods;
  const avgLoss = losses / periods;
  if (!avgLoss && !avgGain) return 50;
  if (!avgLoss) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function pctChange(current, reference) {
  if (!Number.isFinite(current) || !Number.isFinite(reference) || reference <= 0) return null;
  return ((current - reference) / reference) * 100;
}

function computeTraderIndicators(records, config, nowMs = null) {
  const out = {};
  for (const asset of config.assets) {
    const series = buildTraderSeries(records, asset, config.vsCurrency);
    const latest = series[series.length - 1] || null;
    const pointNow = latest ? latest.atMs : (nowMs || Date.now());
    const d24 = pointNow - 24 * 60 * 60 * 1000;
    const d7 = pointNow - 7 * 24 * 60 * 60 * 1000;
    const recent24h = series.filter((point) => point.atMs >= d24);
    const recent7d = series.filter((point) => point.atMs >= d7);
    const ref24 = findTraderReferencePrice(series, d24);
    const ref7 = findTraderReferencePrice(series, d7);
    out[asset] = {
      latestPrice: latest ? latest.price : null,
      api24hChange: latest ? latest.api24hChange : null,
      sma24h: averageNumbers(recent24h.map((point) => point.price)),
      sma7d: averageNumbers(recent7d.map((point) => point.price)),
      rsi14: computeRsi(series, 14),
      change24h: latest && ref24 ? pctChange(latest.price, ref24.price) : null,
      change7d: latest && ref7 ? pctChange(latest.price, ref7.price) : null,
      samples: series.length,
      lastTs: latest ? latest.ts : null,
    };
  }
  return out;
}

function normalizeHustlerJob(job) {
  if (!job || typeof job !== 'object') return null;
  const type = HUSTLER_JOB_TYPES.has(job.type) ? job.type : 'custom';
  const createdAt = typeof job.createdAt === 'string' ? job.createdAt : new Date().toISOString();
  const status = normalizeHustlerState(job.status, 'pending');
  const review = normalizeReviewPayload(job.review);
  const publishTarget = normalizePublishTarget(job.publishTarget, defaultPublishTargetForType(type));
  return {
    id: typeof job.id === 'string' ? job.id : makeId('job'),
    type,
    topic: typeof job.topic === 'string' ? job.topic.slice(0, 500) : '',
    prompt: typeof job.prompt === 'string' ? job.prompt.slice(0, 12000) : '',
    publishTarget,
    affiliateLinkLabels: uniqStrings(job.affiliateLinkLabels, 20, 120),
    status,
    createdAt,
    startedAt: typeof job.startedAt === 'string' ? job.startedAt : null,
    finishedAt: typeof job.finishedAt === 'string' ? job.finishedAt : null,
    outputId: typeof job.outputId === 'string' ? job.outputId : null,
    error: typeof job.error === 'string' ? job.error.slice(0, 500) : null,
    score: review && review.score != null ? review.score : (Number.isFinite(Number(job.score)) ? Math.max(0, Math.min(100, Math.round(Number(job.score)))) : null),
    review,
    revisionCount: Math.max(0, Math.min(20, Math.round(Number(job.revisionCount) || 0))),
    retryCount: Math.max(0, Math.min(20, Math.round(Number(job.retryCount) || 0))),
    resumeFromDraft: !!job.resumeFromDraft,
    stateHistory: normalizeStateHistory(job.stateHistory, status, createdAt),
    slug: typeof job.slug === 'string' ? job.slug.slice(0, 60) : null,
    publishedAt: typeof job.publishedAt === 'string' ? job.publishedAt : null,
    publishError: typeof job.publishError === 'string' ? job.publishError.slice(0, 500) : null,
    source: typeof job.source === 'string' ? job.source.slice(0, 80) : '',
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
    if (HUSTLER_RESTARTABLE_STATUSES.has(job.status)) {
      job.status = 'pending';
      job.error = 'サーバー再起動により待機へ戻しました';
      job.stateHistory = appendStateHistory(job.stateHistory, 'pending', 'サーバー再起動により待機へ戻しました');
      changed = true;
    }
  }
  if (changed) saveHustlerJobs(jobs);
}

function getHustlerResumeDraftRecord(job) {
  if (!job || !requiresHustlerReview(job.type) || !job.outputId) return null;
  if (!job.resumeFromDraft && job.status !== 'error') return null;
  const output = readHustlerOutputRecord(job.outputId);
  if (!output) return null;
  const rawBody = String(output.rawBody || output.body || '').trim();
  if (!rawBody) return null;
  return {
    output,
    rawBody,
    revisionCount: Math.max(0, output.revisionCount || job.revisionCount || 0),
  };
}

function queueRetryableHustlerErrors(note = '自動リトライ待ちに戻しました') {
  const jobs = loadHustlerJobs();
  let changed = false;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (job.status !== 'error' || job.retryCount >= 2) continue;
    const resume = getHustlerResumeDraftRecord({ ...job, resumeFromDraft: true });
    jobs[i] = transitionHustlerJob(job, 'pending', {
      startedAt: null,
      finishedAt: null,
      error: null,
      publishError: null,
      resumeFromDraft: !!resume,
      retryCount: job.retryCount + 1,
    }, `${note}${resume ? ' (保存済みドラフトから再開)' : ''}`);
    if (resume) {
      saveHustlerOutputRecord(transitionHustlerOutput(resume.output, 'pending', {
        publishError: null,
      }, '再実行待ちに戻しました'));
    }
    changed = true;
  }
  if (changed) saveHustlerJobs(jobs);
  return changed;
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

function loadCreatorProviderConfig() {
  const base = loadSecretaryConfig();
  const provider = process.env.CREATOR_PROVIDER || 'auto';
  const model = process.env.CREATOR_MODEL || base.model || DEFAULT_SECRETARY_MODEL;
  let mode;
  if (provider === 'off') mode = 'off';
  else if (provider === 'api') mode = base.apiKey ? 'api' : 'off';
  else if (provider === 'cli') mode = base.cli ? 'cli' : 'off';
  else mode = base.cli ? 'cli' : (base.apiKey ? 'api' : 'off');
  return { mode, apiKey: base.apiKey, model, cli: base.cli };
}

function parseGoogleScopes(scopeText) {
  return new Set(String(scopeText || '').split(/\s+/).map((item) => item.trim()).filter(Boolean));
}

function getGoogleLinkStatus() {
  const creds = loadGoogleCreds();
  const tok = loadGoogleToken();
  const scopes = parseGoogleScopes(tok && tok.scope);
  return {
    configured: !!creds,
    connected: !!(creds && tok && tok.refresh_token),
    scopeText: tok && typeof tok.scope === 'string' ? tok.scope : '',
    hasYoutubeUploadScope: scopes.has(YOUTUBE_UPLOAD_SCOPE),
  };
}

function hasUnfinishedCreatorJobForTopic(topic) {
  const key = normalizeTopicKey(topic);
  if (!key) return false;
  return loadCreatorJobs().some((job) => (
    CREATOR_UNFINISHED_STATUSES.has(job.status)
    && normalizeTopicKey(job.topic) === key
  ));
}

function enqueueCreatorJob(input, opts = {}) {
  const topic = typeof input.topic === 'string' ? input.topic.trim().slice(0, 300) : '';
  if (!topic) throw new Error('トピックを入力してください');
  if (opts.dedupeTopic && hasUnfinishedCreatorJobForTopic(topic)) {
    const existing = loadCreatorJobs().find((job) => (
      CREATOR_UNFINISHED_STATUSES.has(job.status)
      && normalizeTopicKey(job.topic) === normalizeTopicKey(topic)
    ));
    return { queued: false, job: existing || null };
  }
  const createdAt = new Date().toISOString();
  const job = normalizeCreatorJob({
    id: makeId('cjob'),
    topic,
    source: opts.source || '',
    status: 'pending',
    createdAt,
    stateHistory: appendCreatorStateHistory([], 'pending', opts.note || '', createdAt),
  });
  const jobs = loadCreatorJobs();
  jobs.push(job);
  saveCreatorJobs(jobs);
  return { queued: true, job };
}

function maybeQueueCreatorFromExplorer(topic) {
  const config = loadCreatorConfig();
  if (!config.autoFromExplorer) return null;
  return enqueueCreatorJob({ topic }, {
    dedupeTopic: true,
    source: 'explorer',
    note: '探検家の新着レポートから自動追加',
  });
}

function stripJsonFence(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return s.trim();
}

function parseCreatorScript(text, expectedSceneCount) {
  const parsed = JSON.parse(stripJsonFence(text));
  const script = normalizeCreatorScript(parsed, creatorCharacterPrompt());
  if (!script.title || !script.description || !script.scenes.length) {
    throw new Error('台本JSONの必須項目が不足しています');
  }
  if (expectedSceneCount && script.scenes.length !== expectedSceneCount) {
    throw new Error(`scene数が不正です: expected ${expectedSceneCount}, got ${script.scenes.length}`);
  }
  return script;
}

function parseCreatorReview(text) {
  const parsed = JSON.parse(stripJsonFence(text));
  const review = normalizeCreatorReview(parsed);
  if (!review || review.score == null) throw new Error('審査JSONの形式が不正です');
  return review;
}

function appendDisclosureText(description, disclosureText) {
  const body = String(description || '').trim();
  const disclosure = String(disclosureText || '').trim();
  if (!disclosure) return body;
  if (!body) return disclosure;
  return body.endsWith(disclosure) ? body : `${body}\n\n${disclosure}`;
}

function creatorScriptPrompt(job, config) {
  const explorerBits = pickExplorerContext(job.topic);
  const explorerText = explorerBits.length
    ? `\n\n参考に使える保存済みの探検家レポート:\n${explorerBits.map((item) => `### ${item.topic}\n${item.report}`).join('\n\n')}`
    : '';
  const character = creatorCharacterPrompt();
  return `あなたは日本語のショート動画企画ディレクターです。返答は JSON のみで、コードフェンスや前置きは禁止です。

テーマ: ${job.topic}
想定媒体: YouTube Shorts
構成: ${config.sceneCount}シーン
各シーン長: 約${config.sceneSeconds}秒

JSON スキーマ:
{
  "title": "動画タイトル",
  "description": "概要欄",
  "tags": ["tag1", "tag2"],
  "scenes": [
    {
      "visualPrompt": "English only. Must include the exact recurring character description.",
      "dialogue": "日本語の短いセリフ",
      "caption": "画面に焼き込む短い日本語字幕"
    }
  ]
}

必須ルール:
- scenes は必ず ${config.sceneCount} 件ちょうど。
- visualPrompt は英語のみ。毎回必ず次のキャラ記述を自然に含める:
  "${character}"
- visualPrompt には画作り、カメラ、照明、背景、動き、ニュースキャスターらしさを具体的に書く。
- dialogue は H3 にそのまま読ませる日本語セリフ。1シーン1〜2文、短く、自然に。
- caption は日本語で短く、スマホ視聴で読める長さにする。
- タイトルはフック重視だが誇張しすぎない。
- description は動画内容の要約と価値を簡潔に書く。断定しすぎず、誤情報リスクを抑える。
- tags は最大10個、短く。
- 同じティール髪キャラが全シーンで継続して登場する前提で作る。
- 事実関係が曖昧なら断定を避け、一般論として安全な表現にする。${explorerText}`;
}

function creatorReviewPrompt(script, qualityThreshold) {
  return `次のショート動画企画を厳しく審査してください。返答は JSON のみです。

評価対象:
- タイトル
- 概要欄(description)
- シーン構成

採点ルーブリック(合計100点):
- 視聴価値
- フックの強さ
- 構成の分かりやすさ
- 誤情報リスクの低さ

判定:
- ${qualityThreshold}点以上なら verdict を "pass"
- 未満なら verdict を "revise"

JSON:
{
  "score": 0,
  "verdict": "pass or revise",
  "strengths": ["..."],
  "issues": ["..."],
  "fixInstructions": "改善指示"
}

タイトル:
${script.title}

概要欄:
${script.description}

タグ:
${(script.tags || []).join(', ')}

シーン:
${script.scenes.map((scene, idx) => `## Scene ${idx + 1}\nvisualPrompt: ${scene.visualPrompt}\ndialogue: ${scene.dialogue}\ncaption: ${scene.caption}`).join('\n\n')}`;
}

function creatorMetadataRevisionPrompt(script, review) {
  return `次のショート動画企画について、動画本体は変えずにタイトルと概要欄だけを書き直してください。返答は JSON のみです。

JSON:
{
  "title": "改善後タイトル",
  "description": "改善後概要欄"
}

改善指示:
${review && review.fixInstructions ? review.fixInstructions : 'フックと分かりやすさを改善してください。'}

主な課題:
${review && review.issues && review.issues.length ? review.issues.map((issue) => `- ${issue}`).join('\n') : '- なし'}

シーン要約:
${script.scenes.map((scene, idx) => `Scene ${idx + 1}: ${scene.dialogue} / ${scene.caption}`).join('\n')}

現在のタイトル:
${script.title}

現在の概要欄:
${script.description}`;
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

function transitionHustlerJob(job, state, extra = {}, note = '') {
  const nextState = normalizeHustlerState(state, job.status || 'pending');
  const at = extra.finishedAt || extra.startedAt || new Date().toISOString();
  return normalizeHustlerJob({
    ...job,
    ...extra,
    status: nextState,
    stateHistory: appendStateHistory(extra.stateHistory != null ? extra.stateHistory : job.stateHistory, nextState, note, at),
  });
}

function replaceHustlerJob(jobs, job) {
  const idx = jobs.findIndex((x) => x.id === job.id);
  if (idx >= 0) jobs[idx] = normalizeHustlerJob(job);
  return idx;
}

function updateHustlerJobById(jobId, updater) {
  const jobs = loadHustlerJobs();
  const idx = jobs.findIndex((j) => j.id === jobId);
  if (idx < 0) return null;
  const next = normalizeHustlerJob(updater(jobs[idx]));
  jobs[idx] = next;
  saveHustlerJobs(jobs);
  return next;
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

function hustlerReviewSystemPrompt() {
  return `あなたは技術記事ドラフトの審査担当です。返答は JSON のみで、コードフェンス・前置き・補足説明を付けません。`;
}

function resolveAffiliateLinksForJob(job, config, opts = {}) {
  const affiliate = sanitizeAffiliateConfig(config && config.affiliate);
  const allLinks = affiliate.links || [];
  const requested = uniqStrings(job && job.affiliateLinkLabels, 20, 120);
  if (!requested.length) return allLinks;
  const map = new Map(allLinks.map((link) => [normalizeTopicKey(link.label), link]));
  const missing = [];
  const selected = [];
  for (const label of requested) {
    const hit = map.get(normalizeTopicKey(label));
    if (!hit) missing.push(label);
    else selected.push(hit);
  }
  if (missing.length && opts.strict) {
    throw new Error(`affiliate リンクが見つかりません: ${missing.join(', ')}`);
  }
  return selected;
}

function buildAffiliateLinkPromptText(job, config) {
  const affiliate = sanitizeAffiliateConfig(config && config.affiliate);
  const selected = resolveAffiliateLinksForJob(job, config);
  const links = selected.length ? selected : affiliate.links;
  const modeLine = selected.length
    ? '以下の指定リンクをすべて本文で自然に扱ってください。'
    : '以下の候補リンクからテーマに本当に合うものだけを選び、本文で自然に扱ってください。';
  const listText = links.length
    ? links.map((link) => `- ${link.label}${link.note ? `: ${link.note}` : ''}`).join('\n')
    : '- なし';
  return {
    affiliate,
    selected,
    links,
    text: `${modeLine}

使用可能なリンク一覧:
${listText}`,
  };
}

function buildHustlerJobPrompt(job, config) {
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
- 箇条書きに逃げず、本文は段落としてしっかり書く

出力ルール:
- 記事末尾に 1 行だけ HTML コメントで次の形式を必ず追加する: <!-- HUSTLER_META {"title":"公開用タイトル","emoji":"📝","topics":["topic1","topic2"]} -->
- title は実際に公開したい最有力タイトル1本、emoji は記事内容に合う絵文字1文字、topics は記事に合う短いトピックを最大5個${explorerText}`,
      useResearch: false,
    };
  }
  if (job.type === 'affiliate_article') {
    const { affiliate, text } = buildAffiliateLinkPromptText(job, config);
    return {
      prompt: `テーマ: ${subject || '未指定'}

読者の課題解決を最優先にした、日本語の比較 / レビュー記事を Markdown で作ってください。初心者にも判断材料が伝わるよう、メリットだけでなく向き・不向きや選び方まで書いてください。

必須ルール:
- 記事冒頭に次の開示文言を、この文面のまま必ず入れる: ${affiliate.disclosure}
- 実URLは絶対に書かない。リンクは必ず {{aff:商品/サービス名}} のプレースホルダだけを使う
- プレースホルダの label は下の一覧にある表記を1文字も変えない
- 広告色を強くしすぎず、比較基準・向いている読者・注意点を具体的に書く
- Markdown本文のみを出力する

推奨構成:
# タイトル
導入
比較ポイント
候補ごとのレビュー
選び方
まとめ

${text}`,
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

function buildHustlerReviewPrompt(job, content, qualityThreshold = 75) {
  if (job.type === 'affiliate_article') {
    return `次のアフィリエイト記事ドラフトを、日本語読者向けに厳しく審査してください。

採点ルーブリック(合計100点):
- 正確性
- 読者課題への適合度
- 比較 / レビューとしての具体性
- 構成・読みやすさ
- 広告臭が強すぎず、読者価値が十分にあるか
- タイトル訴求力

判定ルール:
- ${qualityThreshold}点以上を合格候補として verdict を "pass"、未満を "revise" にしてください
- strengths と issues はそれぞれ箇条書き文字列の配列
- fixInstructions は、次回の書き直しにそのまま使える具体的な改善指示を 1 つの文字列で返してください
- JSON 以外は返さない

ジョブ種別: ${job.type}
テーマ: ${(job.topic || job.prompt || '').trim() || '未指定'}

ドラフト本文:
${content}`;
  }
  return `次の技術記事ドラフトを、日本語読者向けに厳しく審査してください。

採点ルーブリック(各20点、合計100点):
- 正確性
- 独自性・具体性
- 構成・読みやすさ
- タイトル訴求力
- 需要(検索・SNSでの関心)

判定ルール:
- ${qualityThreshold}点以上を合格候補として verdict を "pass"、未満を "revise" にしてください
- strengths と issues はそれぞれ箇条書き文字列の配列
- fixInstructions は、次回の書き直しにそのまま使える具体的な改善指示を 1 つの文字列で返してください
- JSON 以外は返さない

ジョブ種別: ${job.type}
テーマ: ${(job.topic || job.prompt || '').trim() || '未指定'}

ドラフト本文:
${content}`;
}

function buildHustlerRevisionPrompt(job, draft, review, revisionCount, config) {
  if (job.type === 'affiliate_article') {
    const { affiliate, text } = buildAffiliateLinkPromptText(job, config);
    return `次のアフィリエイト記事ドラフトを、日本語の比較 / レビュー記事として全面的に書き直してください。

要件:
- 元のテーマと読者層は維持する
- 記事冒頭に次の開示文言を、この文面のまま必ず入れる: ${affiliate.disclosure}
- 実URLは書かない。リンクは必ず {{aff:商品/サービス名}} 形式だけを使う
- プレースホルダの label は一覧どおりに使う
- 指摘をすべて反映し、広告臭を抑えつつ読者価値を増やす
- 比較観点、向いている人、注意点、判断基準を具体化する
- Markdown本文のみを出力する

${text}

今回の改善指示:
${review && review.fixInstructions ? review.fixInstructions : '読者価値と比較の具体性を改善してください。'}

主な課題:
${(review && review.issues && review.issues.length) ? review.issues.map((x) => `- ${x}`).join('\n') : '- 特記事項なし'}

元ドラフト:
${draft}

これは ${revisionCount} 回目のリライトです。出力は修正版 Markdown 本文のみ。`;
  }
  return `次の技術記事ドラフトを、日本語の技術ブログ記事として全面的に書き直してください。

要件:
- 元のテーマと読者層は維持する
- 指摘をすべて反映し、具体例と実務的な価値を増やす
- 本文は読み物として自然な段落中心で書く
- 記事末尾に 1 行だけ HTML コメントで次の形式を必ず追加する: <!-- HUSTLER_META {"title":"公開用タイトル","emoji":"📝","topics":["topic1","topic2"]} -->

今回の改善指示:
${review && review.fixInstructions ? review.fixInstructions : '具体性・構成・タイトル訴求力を改善してください。'}

主な課題:
${(review && review.issues && review.issues.length) ? review.issues.map((x) => `- ${x}`).join('\n') : '- 特記事項なし'}

元ドラフト:
${draft}

これは ${revisionCount} 回目のリライトです。出力は修正版 Markdown 本文のみ。`;
}

function stripHustlerMetaComment(md) {
  return String(md || '').replace(/\n?<!--\s*HUSTLER_META\s*(\{[\s\S]*?\})\s*-->\s*$/m, '').trim();
}

function ensureAffiliateDisclosure(body, disclosure) {
  const text = String(disclosure || DEFAULT_HUSTLER_CONFIG.affiliate.disclosure).trim();
  const clean = String(body || '').trim();
  if (!text) return clean;
  const headPattern = new RegExp(`^(?:${escapeRegExp(text)}\\s*)+`, 'u');
  const withoutHead = clean.replace(headPattern, '').trim();
  return withoutHead ? `${text}\n\n${withoutHead}` : text;
}

function replaceAffiliatePlaceholders(body, links) {
  const map = new Map();
  for (const link of Array.isArray(links) ? links : []) {
    if (!link || !link.label || !link.url) continue;
    map.set(normalizeTopicKey(link.label), link.url);
  }
  const unknown = new Set();
  const replaced = String(body || '').replace(/\{\{\s*aff\s*:\s*([^}]+?)\s*\}\}/gi, (_all, rawLabel) => {
    const label = String(rawLabel || '').trim();
    const url = map.get(normalizeTopicKey(label));
    if (!url) {
      unknown.add(label);
      return `{{aff:${label}}}`;
    }
    return url;
  });
  if (unknown.size) {
    throw new Error(`未知の affiliate プレースホルダがあります: ${[...unknown].join(', ')}`);
  }
  return replaced;
}

function finalizeHustlerContentForStorage(job, content, config) {
  const body = String(content || '').trim();
  if (job.type !== 'affiliate_article') return body;
  const affiliate = sanitizeAffiliateConfig(config && config.affiliate);
  const selected = resolveAffiliateLinksForJob(job, config, { strict: true });
  const links = selected.length ? selected : affiliate.links;
  return replaceAffiliatePlaceholders(ensureAffiliateDisclosure(body, affiliate.disclosure), links);
}

function extractHustlerEmbeddedMeta(md) {
  const m = String(md || '').match(/<!--\s*HUSTLER_META\s*(\{[\s\S]*?\})\s*-->\s*$/m);
  if (!m) return {};
  try {
    const parsed = JSON.parse(m[1]);
    return {
      title: typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 160) : '',
      emoji: typeof parsed.emoji === 'string' ? parsed.emoji.trim().slice(0, 8) : '',
      topics: uniqStrings(parsed.topics, 5, 40).map((s) => s.replace(/\s+/g, '-')),
    };
  } catch {
    return {};
  }
}

function deriveArticleTitle(body, fallback) {
  const meta = extractHustlerEmbeddedMeta(body);
  if (meta.title) return meta.title;
  const cleaned = stripHustlerMetaComment(body);
  for (const line of cleaned.split('\n')) {
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) return h1[1].trim().slice(0, 160);
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (item) return item[1].trim().slice(0, 160);
  }
  return (fallback || '無題の記事').trim().slice(0, 160);
}

function deriveArticleTopics(body, seedTopics = []) {
  const meta = extractHustlerEmbeddedMeta(body);
  if (meta.topics && meta.topics.length) return meta.topics.slice(0, 5);
  const out = uniqStrings(seedTopics, 5, 40).map((s) => s.replace(/\s+/g, '-'));
  return out.slice(0, 5);
}

function deriveArticleEmoji(body) {
  const meta = extractHustlerEmbeddedMeta(body);
  return meta.emoji || '📝';
}

function outputFrontMatter(meta) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === undefined) continue;
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
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
      try { meta[key] = JSON.parse(value); }
      catch { meta[key] = value; }
    }
  }
  return { meta, body };
}

function normalizeHustlerOutputRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString();
  const review = normalizeReviewPayload(record.review);
  const body = typeof record.body === 'string' ? record.body : '';
  const rawBody = typeof record.rawBody === 'string' ? record.rawBody : body;
  const cleanBody = stripHustlerMetaComment(body);
  const type = HUSTLER_JOB_TYPES.has(record.type) ? record.type : 'custom';
  return {
    id: typeof record.id === 'string' ? record.id : makeId('out'),
    type,
    topic: typeof record.topic === 'string' ? record.topic : '',
    createdAt,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : createdAt,
    jobId: typeof record.jobId === 'string' ? record.jobId : null,
    publishTarget: normalizePublishTarget(record.publishTarget, defaultPublishTargetForType(type)),
    affiliateLinkLabels: uniqStrings(record.affiliateLinkLabels, 20, 120),
    state: normalizeHustlerState(record.state, 'approved'),
    history: normalizeStateHistory(record.history, record.state || 'approved', createdAt),
    review,
    score: review && review.score != null ? review.score : (Number.isFinite(Number(record.score)) ? Math.max(0, Math.min(100, Math.round(Number(record.score)))) : null),
    verdict: review ? review.verdict : (typeof record.verdict === 'string' ? record.verdict.slice(0, 120) : ''),
    strengths: review ? review.strengths : uniqStrings(record.strengths, 8, 240),
    issues: review ? review.issues : uniqStrings(record.issues, 8, 240),
    fixInstructions: review ? review.fixInstructions : (typeof record.fixInstructions === 'string' ? record.fixInstructions.slice(0, 4000) : ''),
    revisionCount: Math.max(0, Math.min(20, Math.round(Number(record.revisionCount) || 0))),
    publishedAt: typeof record.publishedAt === 'string' ? record.publishedAt : null,
    slug: typeof record.slug === 'string' ? record.slug.slice(0, 60) : null,
    publishError: typeof record.publishError === 'string' ? record.publishError.slice(0, 500) : null,
    publishAttemptedAt: typeof record.publishAttemptedAt === 'string' ? record.publishAttemptedAt : null,
    emoji: typeof record.emoji === 'string' && record.emoji.trim() ? record.emoji.trim().slice(0, 8) : deriveArticleEmoji(rawBody),
    articleTitle: typeof record.articleTitle === 'string' && record.articleTitle.trim()
      ? record.articleTitle.trim().slice(0, 160)
      : deriveArticleTitle(rawBody, record.topic || record.type || '無題の記事'),
    articleTopics: uniqStrings(record.articleTopics, 5, 40).map((s) => s.replace(/\s+/g, '-')).length
      ? uniqStrings(record.articleTopics, 5, 40).map((s) => s.replace(/\s+/g, '-'))
      : deriveArticleTopics(rawBody, []),
    body: cleanBody,
    rawBody,
    preview: cleanBody.split('\n').find((line) => line.trim())?.slice(0, 120) || '',
  };
}

function readHustlerOutputRecord(outputId) {
  if (!/^[a-z0-9-]+$/i.test(outputId || '')) return null;
  const filePath = path.join(HUSTLER_OUTPUTS_DIR, `${outputId}.md`);
  if (!fs.existsSync(filePath)) return null;
  const { meta, body } = parseOutputFile(filePath);
  return normalizeHustlerOutputRecord({ id: outputId, ...meta, body, rawBody: body });
}

function saveHustlerOutputRecord(output) {
  ensureHustlerStorage();
  const clean = normalizeHustlerOutputRecord(output);
  if (!clean) return null;
  const { id, body, rawBody, preview, ...meta } = clean;
  const filePath = path.join(HUSTLER_OUTPUTS_DIR, `${id}.md`);
  fs.writeFileSync(filePath, outputFrontMatter(meta) + String(rawBody || body || '').trim() + '\n');
  return normalizeHustlerOutputRecord({ ...meta, id, body: rawBody, rawBody });
}

function createHustlerOutput(job, content, extra = {}) {
  const outputId = makeId('out');
  const createdAt = extra.createdAt || new Date().toISOString();
  const rawBody = String(content || '').trim();
  const state = normalizeHustlerState(extra.state, 'approved');
  const output = saveHustlerOutputRecord({
    id: outputId,
    type: job.type,
    topic: job.topic || job.prompt || '',
    createdAt,
    updatedAt: createdAt,
    jobId: job.id,
    publishTarget: job.publishTarget,
    affiliateLinkLabels: job.affiliateLinkLabels,
    state,
    history: appendStateHistory([], state, extra.note || '', createdAt),
    review: extra.review || null,
    score: extra.score != null ? extra.score : null,
    revisionCount: Math.max(0, Math.round(Number(extra.revisionCount) || 0)),
    publishError: extra.publishError || null,
    slug: extra.slug || null,
    publishedAt: extra.publishedAt || null,
    emoji: extra.emoji || deriveArticleEmoji(rawBody),
    articleTitle: extra.articleTitle || deriveArticleTitle(rawBody, job.topic || job.prompt || '無題の記事'),
    articleTopics: extra.articleTopics || deriveArticleTopics(rawBody, [job.topic].filter(Boolean)),
    body: rawBody,
    rawBody,
  });
  return output;
}

function updateHustlerOutputRecord(outputId, updater) {
  const current = readHustlerOutputRecord(outputId);
  if (!current) return null;
  const patch = updater(current) || current;
  return saveHustlerOutputRecord({ ...current, ...patch, id: outputId });
}

function transitionHustlerOutput(output, state, extra = {}, note = '') {
  const nextState = normalizeHustlerState(state, output.state || 'approved');
  const rawBody = extra.rawBody != null ? String(extra.rawBody) : output.rawBody;
  const review = extra.review !== undefined ? normalizeReviewPayload(extra.review) : output.review;
  return normalizeHustlerOutputRecord({
    ...output,
    ...extra,
    state: nextState,
    history: appendStateHistory(extra.history != null ? extra.history : output.history, nextState, note, extra.updatedAt || new Date().toISOString()),
    updatedAt: extra.updatedAt || new Date().toISOString(),
    review,
    score: review && review.score != null ? review.score : (extra.score != null ? extra.score : output.score),
    verdict: review ? review.verdict : output.verdict,
    strengths: review ? review.strengths : output.strengths,
    issues: review ? review.issues : output.issues,
    fixInstructions: review ? review.fixInstructions : output.fixInstructions,
    emoji: extra.emoji || deriveArticleEmoji(rawBody),
    articleTitle: extra.articleTitle || deriveArticleTitle(rawBody, output.topic || output.articleTitle),
    articleTopics: extra.articleTopics || deriveArticleTopics(rawBody, output.articleTopics || []),
    body: rawBody,
    rawBody,
  });
}

function listHustlerOutputs() {
  ensureHustlerStorage();
  let files = [];
  try { files = fs.readdirSync(HUSTLER_OUTPUTS_DIR).filter((f) => f.endsWith('.md')); } catch { return []; }
  const out = [];
  for (const file of files) {
    try {
      const output = readHustlerOutputRecord(file.replace(/\.md$/, ''));
      if (!output) continue;
      out.push({
        id: output.id,
        type: output.type,
        topic: output.topic,
        publishTarget: output.publishTarget,
        createdAt: output.createdAt,
        updatedAt: output.updatedAt,
        jobId: output.jobId,
        preview: output.preview,
        state: output.state,
        score: output.score,
        revisionCount: output.revisionCount,
        strengths: output.strengths,
        issues: output.issues,
        slug: output.slug,
        publishedAt: output.publishedAt,
        articleTitle: output.articleTitle,
        publishError: output.publishError,
      });
    } catch { /* ignore broken file */ }
  }
  out.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  return out;
}

function getHustlerOutput(id) {
  const output = readHustlerOutputRecord(id);
  if (!output) return null;
  return {
    id: output.id,
    type: output.type,
    topic: output.topic,
    createdAt: output.createdAt,
    updatedAt: output.updatedAt,
    jobId: output.jobId,
    body: output.body,
    publishTarget: output.publishTarget,
    affiliateLinkLabels: output.affiliateLinkLabels,
    state: output.state,
    score: output.score,
    verdict: output.verdict,
    strengths: output.strengths,
    issues: output.issues,
    fixInstructions: output.fixInstructions,
    revisionCount: output.revisionCount,
    slug: output.slug,
    publishedAt: output.publishedAt,
    publishError: output.publishError,
    emoji: output.emoji,
    articleTitle: output.articleTitle,
    articleTopics: output.articleTopics,
    history: output.history,
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

function normalizeTopicKey(topic) {
  return String(topic || '').trim().toLowerCase();
}

function hasUnfinishedHustlerJobForTopic(topic) {
  const key = normalizeTopicKey(topic);
  if (!key) return false;
  return loadHustlerJobs().some((job) => (
    job.type === 'article_draft'
    && HUSTLER_UNFINISHED_TOPIC_STATUSES.has(job.status)
    && normalizeTopicKey(job.topic) === key
  ));
}

function enqueueHustlerJob(input, opts = {}) {
  const type = HUSTLER_JOB_TYPES.has(input && input.type) ? input.type : 'custom';
  const topic = typeof input.topic === 'string' ? input.topic.trim().slice(0, 500) : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim().slice(0, 12000) : '';
  const publishTarget = normalizePublishTarget(input && input.publishTarget, defaultPublishTargetForType(type));
  const affiliateLinkLabels = uniqStrings(input && input.affiliateLinkLabels, 20, 120);
  if (type === 'custom' ? !prompt : !topic) {
    throw new Error(type === 'custom' ? 'プロンプトを入力してください' : 'トピックを入力してください');
  }
  if (opts.dedupeTopic && type === 'article_draft' && hasUnfinishedHustlerJobForTopic(topic)) {
    const existing = loadHustlerJobs().find((job) => (
      job.type === 'article_draft'
      && HUSTLER_UNFINISHED_TOPIC_STATUSES.has(job.status)
      && normalizeTopicKey(job.topic) === normalizeTopicKey(topic)
    ));
    return { queued: false, job: existing || null };
  }
  const createdAt = new Date().toISOString();
  const job = normalizeHustlerJob({
    id: makeId('job'),
    type,
    topic,
    prompt,
    publishTarget,
    affiliateLinkLabels,
    status: 'pending',
    createdAt,
    stateHistory: appendStateHistory([], 'pending', opts.note || '', createdAt),
    source: opts.source || '',
  });
  const jobs = loadHustlerJobs();
  jobs.push(job);
  saveHustlerJobs(jobs);
  return { queued: true, job };
}

function extractPublishBodyFromDraft(body) {
  const clean = stripHustlerMetaComment(body);
  const lines = clean.split('\n');
  const idx = lines.findIndex((line) => /^#\s*本文\s*$/.test(line.trim()));
  if (idx >= 0) {
    const extracted = lines.slice(idx + 1).join('\n').trim();
    if (extracted) return extracted;
  }
  return clean.trim();
}

function stripJsonCodeFence(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return s.trim();
}

function parseHustlerEvaluation(text) {
  const parsed = JSON.parse(stripJsonCodeFence(text));
  const review = normalizeReviewPayload(parsed);
  if (!review || review.score == null) throw new Error('評価JSONの形式が不正です');
  return review;
}

async function runHustlerTextTask({ cfg, prompt, system, maxTokens = 2200, timeoutSec = 60 }) {
  if (cfg.mode === 'cli') {
    return runClaudeCli({ cli: cfg.cli, model: cfg.model, system, prompt, timeoutSec });
  }
  return runClaudeApiText({ apiKey: cfg.apiKey, model: cfg.model, system, prompt, maxTokens });
}

async function generateHustlerContent(job, cfg, task, options = {}) {
  if (task.useResearch && cfg.mode === 'api') {
    return runResearchApi({ apiKey: cfg.apiKey, model: cfg.model, prompt: task.prompt });
  }
  if (task.useResearch && cfg.mode === 'cli') {
    return runResearchCli({ cli: cfg.cli, model: cfg.model, prompt: task.prompt });
  }
  return runHustlerTextTask({
    cfg,
    system: hustlerSystemPrompt(),
    prompt: task.prompt,
    maxTokens: 2600,
    timeoutSec: options.timeoutSec,
  });
}

async function evaluateArticleDraft(job, content, cfg, qualityThreshold, options = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await runHustlerTextTask({
      cfg,
      system: hustlerReviewSystemPrompt(),
      prompt: buildHustlerReviewPrompt(job, content, qualityThreshold),
      maxTokens: 900,
      timeoutSec: options.timeoutSec,
    });
    try {
      return parseHustlerEvaluation(raw);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('評価JSONの解析に失敗しました');
}

function makeZennSlug() {
  const seed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`.replace(/[^a-z0-9_-]/g, '');
  const base = `article-${seed}`.slice(0, 50);
  return base.length >= 12 ? base : `${base}${Math.random().toString(36).slice(2, 14 - base.length)}`;
}

function zennYamlString(value) {
  return JSON.stringify(String(value || ''));
}

function buildZennArticleContent(output, publishConfig, slug) {
  const title = deriveArticleTitle(output.rawBody, output.topic || '無題の記事');
  const emoji = output.emoji || deriveArticleEmoji(output.rawBody);
  const topics = uniqStrings([...(output.articleTopics || []), ...(publishConfig.topics || [])], 5, 40)
    .map((s) => s.replace(/\s+/g, '-'))
    .slice(0, 5);
  const body = extractPublishBodyFromDraft(output.rawBody || output.body);
  const frontMatter = [
    '---',
    `title: ${zennYamlString(title)}`,
    `emoji: ${zennYamlString(emoji)}`,
    `type: ${zennYamlString(publishConfig.articleType)}`,
    `topics: ${JSON.stringify(topics)}`,
    `published: ${publishConfig.publishedFlag ? 'true' : 'false'}`,
    ...(publishConfig.price > 0 ? [`price: ${publishConfig.price}`] : []),
    '---',
    '',
    body,
    '',
  ];
  return { slug, title, emoji, topics, body, content: frontMatter.join('\n') };
}

function buildGenericArticleContent(output, publishConfig, slug) {
  const title = deriveArticleTitle(output.rawBody, output.topic || '無題の記事');
  const topics = uniqStrings(output.articleTopics || [], 5, 40)
    .map((s) => s.replace(/\s+/g, '-'))
    .slice(0, 5);
  const date = new Date(output.publishedAt || output.updatedAt || output.createdAt || Date.now()).toISOString();
  const body = extractPublishBodyFromDraft(output.rawBody || output.body);
  const frontMatter = publishConfig.genericFrontmatter === 'jekyll'
    ? [
      '---',
      'layout: post',
      `title: ${JSON.stringify(title)}`,
      `date: ${JSON.stringify(date)}`,
      `tags: ${JSON.stringify(topics)}`,
      '---',
      '',
      body,
      '',
    ]
    : [
      '---',
      `title: ${JSON.stringify(title)}`,
      `date: ${JSON.stringify(date)}`,
      'draft: false',
      `tags: ${JSON.stringify(topics)}`,
      '---',
      '',
      body,
      '',
    ];
  return { slug, title, topics, body, content: frontMatter.join('\n') };
}

function runSpawn(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env: process.env, cwd: options.cwd || process.cwd() });
    } catch (e) {
      reject(new Error(`${command} 起動失敗: ${e.message}`));
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new Error(`${command} 起動失敗: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) { resolve({ out, err }); return; }
      reject(new Error(`${command} ${args.join(' ')} failed: ${(err || out || `exit ${code}`).trim().slice(0, 300)}`));
    });
  });
}

async function gitCommitMaybe(repoPath, message) {
  try {
    await runSpawn('git', ['-C', repoPath, 'commit', '-m', message]);
  } catch (e) {
    if (/nothing to commit|working tree clean/i.test(String(e.message))) return;
    throw e;
  }
}

function resolvePublishTargetForRecord(record, config) {
  const explicit = normalizePublishTarget(record && record.publishTarget, null);
  if (explicit) return explicit;
  if (record && record.type) return defaultPublishTargetForType(record.type);
  const publishMode = sanitizeHustlerPublishConfig(config && config.publish).mode;
  return publishMode === 'generic-git' ? 'generic' : 'zenn';
}

async function publishHustlerOutput(outputId, options = {}) {
  const config = sanitizeHustlerConfig(options.config || loadHustlerConfig());
  const publishConfig = config.publish || DEFAULT_HUSTLER_CONFIG.publish;

  const existing = readHustlerOutputRecord(outputId);
  if (!existing) throw new Error('成果物が見つかりません');
  if (existing.state !== 'approved') {
    throw new Error('approved 状態の成果物のみ公開できます');
  }
  const publishTarget = resolvePublishTargetForRecord(existing, config);
  if (publishTarget === 'none') throw new Error('この成果物は publishTarget=none のため公開できません');
  if (publishTarget === 'zenn' && !publishConfig.repoPath) throw new Error('Zenn リポジトリパスが未設定です');
  if (publishTarget === 'generic' && !publishConfig.genericRepoPath) throw new Error('generic リポジトリパスが未設定です');

  const attemptAt = new Date().toISOString();
  const slug = existing.slug || makeZennSlug();
  const updated = saveHustlerOutputRecord(transitionHustlerOutput(existing, 'approved', {
    slug,
    publishTarget,
    publishAttemptedAt: attemptAt,
    publishError: null,
    updatedAt: attemptAt,
  }, options.manual ? '手動公開を開始' : '自動公開を開始'));
  if (updated.jobId) {
    updateHustlerJobById(updated.jobId, (job) => transitionHustlerJob(job, 'approved', {
      slug,
      publishTarget,
      publishError: null,
      score: updated.score,
      review: updated.review,
      outputId: updated.id,
    }, options.manual ? '手動公開を開始' : '自動公開を開始'));
  }

  const repoPath = publishTarget === 'generic' ? publishConfig.genericRepoPath : publishConfig.repoPath;
  const relativeFilePath = publishTarget === 'generic'
    ? path.join(publishConfig.genericDir, `${slug}.md`)
    : path.join('articles', `${slug}.md`);
  ensureDir(path.join(repoPath, path.dirname(relativeFilePath)));
  const article = publishTarget === 'generic'
    ? buildGenericArticleContent(updated, publishConfig, slug)
    : buildZennArticleContent(updated, publishConfig, slug);
  fs.writeFileSync(path.join(repoPath, relativeFilePath), article.content);

  try {
    await runSpawn('git', ['-C', repoPath, 'add', relativeFilePath]);
    await gitCommitMaybe(repoPath, `Publish ${slug}`);
    await runSpawn('git', ['-C', repoPath, 'push']);
    const publishedAt = new Date().toISOString();
    const out = saveHustlerOutputRecord(transitionHustlerOutput(updated, 'published', {
      slug,
      publishTarget,
      publishedAt,
      publishAttemptedAt: attemptAt,
      publishError: null,
      articleTitle: article.title,
      articleTopics: article.topics,
      emoji: article.emoji || updated.emoji,
      updatedAt: publishedAt,
    }, options.manual ? '手動公開に成功' : '自動公開に成功'));
    if (out.jobId) {
      updateHustlerJobById(out.jobId, (job) => transitionHustlerJob(job, 'published', {
        outputId: out.id,
        finishedAt: publishedAt,
        slug,
        publishTarget,
        publishedAt,
        publishError: null,
        score: out.score,
        review: out.review,
      }, options.manual ? '手動公開に成功' : '自動公開に成功'));
    }
    return out;
  } catch (e) {
    const errorText = String(e.message || e).slice(0, 500);
    const out = saveHustlerOutputRecord(transitionHustlerOutput(updated, 'approved', {
      slug,
      publishTarget,
      publishAttemptedAt: attemptAt,
      publishError: errorText,
      updatedAt: new Date().toISOString(),
    }, `公開失敗: ${errorText}`));
    if (out.jobId) {
      updateHustlerJobById(out.jobId, (job) => transitionHustlerJob(job, 'approved', {
        outputId: out.id,
        slug,
        publishTarget,
        publishError: errorText,
        score: out.score,
        review: out.review,
      }, `公開失敗: ${errorText}`));
    }
    throw new Error(errorText);
  }
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
    !creatorRunning &&
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
    qualityThreshold: config.qualityThreshold,
    maxRevisions: config.maxRevisions,
    autoFromExplorer: config.autoFromExplorer,
    cliTimeoutSec: config.cliTimeoutSec,
    publish: config.publish,
    affiliate: config.affiliate,
    canRun,
    pendingJobs,
    lastRun,
    running: hustlerRunning,
    mode: provider.mode,
  };
}

function retryHustlerOutput(outputId) {
  const output = readHustlerOutputRecord(outputId);
  if (!output) throw new Error('成果物が見つかりません');
  if (!output.jobId) throw new Error('紐づくジョブがありません');
  const jobs = loadHustlerJobs();
  const idx = jobs.findIndex((job) => job.id === output.jobId);
  if (idx < 0) throw new Error('紐づくジョブが見つかりません');
  if (HUSTLER_RESTARTABLE_STATUSES.has(jobs[idx].status)) {
    throw new Error('このジョブはすでに実行中です');
  }
  const resume = getHustlerResumeDraftRecord({ ...jobs[idx], status: 'error', resumeFromDraft: true });
  jobs[idx] = transitionHustlerJob(jobs[idx], 'pending', {
    startedAt: null,
    finishedAt: null,
    error: null,
    publishError: null,
    resumeFromDraft: !!resume,
    retryCount: jobs[idx].retryCount + 1,
  }, `手動で再実行待ちへ戻しました${resume ? ' (保存済みドラフトから再開)' : ''}`);
  saveHustlerJobs(jobs);
  saveHustlerOutputRecord(transitionHustlerOutput(output, 'pending', {
    publishError: null,
  }, '手動で再実行待ちへ戻しました'));
  return {
    job: jobs[idx],
    output: readHustlerOutputRecord(outputId),
  };
}

async function executeHustlerJob(jobId) {
  if (hustlerRunning) throw new Error('別の内職ジョブを実行中です。');
  if (explorerRunning) throw new Error('探検家が調査中のため、少し待ってから実行してください。');
  if (creatorRunning) throw new Error('動画職人が実行中のため、少し待ってから実行してください。');
  const cfg = loadHustlerProviderConfig();
  if (cfg.mode === 'off') {
    throw new Error('商人の実行には Claude CLI か Anthropic API キーが必要です。');
  }

  const jobs = loadHustlerJobs();
  const idx = jobs.findIndex((j) => j.id === jobId);
  if (idx < 0) throw new Error('ジョブが見つかりません');
  if (HUSTLER_RESTARTABLE_STATUSES.has(jobs[idx].status)) throw new Error('このジョブはすでに実行中です');

  const config = loadHustlerConfig();
  if (jobs[idx].type === 'affiliate_article') {
    if (!config.affiliate.enabled) throw new Error('affiliate 設定が無効です');
    if (!config.affiliate.links.length) throw new Error('affiliate リンクが未設定です');
    resolveAffiliateLinksForJob(jobs[idx], config, { strict: !!(jobs[idx].affiliateLinkLabels && jobs[idx].affiliateLinkLabels.length) });
  }
  const resumeDraft = getHustlerResumeDraftRecord(jobs[idx]);
  const startedAt = new Date().toISOString();
  jobs[idx] = transitionHustlerJob(jobs[idx], 'running', {
    startedAt,
    finishedAt: null,
    error: null,
    publishError: null,
    resumeFromDraft: false,
  }, resumeDraft ? '保存済みドラフトから再開' : '生成開始');
  saveHustlerJobs(jobs);

  hustlerRunning = true;
  try {
    let job = jobs[idx];
    let draftForModel = '';
    let output;
    let startRevisionIndex = 0;
    if (resumeDraft) {
      draftForModel = resumeDraft.rawBody;
      startRevisionIndex = resumeDraft.revisionCount;
      output = saveHustlerOutputRecord(transitionHustlerOutput(resumeDraft.output, 'evaluating', {
        revisionCount: startRevisionIndex,
        publishError: null,
      }, '保存済みドラフトから評価再開'));
      job = updateHustlerJobById(job.id, (current) => transitionHustlerJob(current, 'evaluating', {
        outputId: output.id,
        revisionCount: startRevisionIndex,
        error: null,
        finishedAt: null,
      }, '保存済みドラフトから評価再開')) || job;
    } else {
      const task = buildHustlerJobPrompt(job, config);
      draftForModel = String(await generateHustlerContent(job, cfg, task, { timeoutSec: config.cliTimeoutSec }) || '(成果物が空でした)').trim();
      output = createHustlerOutput(job, finalizeHustlerContentForStorage(job, draftForModel, config), {
        state: requiresHustlerReview(job.type) ? 'evaluating' : 'approved',
        note: requiresHustlerReview(job.type) ? 'ドラフト生成完了' : '成果物生成完了',
      });
      job = updateHustlerJobById(job.id, (current) => transitionHustlerJob(current, requiresHustlerReview(job.type) ? 'evaluating' : 'approved', {
        outputId: output.id,
        score: null,
        review: null,
        revisionCount: 0,
        error: null,
        finishedAt: requiresHustlerReview(job.type) ? null : output.createdAt,
      }, requiresHustlerReview(job.type) ? 'ドラフト生成完了' : '成果物生成完了')) || job;
    }

    if (!requiresHustlerReview(job.type)) return job;

    for (let revisionIndex = startRevisionIndex; revisionIndex <= config.maxRevisions; revisionIndex++) {
      output = saveHustlerOutputRecord(transitionHustlerOutput(output, 'evaluating', {
        revisionCount: revisionIndex,
      }, revisionIndex > 0 ? `リライト ${revisionIndex} 回目の評価` : '初回評価'));
      job = updateHustlerJobById(job.id, (current) => transitionHustlerJob(current, 'evaluating', {
        outputId: output.id,
        revisionCount: revisionIndex,
        error: null,
      }, revisionIndex > 0 ? `リライト ${revisionIndex} 回目の評価` : '初回評価')) || job;

      const review = await evaluateArticleDraft(job, stripHustlerMetaComment(draftForModel), cfg, config.qualityThreshold, {
        timeoutSec: config.cliTimeoutSec,
      });
      output = saveHustlerOutputRecord(transitionHustlerOutput(output, 'evaluating', {
        review,
        score: review.score,
        revisionCount: revisionIndex,
      }, `評価完了 ${review.score}点`));
      job = updateHustlerJobById(job.id, (current) => transitionHustlerJob(current, 'evaluating', {
        outputId: output.id,
        review,
        score: review.score,
        revisionCount: revisionIndex,
      }, `評価完了 ${review.score}点`)) || job;

      if (review.score >= config.qualityThreshold) {
        const approvedAt = new Date().toISOString();
        output = saveHustlerOutputRecord(transitionHustlerOutput(output, 'approved', {
          review,
          score: review.score,
          revisionCount: revisionIndex,
          updatedAt: approvedAt,
        }, `審査合格 ${review.score}点`));
        job = updateHustlerJobById(job.id, (current) => transitionHustlerJob(current, 'approved', {
          outputId: output.id,
          review,
          score: review.score,
          revisionCount: revisionIndex,
          finishedAt: approvedAt,
          publishError: null,
        }, `審査合格 ${review.score}点`)) || job;
        const autoPublishTarget = resolvePublishTargetForRecord(output, config);
        const autoPublishReady = config.publish.enabled && (
          (autoPublishTarget === 'zenn' && config.publish.repoPath)
          || (autoPublishTarget === 'generic' && config.publish.genericRepoPath)
        );
        if (autoPublishReady) {
          try {
            await publishHustlerOutput(output.id, { config, manual: false });
          } catch (e) {
            console.error('[hustler] 自動公開失敗:', e.message);
          }
        }
        return loadHustlerJobs().find((j) => j.id === job.id) || job;
      }

      if (revisionIndex >= config.maxRevisions) {
        const rejectedAt = new Date().toISOString();
        output = saveHustlerOutputRecord(transitionHustlerOutput(output, 'rejected', {
          review,
          score: review.score,
          revisionCount: revisionIndex,
          updatedAt: rejectedAt,
        }, `見送り ${review.score}点`));
        job = updateHustlerJobById(job.id, (current) => transitionHustlerJob(current, 'rejected', {
          outputId: output.id,
          review,
          score: review.score,
          revisionCount: revisionIndex,
          finishedAt: rejectedAt,
        }, `見送り ${review.score}点`)) || job;
        return job;
      }

      const nextRevision = revisionIndex + 1;
      output = saveHustlerOutputRecord(transitionHustlerOutput(output, 'revising', {
        review,
        score: review.score,
        revisionCount: nextRevision,
      }, `リライト ${nextRevision} 回目`));
      job = updateHustlerJobById(job.id, (current) => transitionHustlerJob(current, 'revising', {
        outputId: output.id,
        review,
        score: review.score,
        revisionCount: nextRevision,
      }, `リライト ${nextRevision} 回目`)) || job;

      draftForModel = String(await runHustlerTextTask({
        cfg,
        system: hustlerSystemPrompt(),
        prompt: buildHustlerRevisionPrompt(job, stripHustlerMetaComment(draftForModel), review, nextRevision, config),
        maxTokens: 2600,
        timeoutSec: config.cliTimeoutSec,
      }) || '(リライト結果が空でした)').trim();
      output = saveHustlerOutputRecord(transitionHustlerOutput(output, 'revising', {
        review,
        score: review.score,
        revisionCount: nextRevision,
        rawBody: finalizeHustlerContentForStorage(job, draftForModel, config),
      }, `リライト ${nextRevision} 回目完了`));
      job = updateHustlerJobById(job.id, (current) => transitionHustlerJob(current, 'revising', {
        outputId: output.id,
        review,
        score: review.score,
        revisionCount: nextRevision,
      }, `リライト ${nextRevision} 回目完了`)) || job;
    }
    return job;
  } catch (e) {
    const current = loadHustlerJobs().find((j) => j.id === jobId);
    if (current && current.outputId) {
      const output = readHustlerOutputRecord(current.outputId);
      if (output) {
        saveHustlerOutputRecord(transitionHustlerOutput(output, 'error', {
          publishError: String(e.message || e).slice(0, 500),
        }, `エラー: ${String(e.message || e).slice(0, 200)}`));
      }
    }
    updateHustlerJobById(jobId, (job) => transitionHustlerJob(job, 'error', {
      finishedAt: new Date().toISOString(),
      error: String(e.message || e).slice(0, 500),
      resumeFromDraft: !!(current && current.outputId && requiresHustlerReview(current.type)),
    }, `エラー: ${String(e.message || e).slice(0, 200)}`));
    throw e;
  } finally {
    hustlerRunning = false;
  }
}

async function maybeRunHustlerScheduled() {
  queueRetryableHustlerErrors();
  const status = getHustlerStatus();
  if (!status.canRun) return null;
  const jobs = loadHustlerJobs().filter((j) => j.status === 'pending');
  if (!jobs.length) return null;
  jobs.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  console.log(`[hustler] 定期実行を開始: ${jobs[0].id} (${jobs[0].type})`);
  return executeHustlerJob(jobs[0].id);
}

function creatorWorkDir(jobId) {
  return path.join(CREATOR_WORK_DIR, jobId);
}

function creatorSceneFilePath(jobId, sceneIndex) {
  return path.join(creatorWorkDir(jobId), `scene-${String(sceneIndex + 1).padStart(2, '0')}.mp4`);
}

function creatorConcatListPath(jobId) {
  return path.join(creatorWorkDir(jobId), 'concat.txt');
}

async function creatorComfyJson(baseUrl, pathname, options = {}) {
  const url = baseUrl.replace(/\/+$/, '') + pathname;
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`ComfyUI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function uploadCreatorReferenceImage(baseUrl) {
  if (!fs.existsSync(CREATOR_REF_IMAGE_PATH)) return null;
  const file = new File([fs.readFileSync(CREATOR_REF_IMAGE_PATH)], path.basename(CREATOR_REF_IMAGE_PATH), { type: 'image/png' });
  const form = new FormData();
  form.append('image', file, file.name);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const res = await fetch(baseUrl.replace(/\/+$/, '') + '/upload/image', { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(`参照画像アップロード失敗: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

function creatorScenePrompt(scene, useReference) {
  const bits = [];
  if (useReference) bits.push('Use <Picture 1> as the exact identity reference for the recurring teal-haired AI news anchor.');
  bits.push(scene.visualPrompt);
  if (scene.dialogue) bits.push(`She speaks natural Japanese: 「${scene.dialogue}」.`);
  if (scene.caption) bits.push(`Burn in concise Japanese caption text on screen: 「${scene.caption}」.`);
  bits.push('Vertical smartphone short video, single continuous shot, no cuts, clean composition, professional audiovisual news segment.');
  return bits.join(' ').replace(/\s+/g, ' ').trim();
}

function buildCreatorSceneWorkflow({ promptText, width, height, frameCount, filePrefix, refImageName = null }) {
  const base = {
    '6': { class_type: 'UNETLoader', inputs: { unet_name: refImageName ? 'minimax_h3_ref2va_pruned_int8_convrot.safetensors' : 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', weight_dtype: 'default' } },
    '13': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type: 'minimax', device: 'cpu' } },
    '11': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
    '24': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
    '15': { class_type: 'RandomNoise', inputs: { noise_seed: Math.floor(Math.random() * 0x7fffffff) } },
    '17': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '9': { class_type: 'BasicScheduler', inputs: { model: ['6', 0], scheduler: 'simple', steps: 20, denoise: 1.0 } },
    '16': { class_type: 'BasicGuider', inputs: { model: ['6', 0], conditioning: [refImageName ? '105' : '104', 0] } },
    '14': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['15', 0], guider: ['16', 0], sampler: ['17', 0], sigmas: ['9', 0], latent_image: [refImageName ? '105' : '104', 1] } },
    '10': { class_type: 'VAEDecode', inputs: { samples: ['14', 0], vae: ['11', 0] } },
    '23': { class_type: 'VAEDecodeAudio', inputs: { samples: ['14', 0], vae: ['24', 0] } },
    '91': { class_type: 'CreateVideo', inputs: { images: ['10', 0], fps: 24, audio: ['23', 0] } },
    '92': { class_type: 'SaveVideo', inputs: { video: ['91', 0], filename_prefix: filePrefix, format: 'mp4', codec: 'h264' } },
  };
  if (refImageName) {
    base['101'] = { class_type: 'LoadImage', inputs: { image: refImageName, upload: 'image' } };
    base['105'] = {
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: {
        clip: ['13', 0],
        vae: ['11', 0],
        audio_vae: ['24', 0],
        prompt: promptText,
        width,
        height,
        length: frameCount,
        ref_image_size: 'match',
        ref_image_1: ['101', 0],
      },
    };
  } else {
    base['104'] = {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: ['13', 0],
        vae: ['11', 0],
        prompt: promptText,
        width,
        height,
        length: frameCount,
      },
    };
  }
  return base;
}

function findCreatorOutputAsset(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCreatorOutputAsset(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    if (typeof value.filename === 'string' && /\.mp4$/i.test(value.filename)) return value;
    for (const child of Object.values(value)) {
      const found = findCreatorOutputAsset(child);
      if (found) return found;
    }
  }
  return null;
}

async function waitForCreatorPrompt(baseUrl, promptId, timeoutMs = 30 * 60 * 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    const history = await creatorComfyJson(baseUrl, `/history/${encodeURIComponent(promptId)}`);
    if (!(promptId in history)) continue;
    const item = history[promptId] || {};
    const status = item.status || {};
    if (status.completed) return item;
    if (status.status_str === 'error') {
      const msg = Array.isArray(status.messages)
        ? status.messages.map((entry) => JSON.stringify(entry)).join('\n').slice(0, 2000)
        : 'execution error';
      throw new Error(`ComfyUI 実行エラー: ${msg}`);
    }
  }
  throw new Error('ComfyUI シーン生成がタイムアウトしました(30分)');
}

async function downloadCreatorAsset(baseUrl, asset, destPath) {
  const params = new URLSearchParams({
    filename: asset.filename,
    subfolder: asset.subfolder || '',
    type: asset.type || 'output',
  });
  const res = await fetch(baseUrl.replace(/\/+$/, '') + '/view?' + params.toString());
  if (!res.ok) throw new Error(`ComfyUI 出力取得失敗: ${(await res.text()).slice(0, 300)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

async function runCreatorScene({ jobId, sceneIndex, scene, config, resolution }) {
  ensureDir(creatorWorkDir(jobId));
  const refUpload = fs.existsSync(CREATOR_REF_IMAGE_PATH) ? await uploadCreatorReferenceImage(config.comfyUrl) : null;
  const frameCount = secondsToCreatorFrameCount(config.sceneSeconds);
  const filePrefix = `video/creator-${jobId}-${sceneIndex + 1}`;
  const workflow = buildCreatorSceneWorkflow({
    promptText: creatorScenePrompt(scene, !!refUpload),
    width: resolution.width,
    height: resolution.height,
    frameCount,
    filePrefix,
    refImageName: refUpload && refUpload.name ? refUpload.name : null,
  });
  const queued = await creatorComfyJson(config.comfyUrl, '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  const result = await waitForCreatorPrompt(config.comfyUrl, queued.prompt_id);
  const asset = findCreatorOutputAsset(result.outputs || {});
  if (!asset) throw new Error('ComfyUI 出力に mp4 が見つかりません');
  const scenePath = creatorSceneFilePath(jobId, sceneIndex);
  await downloadCreatorAsset(config.comfyUrl, asset, scenePath);
  return { scenePath, frameCount };
}

async function concatCreatorScenes(jobId, sceneCount, destPath) {
  const lines = [];
  for (let i = 0; i < sceneCount; i++) {
    const filePath = creatorSceneFilePath(jobId, i);
    if (!fs.existsSync(filePath)) throw new Error(`連結対象が見つかりません: ${path.basename(filePath)}`);
    lines.push(`file '${filePath.replace(/'/g, "'\\''")}'`);
  }
  fs.writeFileSync(creatorConcatListPath(jobId), lines.join('\n') + '\n');
  await runSpawn('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', creatorConcatListPath(jobId), '-c', 'copy', destPath], { cwd: creatorWorkDir(jobId) });
}

async function reviewCreatorScript(script, cfg, qualityThreshold, timeoutSec) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return parseCreatorReview(await runHustlerTextTask({
        cfg,
        system: 'あなたはショート動画企画の審査担当です。返答は JSON のみです。',
        prompt: creatorReviewPrompt(script, qualityThreshold),
        maxTokens: 900,
        timeoutSec,
      }));
    } catch (error) {
      lastErr = error;
    }
  }
  throw lastErr || new Error('動画審査JSONの解析に失敗しました');
}

function getCreatorRuntimeGuard(nowMs = Date.now()) {
  const provider = loadCreatorProviderConfig();
  const hustlerConfig = loadHustlerConfig();
  const window5h = getWindow5hUsageStats();
  const lastActivityMs = getLatestLocalActivityMs();
  const idle = !lastActivityMs || (nowMs - lastActivityMs) >= hustlerConfig.idleMinutes * 60 * 1000;
  const withinBudget = (window5h.totalTokens + HUSTLER_TOKEN_HEADROOM) < hustlerConfig.tokenBudget5h;
  const blockers = [];
  if (provider.mode === 'off') blockers.push('Claude CLI か Anthropic API が未設定です');
  if (!idle) blockers.push(`遊休判定(${hustlerConfig.idleMinutes}分)を満たしていません`);
  if (!withinBudget) blockers.push('直近5時間トークン予算を超過しています');
  if (explorerRunning) blockers.push('探検家が実行中です');
  if (hustlerRunning) blockers.push('商人が実行中です');
  if (traderRunning) blockers.push('トレーダーが実行中です');
  if (creatorRunning) blockers.push('動画職人が実行中です');
  return {
    mode: provider.mode,
    model: provider.model,
    cli: provider.cli,
    apiKey: provider.apiKey,
    idle,
    idleMinutes: hustlerConfig.idleMinutes,
    tokenBudget5h: hustlerConfig.tokenBudget5h,
    window5h,
    withinBudget,
    blockers,
    canRun: !blockers.length,
  };
}

function getCreatorStatus() {
  const config = loadCreatorConfig();
  const runtime = getCreatorRuntimeGuard();
  const jobs = loadCreatorJobs();
  const today = localDateStr();
  const runsToday = jobs.filter((job) => job.startedAt && String(job.startedAt).slice(0, 10) === today).length;
  const pendingJobs = jobs.filter((job) => job.status === 'pending').length;
  const lastRun = jobs
    .map((job) => job.finishedAt || job.startedAt || '')
    .filter(Boolean)
    .sort()
    .pop() || null;
  const google = getGoogleLinkStatus();
  const blockers = [];
  if (!config.enabled) blockers.push('自動化が無効です');
  if (!pendingJobs) blockers.push('待機ジョブがありません');
  if (runsToday >= config.dailyLimit) blockers.push('今日の上限に達しています');
  blockers.push(...runtime.blockers);
  return {
    ...config,
    running: creatorRunning,
    mode: runtime.mode,
    idle: runtime.idle,
    idleMinutes: runtime.idleMinutes,
    window5h: runtime.window5h,
    tokenBudget5h: runtime.tokenBudget5h,
    pendingJobs,
    runsToday,
    dailyLimit: config.dailyLimit,
    lastRun,
    googleConnected: google.connected,
    youtubeUploadScope: google.hasYoutubeUploadScope,
    canRun: !blockers.length,
    blockers,
  };
}

function creatorCanPublishVideo(video) {
  return !!(video && video.hasFile && (video.state === 'approved' || video.state === 'pending_review'));
}

async function publishCreatorVideo(videoId, options = {}) {
  const record = readCreatorVideoRecord(videoId);
  if (!record) throw new Error('動画が見つかりません');
  if (!creatorCanPublishVideo(record)) throw new Error('投稿できる状態の動画ではありません');
  const config = sanitizeCreatorConfig(options.config || loadCreatorConfig());
  const google = getGoogleLinkStatus();
  if (!google.connected || !google.hasYoutubeUploadScope) {
    throw new Error('再認証が必要です(⚙️→Googleと連携)');
  }

  const videoPath = creatorVideoFilePath(videoId);
  const stats = fs.statSync(videoPath);
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) throw new Error('再認証が必要です(⚙️→Googleと連携)');

  const attemptedAt = new Date().toISOString();
  const uploadMeta = {
    snippet: {
      title: record.title,
      description: appendDisclosureText(record.description, config.publish.disclosureText),
      tags: record.tags,
      categoryId: config.publish.categoryId,
    },
    status: {
      privacyStatus: config.publish.privacyStatus,
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
    },
  };

  updateCreatorVideoRecord(videoId, (video) => transitionCreatorVideo(video, 'publishing', {
    publish: { ...video.publish, attemptedAt, privacyStatus: config.publish.privacyStatus, error: null },
  }, options.manual ? '手動投稿を開始' : '自動投稿を開始'));
  if (record.jobId) {
    updateCreatorJobById(record.jobId, (job) => transitionCreatorJob(job, 'publishing', {
      publishError: null,
    }, options.manual ? '手動投稿を開始' : '自動投稿を開始'));
  }

  try {
    const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(stats.size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify(uploadMeta),
    });
    if (!initRes.ok) throw new Error(`YouTube upload init ${initRes.status}: ${(await initRes.text()).slice(0, 300)}`);
    const location = initRes.headers.get('location');
    if (!location) throw new Error('YouTube upload URL を取得できませんでした');

    const uploadRes = await fetch(location, {
      method: 'PUT',
      headers: {
        'Content-Length': String(stats.size),
        'Content-Type': 'video/mp4',
      },
      body: fs.readFileSync(videoPath),
    });
    if (!uploadRes.ok) throw new Error(`YouTube upload ${uploadRes.status}: ${(await uploadRes.text()).slice(0, 300)}`);
    const data = await uploadRes.json();
    const youtubeVideoId = data && data.id ? String(data.id) : '';
    if (!youtubeVideoId) throw new Error('YouTube videoId を取得できませんでした');
    const publishedAt = new Date().toISOString();
    const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeVideoId}`;
    const updatedVideo = updateCreatorVideoRecord(videoId, (video) => transitionCreatorVideo(video, 'published', {
      updatedAt: publishedAt,
      publish: {
        ...video.publish,
        attemptedAt,
        publishedAt,
        videoId: youtubeVideoId,
        url: youtubeUrl,
        privacyStatus: config.publish.privacyStatus,
        error: null,
      },
    }, options.manual ? '手動投稿に成功' : '自動投稿に成功'));
    if (record.jobId) {
      updateCreatorJobById(record.jobId, (job) => transitionCreatorJob(job, 'published', {
        finishedAt: publishedAt,
        publishedAt,
        youtubeVideoId,
        youtubeUrl,
        publishError: null,
      }, options.manual ? '手動投稿に成功' : '自動投稿に成功'));
    }
    return updatedVideo;
  } catch (error) {
    const message = String(error.message || error).slice(0, 500);
    updateCreatorVideoRecord(videoId, (video) => transitionCreatorVideo(video, record.state === 'pending_review' ? 'pending_review' : 'approved', {
      updatedAt: new Date().toISOString(),
      publish: { ...video.publish, attemptedAt, privacyStatus: config.publish.privacyStatus, error: message },
      error: message,
    }, `投稿失敗: ${message}`));
    if (record.jobId) {
      updateCreatorJobById(record.jobId, (job) => transitionCreatorJob(job, job.status === 'pending_review' ? 'pending_review' : 'approved', {
        publishError: message,
      }, `投稿失敗: ${message}`));
    }
    throw new Error(message);
  }
}

function resetStaleCreatorJobs() {
  const jobs = loadCreatorJobs();
  let changed = false;
  for (let i = 0; i < jobs.length; i++) {
    if (!CREATOR_RESTARTABLE_STATUSES.has(jobs[i].status)) continue;
    jobs[i] = transitionCreatorJob(jobs[i], 'error', {
      finishedAt: new Date().toISOString(),
      error: 'サーバー再起動により中断しました。再実行してください。',
    }, 'サーバー再起動により中断');
    if (jobs[i].videoId) {
      updateCreatorVideoRecord(jobs[i].videoId, (video) => transitionCreatorVideo(video, 'error', {
        error: 'サーバー再起動により中断しました。再実行してください。',
      }, 'サーバー再起動により中断'));
    }
    changed = true;
  }
  if (changed) saveCreatorJobs(jobs);
}

async function executeCreatorJob(jobId, options = {}) {
  if (creatorRunning) throw new Error('動画職人が実行中です');
  if (explorerRunning) throw new Error('探検家が実行中です');
  if (hustlerRunning) throw new Error('商人が実行中です');
  if (traderRunning) throw new Error('トレーダーが実行中です');

  const runtime = getCreatorRuntimeGuard();
  const blockers = options.skipRuntimeGuard
    ? runtime.blockers.filter((item) => !item.startsWith('遊休判定') && !item.startsWith('直近5時間トークン予算'))
    : runtime.blockers;
  if (blockers.length) throw new Error(blockers[0]);

  const jobs = loadCreatorJobs();
  const idx = jobs.findIndex((job) => job.id === jobId);
  if (idx < 0) throw new Error('ジョブが見つかりません');
  if (CREATOR_RESTARTABLE_STATUSES.has(jobs[idx].status)) throw new Error('このジョブはすでに実行中です');

  const config = loadCreatorConfig();
  const provider = loadCreatorProviderConfig();
  if (provider.mode === 'off') throw new Error('動画職人の実行には Claude CLI か Anthropic API キーが必要です。');
  const timeoutSec = loadHustlerConfig().cliTimeoutSec;
  const sceneCount = Math.max(1, Math.min(8, Math.round(Number(options.sceneCount) || config.sceneCount)));
  const sceneSeconds = Math.max(2, Math.min(15, Math.round(Number(options.sceneSeconds) || config.sceneSeconds)));
  const resolution = parseCreatorResolution(options.useDraft ? config.draftResolution : config.resolution);
  const startedAt = new Date().toISOString();
  const videoId = jobs[idx].videoId || makeId('cvid');
  jobs[idx] = transitionCreatorJob(jobs[idx], 'scripting', {
    startedAt,
    finishedAt: null,
    videoId,
    currentScene: 0,
    sceneCount,
    error: null,
    publishError: null,
  }, '台本生成を開始');
  saveCreatorJobs(jobs);
  creatorRunning = true;

  try {
    const job = jobs[idx];
    const scriptRaw = await runHustlerTextTask({
      cfg: provider,
      system: 'あなたは動画台本をJSONで返す短尺動画プランナーです。返答は JSON のみです。',
      prompt: creatorScriptPrompt(job, { ...config, sceneCount, sceneSeconds }),
      maxTokens: 2600,
      timeoutSec,
    });
    let script = parseCreatorScript(scriptRaw, sceneCount);
    let video = saveCreatorVideoRecord({
      id: videoId,
      jobId: job.id,
      createdAt: startedAt,
      updatedAt: new Date().toISOString(),
      state: 'rendering',
      topic: job.topic,
      title: script.title,
      description: script.description,
      tags: script.tags,
      score: null,
      review: null,
      script,
      sceneCount: script.scenes.length,
      sceneSeconds,
      resolution: resolution.value,
      currentScene: 0,
      stateHistory: appendCreatorStateHistory([], 'rendering', '台本生成完了・シーン生成開始', new Date().toISOString()),
      publish: {},
    });
    updateCreatorJobById(job.id, (current) => transitionCreatorJob(current, 'rendering', {
      videoId,
      currentScene: 0,
      sceneCount: script.scenes.length,
      script,
    }, '台本生成完了・シーン生成開始'));

    for (let sceneIndex = 0; sceneIndex < script.scenes.length; sceneIndex++) {
      updateCreatorJobById(job.id, (current) => transitionCreatorJob(current, 'rendering', {
        currentScene: sceneIndex + 1,
        sceneCount: script.scenes.length,
      }, `シーン ${sceneIndex + 1}/${script.scenes.length} を生成中`));
      video = updateCreatorVideoRecord(videoId, (current) => transitionCreatorVideo(current, 'rendering', {
        currentScene: sceneIndex + 1,
      }, `シーン ${sceneIndex + 1}/${script.scenes.length} を生成中`));
      await runCreatorScene({
        jobId: job.id,
        sceneIndex,
        scene: script.scenes[sceneIndex],
        config: { ...config, sceneSeconds },
        resolution,
      });
    }

    const finalVideoPath = creatorVideoFilePath(videoId);
    await concatCreatorScenes(job.id, script.scenes.length, finalVideoPath);
    video = updateCreatorVideoRecord(videoId, (current) => transitionCreatorVideo(current, 'reviewing', {
      hasFile: true,
      currentScene: script.scenes.length,
      updatedAt: new Date().toISOString(),
    }, '連結完了・審査開始'));
    updateCreatorJobById(job.id, (current) => transitionCreatorJob(current, 'reviewing', {
      currentScene: script.scenes.length,
    }, '連結完了・審査開始'));

    let review = await reviewCreatorScript(script, provider, config.qualityThreshold, timeoutSec);
    let reviewAttempt = 0;
    while (review.score < config.qualityThreshold && reviewAttempt < 1) {
      reviewAttempt++;
      const revisedRaw = await runHustlerTextTask({
        cfg: provider,
        system: 'あなたは動画メタデータ改善担当です。返答は JSON のみです。',
        prompt: creatorMetadataRevisionPrompt(script, review),
        maxTokens: 800,
        timeoutSec,
      });
      const revised = JSON.parse(stripJsonFence(revisedRaw));
      script = normalizeCreatorScript({
        ...script,
        title: revised && revised.title ? revised.title : script.title,
        description: revised && revised.description ? revised.description : script.description,
      }, creatorCharacterPrompt());
      video = updateCreatorVideoRecord(videoId, (current) => transitionCreatorVideo(current, 'reviewing', {
        title: script.title,
        description: script.description,
        script,
      }, 'タイトル・概要欄を再生成'));
      review = await reviewCreatorScript(script, provider, config.qualityThreshold, timeoutSec);
    }

    const passed = review.score >= config.qualityThreshold;
    const finalState = passed ? 'approved' : 'pending_review';
    const finishedAt = new Date().toISOString();
    video = updateCreatorVideoRecord(videoId, (current) => transitionCreatorVideo(current, finalState, {
      title: script.title,
      description: script.description,
      tags: script.tags,
      script,
      score: review.score,
      review,
      updatedAt: finishedAt,
      error: null,
    }, passed ? `審査合格 ${review.score}点` : `要確認 ${review.score}点`));
    const updatedJob = updateCreatorJobById(job.id, (current) => transitionCreatorJob(current, finalState, {
      finishedAt,
      script,
      score: review.score,
      review,
      error: null,
      publishError: null,
    }, passed ? `審査合格 ${review.score}点` : `要確認 ${review.score}点`));

    if (passed && config.publish.enabled) {
      try {
        await publishCreatorVideo(videoId, { config, manual: false });
      } catch (error) {
        console.error('[creator] 自動投稿失敗:', error.message);
      }
    }
    return updatedJob;
  } catch (error) {
    const message = String(error.message || error).slice(0, 500);
    const current = updateCreatorJobById(jobId, (job) => transitionCreatorJob(job, 'error', {
      finishedAt: new Date().toISOString(),
      error: message,
    }, `エラー: ${message}`));
    if (current && current.videoId) {
      updateCreatorVideoRecord(current.videoId, (video) => transitionCreatorVideo(video, 'error', {
        updatedAt: new Date().toISOString(),
        error: message,
      }, `エラー: ${message}`));
    }
    throw error;
  } finally {
    creatorRunning = false;
  }
}

async function maybeRunCreatorScheduled() {
  const status = getCreatorStatus();
  if (!status.canRun) return null;
  const jobs = loadCreatorJobs().filter((job) => job.status === 'pending');
  if (!jobs.length) return null;
  jobs.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  console.log(`[creator] 定期実行を開始: ${jobs[0].id} (${jobs[0].topic})`);
  return executeCreatorJob(jobs[0].id);
}

function getTraderRuntimeGuard(nowMs = Date.now()) {
  const provider = loadHustlerProviderConfig();
  const hustlerConfig = loadHustlerConfig();
  const window5h = getWindow5hUsageStats();
  const lastActivityMs = getLatestLocalActivityMs();
  const idle = !lastActivityMs || (nowMs - lastActivityMs) >= hustlerConfig.idleMinutes * 60 * 1000;
  const withinBudget = (window5h.totalTokens + HUSTLER_TOKEN_HEADROOM) < hustlerConfig.tokenBudget5h;
  const blockers = [];
  if (provider.mode === 'off') blockers.push('Claude CLI か Anthropic API が未設定です');
  if (!idle) blockers.push(`遊休判定(${hustlerConfig.idleMinutes}分)を満たしていません`);
  if (!withinBudget) blockers.push('直近5時間トークン予算を超過しています');
  if (explorerRunning) blockers.push('探検家が実行中です');
  if (hustlerRunning) blockers.push('商人が実行中です');
  if (traderRunning) blockers.push('トレーダーが実行中です');
  if (creatorRunning) blockers.push('動画職人が実行中です');
  return {
    mode: provider.mode,
    model: provider.model,
    cli: provider.cli,
    apiKey: provider.apiKey,
    idle,
    idleMinutes: hustlerConfig.idleMinutes,
    tokenBudget5h: hustlerConfig.tokenBudget5h,
    window5h,
    withinBudget,
    running: traderRunning,
    blockers,
    canAnalyze: !blockers.length,
  };
}

async function fetchTraderPricesFromCoinGecko(config, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const ids = config.assets.join(',');
  const vs = traderPriceField(config.vsCurrency);
  const url = 'https://api.coingecko.com/api/v3/simple/price?' + new URLSearchParams({
    ids,
    vs_currencies: vs,
    include_24hr_change: 'true',
  });
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CoinGecko ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const prices = {};
  const changeKey = traderChangeField(vs);
  for (const asset of config.assets) {
    const raw = json && json[asset];
    if (!raw || typeof raw !== 'object') continue;
    const price = Number(raw[vs]);
    if (!Number.isFinite(price) || price <= 0) continue;
    prices[asset] = { [vs]: price };
    const change = Number(raw[changeKey]);
    if (Number.isFinite(change)) prices[asset][changeKey] = change;
  }
  if (!Object.keys(prices).length) throw new Error('CoinGecko の価格レスポンスが空です');
  return prices;
}

async function fetchTraderPricesFromApi(config, options = {}) {
  return fetchTraderPricesFromCoinGecko(config, options);
}

async function fetchTraderPricesFromYahoo(config, options = {}) {
  const vs = traderPriceField(config.vsCurrency);
  const changeKey = traderChangeField(vs);
  const prices = {};
  for (const asset of config.assets) {
    const symbol = sanitizeTraderSymbol(config.symbolMap && config.symbolMap[asset]);
    if (!symbol) throw new Error(`Yahoo symbolMap が未設定です: ${asset}`);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${new URLSearchParams({
      range: '1d',
      interval: '1h',
    })}`;
    let json;
    if (options.fetchImpl) {
      const res = await options.fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });
      if (!res.ok) throw new Error(`Yahoo ${res.status}: ${(await res.text()).slice(0, 200)}`);
      json = await res.json();
    } else {
      const { out } = await runSpawn('curl', [
        '-sS',
        '-f',
        '-H', 'Accept: application/json',
        '-H', 'User-Agent: Mozilla/5.0',
        url,
      ]);
      json = JSON.parse(out);
    }
    const meta = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result[0] && json.chart.result[0].meta : null;
    const price = Number(meta && meta.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Yahoo の価格レスポンスが不正です: ${asset}`);
    prices[asset] = { [vs]: price };
    const prevClose = Number(meta && meta.chartPreviousClose);
    const change = pctChange(price, prevClose);
    if (Number.isFinite(change)) prices[asset][changeKey] = change;
  }
  if (!Object.keys(prices).length) throw new Error('Yahoo の価格レスポンスが空です');
  return prices;
}

function traderFetchProviderOrder(config, state, nowMs) {
  if (config.priceProvider === 'coingecko') return ['coingecko'];
  if (config.priceProvider === 'yahoo') return ['yahoo'];
  const memoActive = state.currentProvider && state.providerMemoUntil > nowMs;
  if (memoActive && state.currentProvider === 'yahoo') return ['yahoo', 'coingecko'];
  return ['coingecko', 'yahoo'];
}

async function fetchTraderPrices(config, options = {}) {
  const nowMs = options.now instanceof Date ? options.now.getTime()
    : Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const paths = traderPaths(options.paths);
  const state = options.fetchState || loadTraderFetchState(paths);
  const order = traderFetchProviderOrder(config, state, nowMs);
  const attempts = [];
  for (const provider of order) {
    try {
      const prices = provider === 'yahoo'
        ? await fetchTraderPricesFromYahoo(config, options)
        : await fetchTraderPricesFromCoinGecko(config, options);
      const nextState = saveTraderFetchState({
        ...state,
        currentProvider: provider,
        providerMemoUntil: config.priceProvider === 'auto' ? nowMs + TRADER_PROVIDER_MEMO_MS : 0,
        lastFetchAt: new Date(nowMs).toISOString(),
        lastFetchOk: true,
        lastFetchError: '',
        lastFetchProvider: provider,
      }, paths);
      return { provider, prices, fetchState: nextState };
    } catch (e) {
      attempts.push(`${provider}: ${String(e.message || e)}`);
    }
  }
  const lastProvider = order[order.length - 1] || null;
  const nextState = saveTraderFetchState({
    ...state,
    currentProvider: state.currentProvider || lastProvider,
    lastFetchAt: new Date(nowMs).toISOString(),
    lastFetchOk: false,
    lastFetchError: attempts.join(' | ').slice(0, 500),
    lastFetchProvider: lastProvider,
  }, paths);
  const err = new Error(nextState.lastFetchError || '価格取得に失敗しました');
  err.fetchState = nextState;
  throw err;
}

async function maybeFetchTraderPrices(options = {}) {
  const paths = traderPaths(options.paths);
  const config = options.config || loadTraderConfig(paths);
  if (!config.enabled) return null;
  const nowMs = options.now instanceof Date ? options.now.getTime()
    : Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const history = options.history || loadTraderPriceHistory(paths, config);
  const latest = history[history.length - 1] || null;
  const latestMs = latest ? Date.parse(latest.ts) : 0;
  if (!options.force && latestMs && (nowMs - latestMs) < config.priceIntervalMin * 60 * 1000) return latest;
  try {
    const { prices } = await fetchTraderPrices(config, { ...options, paths, now: nowMs });
    return appendTraderPriceRecord(
      prices,
      paths,
      config,
      options.now instanceof Date ? options.now.toISOString() : (typeof options.now === 'string' ? options.now : new Date(nowMs).toISOString())
    );
  } catch (e) {
    if (options.silent) {
      console.error('[trader] 価格取得失敗:', e.message);
      return latest;
    }
    throw e;
  }
}

function roundTraderNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const unit = 10 ** digits;
  return Math.round(value * unit) / unit;
}

function traderLatestPricesMap(records, config) {
  const latest = records[records.length - 1] || null;
  const out = {};
  const field = traderPriceField(config.vsCurrency);
  const changeKey = traderChangeField(config.vsCurrency);
  for (const asset of config.assets) {
    const row = latest && latest.prices && latest.prices[asset];
    out[asset] = {
      price: row && Number.isFinite(Number(row[field])) ? Number(row[field]) : null,
      api24hChange: row && Number.isFinite(Number(row[changeKey])) ? Number(row[changeKey]) : null,
    };
  }
  return { ts: latest ? latest.ts : null, prices: out };
}

function computeTraderEquity(portfolio, latestPrices, config) {
  let marketValue = 0;
  const positions = {};
  for (const asset of config.assets) {
    const pos = portfolio.positions[asset];
    if (!pos || pos.qty <= 0) continue;
    // 価格マップは {price} 形式(status経路)と {jpy} 形式(生データ経路)の両方が来る
    const raw = latestPrices && latestPrices[asset];
    const price = Number(raw && (raw.price != null ? raw.price : raw.jpy));
    const value = Number.isFinite(price) ? pos.qty * price : 0;
    const cost = pos.qty * pos.avgCost;
    positions[asset] = {
      qty: pos.qty,
      avgCost: pos.avgCost,
      lastPrice: Number.isFinite(price) ? price : null,
      marketValue: value,
      unrealizedPnl: Number.isFinite(price) ? value - cost : null,
      unrealizedPnlPct: Number.isFinite(price) && cost > 0 ? ((value - cost) / cost) * 100 : null,
    };
    marketValue += value;
  }
  const cash = Number(portfolio.cash) || 0;
  return {
    cash,
    marketValue,
    equity: cash + marketValue,
    positions,
  };
}

function buildTraderAnalysisPrompt({ config, latestPrices, indicators, portfolio, now }) {
  const holdings = config.assets.map((asset) => {
    const pos = portfolio.positions[asset];
    return {
      asset,
      qty: roundTraderNumber(pos ? pos.qty : 0, 8),
      avgCost: roundTraderNumber(pos ? pos.avgCost : 0, 2),
      latestPrice: roundTraderNumber(latestPrices.prices[asset] && latestPrices.prices[asset].price, 2),
      api24hChange: roundTraderNumber(latestPrices.prices[asset] && latestPrices.prices[asset].api24hChange, 2),
      indicators: {
        sma24h: roundTraderNumber(indicators[asset] && indicators[asset].sma24h, 2),
        sma7d: roundTraderNumber(indicators[asset] && indicators[asset].sma7d, 2),
        rsi14: roundTraderNumber(indicators[asset] && indicators[asset].rsi14, 2),
        change24h: roundTraderNumber(indicators[asset] && indicators[asset].change24h, 2),
        change7d: roundTraderNumber(indicators[asset] && indicators[asset].change7d, 2),
      },
    };
  });
  return `現在時刻: ${localDateStr(now)} ${hm(now)}
対象: 暗号資産のペーパートレード(仮想資金)のみ
重要:
- 実際の注文や取引所 API は使わない前提です。
- sizePct は 0 以上 30 以下の数値にしてください。
- 売買判断は短期の勢いと過熱感のバランスで、無理な売買は避けてください。
- JSON のみ返し、コードフェンスや説明文は付けません。

設定:
${JSON.stringify({
    assets: config.assets,
    vsCurrency: config.vsCurrency,
    startBalance: config.startBalance,
    cash: roundTraderNumber(portfolio.cash, 2),
  }, null, 2)}

現在の保有と指標:
${JSON.stringify(holdings, null, 2)}

返す JSON スキーマ:
{
  "signals": [
    {
      "asset": "bitcoin",
      "action": "buy" | "sell" | "hold",
      "sizePct": 0-30,
      "confidence": 0-1,
      "reasoning": "短い根拠"
    }
  ],
  "marketNote": "全体メモ"
}`;
}

function parseTraderAnalysis(text, config) {
  const parsed = JSON.parse(stripJsonCodeFence(text));
  const signals = (Array.isArray(parsed.signals) ? parsed.signals : [])
    .map((x) => sanitizeTraderSignalEntry(x, config))
    .filter(Boolean);
  if (!signals.length) throw new Error('signals が空です');
  const seen = new Set();
  const deduped = [];
  for (const signal of signals) {
    if (seen.has(signal.asset)) continue;
    seen.add(signal.asset);
    deduped.push(signal);
  }
  return {
    signals: deduped,
    marketNote: typeof parsed.marketNote === 'string' ? parsed.marketNote.trim().slice(0, 2000) : '',
  };
}

async function requestTraderAnalysis(payload, options = {}) {
  const taskRunner = options.taskRunner || ((req) => runHustlerTextTask(req));
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await taskRunner(payload);
    try {
      return parseTraderAnalysis(raw, options.config);
    } catch (e) {
      lastErr = e;
      payload = {
        ...payload,
        prompt: `${payload.prompt}\n\n前回は JSON 解析に失敗しました。必ず JSON のみを返してください。`,
      };
    }
  }
  throw lastErr || new Error('トレーダー分析JSONの解析に失敗しました');
}

function executeTraderSignals({ portfolio, analysis, latestPrices, config, ts }) {
  const next = sanitizeTraderPortfolio(portfolio, config);
  const trades = [];
  for (const signal of analysis.signals) {
    const asset = signal.asset;
    const price = Number(latestPrices.prices[asset] && latestPrices.prices[asset].price);
    const side = signal.action;
    const sizePct = Math.max(0, Math.min(30, Number(signal.sizePct) || 0));
    let qty = 0;
    if (Number.isFinite(price) && price > 0) {
      if (side === 'buy') {
        const budget = next.cash * (sizePct / 100);
        qty = budget > 0 ? budget / price : 0;
        if (qty > 0) {
          const prev = next.positions[asset] || { qty: 0, avgCost: 0 };
          const totalQty = prev.qty + qty;
          const totalCost = (prev.qty * prev.avgCost) + (qty * price);
          next.positions[asset] = { qty: totalQty, avgCost: totalQty > 0 ? totalCost / totalQty : 0 };
          next.cash -= qty * price;
        }
      } else if (side === 'sell') {
        const prev = next.positions[asset] || { qty: 0, avgCost: 0 };
        qty = prev.qty * (sizePct / 100);
        if (qty > 0) {
          const remain = prev.qty - qty;
          next.cash += qty * price;
          if (remain > 1e-12) next.positions[asset] = { qty: remain, avgCost: prev.avgCost };
          else delete next.positions[asset];
        }
      }
    }
    const trade = sanitizeTraderTrade({
      ts,
      asset,
      side,
      qty,
      price: Number.isFinite(price) ? price : 0,
      reasoning: signal.reasoning,
      sizePct,
      confidence: signal.confidence,
    }, config);
    trades.push(trade);
    next.trades.push(trade);
  }
  next.trades = next.trades.slice(-500);
  return { portfolio: next, trades };
}

function getLastTraderAnalysisDate(portfolio) {
  if (portfolio.lastAnalysis && portfolio.lastAnalysis.ts) return localDateStr(new Date(portfolio.lastAnalysis.ts));
  const lastTrade = portfolio.trades[portfolio.trades.length - 1];
  if (lastTrade && lastTrade.ts) return localDateStr(new Date(lastTrade.ts));
  const lastEquity = portfolio.equityHistory[portfolio.equityHistory.length - 1];
  return lastEquity ? lastEquity.date : null;
}

function traderAnalyzeBlockerMessage(guard) {
  return guard.blockers[0] || '分析を実行できません';
}

function getTraderStatus(options = {}) {
  const paths = traderPaths(options.paths);
  const config = options.config || loadTraderConfig(paths);
  const records = options.priceHistory || loadTraderPriceHistory(paths, config);
  const latestPrices = options.latestPrices || traderLatestPricesMap(records, config);
  const indicators = options.indicators || computeTraderIndicators(records, config);
  const portfolio = options.portfolio || loadTraderPortfolio(paths, config);
  const fetchStatus = options.fetchStatus || loadTraderFetchState(paths);
  const runtime = options.runtime || getTraderRuntimeGuard();
  const totals = computeTraderEquity(portfolio, latestPrices, config);
  const pnl = totals.equity - config.startBalance;
  return {
    enabled: config.enabled,
    config,
    latestPrices,
    indicators,
    cash: totals.cash,
    marketValue: totals.marketValue,
    equity: totals.equity,
    startBalance: config.startBalance,
    pnl,
    pnlPct: config.startBalance > 0 ? (pnl / config.startBalance) * 100 : null,
    positions: totals.positions,
    latestSignals: portfolio.lastAnalysis ? portfolio.lastAnalysis.signals : [],
    marketNote: portfolio.lastAnalysis ? portfolio.lastAnalysis.marketNote : '',
    lastAnalysisAt: portfolio.lastAnalysis ? portfolio.lastAnalysis.ts : null,
    trades: portfolio.trades.slice(-20).reverse(),
    fetchStatus,
    runtime: {
      mode: runtime.mode,
      idle: runtime.idle,
      idleMinutes: runtime.idleMinutes,
      tokenBudget5h: runtime.tokenBudget5h,
      window5h: runtime.window5h,
      withinBudget: runtime.withinBudget,
      canAnalyze: runtime.canAnalyze,
      blockers: runtime.blockers,
      running: runtime.running,
    },
  };
}

async function analyzeTrader(options = {}) {
  const paths = traderPaths(options.paths);
  const now = options.now instanceof Date ? options.now : (options.now ? new Date(options.now) : new Date());
  const config = options.config || loadTraderConfig(paths);
  if (!config.enabled && !options.allowDisabled) throw new Error('トレーダーは無効です');
  if (!options.skipBusyCheck) {
    if (traderRunning) throw new Error('トレーダー分析を実行中です');
    if (explorerRunning) throw new Error('探検家が実行中です');
    if (hustlerRunning) throw new Error('商人が実行中です');
  }
  const runtime = options.runtime || getTraderRuntimeGuard(now.getTime());
  if (!options.skipRuntimeGuard && !runtime.canAnalyze) throw new Error(traderAnalyzeBlockerMessage(runtime));

  traderRunning = true;
  try {
    if (options.ensurePrice !== false) {
      await maybeFetchTraderPrices({
        paths,
        config,
        fetchImpl: options.fetchImpl,
        now,
        silent: false,
      });
    }
    const priceHistory = options.priceHistory || loadTraderPriceHistory(paths, config);
    const latestPrices = traderLatestPricesMap(priceHistory, config);
    if (!latestPrices.ts) throw new Error('価格履歴がまだありません');
    const indicators = computeTraderIndicators(priceHistory, config, now.getTime());
    const portfolio = options.portfolio || loadTraderPortfolio(paths, config);
    const provider = options.providerConfig || loadHustlerProviderConfig();
    if (provider.mode === 'off' && !options.taskRunner) throw new Error('トレーダー分析には Claude CLI か Anthropic API が必要です');

    const payload = {
      cfg: provider,
      system: 'あなたは暗号資産のペーパートレード専用アシスタントです。実際の注文を前提にせず、JSON のみ返してください。',
      prompt: buildTraderAnalysisPrompt({ config, latestPrices, indicators, portfolio, now }),
      maxTokens: 1100,
    };
    const analysis = options.analysis || await requestTraderAnalysis(payload, {
      taskRunner: options.taskRunner,
      config,
    });

    const executed = executeTraderSignals({
      portfolio,
      analysis,
      latestPrices,
      config,
      ts: now.toISOString(),
    });
    const totals = computeTraderEquity(executed.portfolio, latestPrices, config);
    executed.portfolio.equityHistory.push({
      date: localDateStr(now),
      equity: roundTraderNumber(totals.equity, 2),
    });
    executed.portfolio.equityHistory = executed.portfolio.equityHistory.slice(-365);
    executed.portfolio.lastAnalysis = {
      ts: now.toISOString(),
      marketNote: analysis.marketNote,
      provider: provider.mode,
      signals: analysis.signals,
    };
    const saved = saveTraderPortfolio(executed.portfolio, paths, config);
    return {
      ok: true,
      analysis,
      trades: executed.trades,
      portfolio: saved,
      status: getTraderStatus({ paths, config, priceHistory, portfolio: saved, latestPrices, indicators, runtime }),
    };
  } finally {
    traderRunning = false;
  }
}

async function maybeRunTraderScheduled(now = new Date()) {
  const config = loadTraderConfig();
  if (!config.enabled) return null;
  await maybeFetchTraderPrices({ config, now, silent: true });
  const portfolio = loadTraderPortfolio(null, config);
  const today = localDateStr(now);
  if (now.getHours() !== config.analysisHour) return null;
  if (getLastTraderAnalysisDate(portfolio) === today) return null;
  const runtime = getTraderRuntimeGuard(now.getTime());
  if (!runtime.canAnalyze) return null;
  console.log(`[trader] 定期分析を開始: ${today} ${String(now.getHours()).padStart(2, '0')}:00`);
  return analyzeTrader({ config, now, runtime });
}

function sanitizeAppraiserXApiConfig(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return {
    bearerToken: typeof src.bearerToken === 'string' ? src.bearerToken.trim().slice(0, 4000) : '',
    userId: typeof src.userId === 'string' ? src.userId.trim().replace(/[^\d]/g, '').slice(0, 32) : '',
    pollBookmarks: src.pollBookmarks !== false,
    pollLikes: !!src.pollLikes,
    intervalHours: Math.max(1, Math.min(24 * 14, Math.round(Number(src.intervalHours) || DEFAULT_APPRAISER_CONFIG.xApi.intervalHours))),
  };
}

function sanitizeAppraiserConfig(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return {
    handsOn: !!src.handsOn,
    testTimeoutSec: Math.max(60, Math.min(3600, Math.round(Number(src.testTimeoutSec) || DEFAULT_APPRAISER_CONFIG.testTimeoutSec))),
    interestProfile: typeof src.interestProfile === 'string' && src.interestProfile.trim()
      ? src.interestProfile.trim().slice(0, 2000)
      : DEFAULT_APPRAISER_CONFIG.interestProfile,
    xApi: sanitizeAppraiserXApiConfig({ ...DEFAULT_APPRAISER_CONFIG.xApi, ...(src.xApi || {}) }),
  };
}

function loadAppraiserConfig() {
  ensureAppraiserStorage();
  const stored = readJsonFileSafe(APPRAISER_CONFIG_PATH, DEFAULT_APPRAISER_CONFIG);
  return sanitizeAppraiserConfig({ ...DEFAULT_APPRAISER_CONFIG, ...stored });
}

function normalizeAppraiserState(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const xPolling = (src.xPolling && typeof src.xPolling === 'object') ? src.xPolling : {};
  const authError = xPolling.authError && typeof xPolling.authError === 'object'
    ? {
      at: typeof xPolling.authError.at === 'string' ? xPolling.authError.at : new Date().toISOString(),
      message: typeof xPolling.authError.message === 'string' ? xPolling.authError.message.slice(0, 400) : 'X API 認証エラー',
      status: Math.max(0, Math.min(999, Math.round(Number(xPolling.authError.status) || 401))),
    }
    : null;
  return {
    xPolling: {
      lastPollAt: typeof xPolling.lastPollAt === 'string' ? xPolling.lastPollAt : null,
      lastSuccessAt: typeof xPolling.lastSuccessAt === 'string' ? xPolling.lastSuccessAt : null,
      lastImported: {
        bookmarks: Math.max(0, Math.min(10000, Math.round(Number(xPolling.lastImported && xPolling.lastImported.bookmarks) || 0))),
        likes: Math.max(0, Math.min(10000, Math.round(Number(xPolling.lastImported && xPolling.lastImported.likes) || 0))),
      },
      lastError: typeof xPolling.lastError === 'string' ? xPolling.lastError.slice(0, 500) : '',
      authError,
    },
  };
}

function saveAppraiserState(input) {
  ensureAppraiserStorage();
  const clean = normalizeAppraiserState(input);
  fs.writeFileSync(APPRAISER_STATE_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

function loadAppraiserState() {
  ensureAppraiserStorage();
  const raw = readJsonFileSafe(APPRAISER_STATE_PATH, DEFAULT_APPRAISER_STATE);
  const clean = normalizeAppraiserState(raw);
  fs.writeFileSync(APPRAISER_STATE_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

function saveAppraiserConfig(config) {
  ensureAppraiserStorage();
  const clean = sanitizeAppraiserConfig(config);
  fs.writeFileSync(APPRAISER_CONFIG_PATH, JSON.stringify(clean, null, 2) + '\n');
  const state = loadAppraiserState();
  if (state.xPolling.authError) {
    saveAppraiserState({
      ...state,
      xPolling: { ...state.xPolling, authError: null, lastError: '' },
    });
  }
  return clean;
}

function normalizeAppraiserStatus(status, fallback = 'pending') {
  return APPRAISER_ITEM_STATUSES.has(status) ? status : fallback;
}

function normalizeAppraiserCategory(category, fallback = 'other') {
  return APPRAISER_CATEGORIES.has(category) ? category : fallback;
}

function normalizeAppraiserClassification(input) {
  if (!input || typeof input !== 'object') return null;
  const relevance = Math.max(0, Math.min(100, Math.round(Number(input.relevance) || 0)));
  return {
    category: normalizeAppraiserCategory(input.category),
    relevance,
    reason: typeof input.reason === 'string' ? input.reason.trim().slice(0, 2000) : '',
  };
}

function normalizeAppraiserVerdict(input) {
  if (!input || typeof input !== 'object') return null;
  const score = Math.max(0, Math.min(100, Math.round(Number(input.score) || 0)));
  const testResult = input.testResult && typeof input.testResult === 'object'
    ? {
      status: typeof input.testResult.status === 'string' ? input.testResult.status.trim().slice(0, 40) : '',
      summary: typeof input.testResult.summary === 'string' ? input.testResult.summary.trim().slice(0, 4000) : '',
      output: typeof input.testResult.output === 'string' ? input.testResult.output.trim().slice(0, 12000) : '',
      repoUrl: typeof input.testResult.repoUrl === 'string' ? input.testResult.repoUrl.trim().slice(0, 2000) : '',
    }
    : null;
  return {
    score,
    summary: typeof input.summary === 'string' ? input.summary.trim().slice(0, 4000) : '',
    novelty: typeof input.novelty === 'string' ? input.novelty.trim().slice(0, 4000) : '',
    howToUse: typeof input.howToUse === 'string' ? input.howToUse.trim().slice(0, 4000) : '',
    monetizationIdea: typeof input.monetizationIdea === 'string' ? input.monetizationIdea.trim().slice(0, 4000) : '',
    nextAction: typeof input.nextAction === 'string' ? input.nextAction.trim().slice(0, 2000) : '',
    sources: uniqStrings(input.sources, 20, 2000),
    testResult,
    merchantQueued: !!input.merchantQueued,
    merchantJobId: typeof input.merchantJobId === 'string' ? input.merchantJobId.slice(0, 80) : null,
  };
}

function normalizeAppraiserItem(input) {
  if (!input || typeof input !== 'object') return null;
  const createdAt = typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString();
  const updatedAt = typeof input.updatedAt === 'string' ? input.updatedAt : createdAt;
  const classification = normalizeAppraiserClassification(input.classification);
  const verdict = normalizeAppraiserVerdict(input.verdict);
  const links = uniqStrings(input.links, 20, 2000);
  return {
    id: typeof input.id === 'string' ? input.id : makeId('app'),
    url: typeof input.url === 'string' ? input.url.trim().slice(0, 2000) : '',
    note: typeof input.note === 'string' ? input.note.trim().slice(0, 4000) : '',
    title: typeof input.title === 'string' ? input.title.trim().slice(0, 300) : '',
    tweetId: typeof input.tweetId === 'string' ? input.tweetId.trim().slice(0, 64) : '',
    tweetText: typeof input.tweetText === 'string' ? input.tweetText.trim().slice(0, 12000) : '',
    links,
    status: normalizeAppraiserStatus(input.status),
    classification,
    verdict,
    source: typeof input.source === 'string' ? input.source.trim().slice(0, 80) : 'manual',
    reportId: typeof input.reportId === 'string' ? input.reportId.slice(0, 80) : null,
    error: typeof input.error === 'string' ? input.error.slice(0, 500) : null,
    createdAt,
    updatedAt,
    startedAt: typeof input.startedAt === 'string' ? input.startedAt : null,
    finishedAt: typeof input.finishedAt === 'string' ? input.finishedAt : null,
  };
}

function loadAppraiserItems() {
  ensureAppraiserStorage();
  const arr = readJsonFileSafe(APPRAISER_ITEMS_PATH, []);
  return Array.isArray(arr) ? arr.map(normalizeAppraiserItem).filter(Boolean) : [];
}

function saveAppraiserItems(items) {
  ensureAppraiserStorage();
  fs.writeFileSync(APPRAISER_ITEMS_PATH, JSON.stringify((Array.isArray(items) ? items : []).map(normalizeAppraiserItem).filter(Boolean), null, 2) + '\n');
}

function updateAppraiserItemById(itemId, updater) {
  const items = loadAppraiserItems();
  const idx = items.findIndex((item) => item.id === itemId);
  if (idx < 0) return null;
  const next = updater(items[idx]) || items[idx];
  items[idx] = normalizeAppraiserItem({ ...items[idx], ...next, id: itemId, updatedAt: new Date().toISOString() });
  saveAppraiserItems(items);
  return items[idx];
}

function appraiserReportPath(reportId) {
  return path.join(APPRAISER_REPORTS_DIR, `${reportId}.md`);
}

function saveAppraiserReport(reportId, meta, body) {
  ensureAppraiserStorage();
  fs.writeFileSync(appraiserReportPath(reportId), outputFrontMatter(meta) + String(body || '').trim() + '\n');
}

function readAppraiserReport(reportId) {
  if (!/^[a-z0-9-]+$/i.test(reportId || '')) return null;
  const filePath = appraiserReportPath(reportId);
  if (!fs.existsSync(filePath)) return null;
  const { meta, body } = parseOutputFile(filePath);
  return {
    id: reportId,
    ...meta,
    body,
  };
}

function listAppraiserReports() {
  ensureAppraiserStorage();
  let files = [];
  try { files = fs.readdirSync(APPRAISER_REPORTS_DIR).filter((file) => file.endsWith('.md')); } catch { return []; }
  const out = [];
  for (const file of files) {
    const report = readAppraiserReport(file.replace(/\.md$/, ''));
    if (!report) continue;
    out.push({
      id: report.id,
      itemId: report.itemId || null,
      url: report.url || '',
      title: report.title || report.summary || '',
      category: normalizeAppraiserCategory(report.category),
      relevance: Math.max(0, Math.min(100, Math.round(Number(report.relevance) || 0))),
      score: Math.max(0, Math.min(100, Math.round(Number(report.score) || 0))),
      summary: typeof report.summary === 'string' ? report.summary.slice(0, 300) : '',
      merchantQueued: !!report.merchantQueued,
      merchantJobId: typeof report.merchantJobId === 'string' ? report.merchantJobId : null,
      updatedAt: typeof report.updatedAt === 'string' ? report.updatedAt : (typeof report.createdAt === 'string' ? report.createdAt : null),
      createdAt: typeof report.createdAt === 'string' ? report.createdAt : null,
    });
  }
  out.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  return out;
}

function loadAppraiserSeen() {
  ensureAppraiserStorage();
  const raw = readJsonFileSafe(APPRAISER_SEEN_PATH, DEFAULT_APPRAISER_SEEN);
  const clean = {};
  for (const key of ['bookmarks', 'likes']) {
    clean[key] = uniqStrings(raw && raw[key], 5000, 80);
  }
  return clean;
}

function saveAppraiserSeen(seen) {
  ensureAppraiserStorage();
  const clean = {
    bookmarks: uniqStrings(seen && seen.bookmarks, 5000, 80),
    likes: uniqStrings(seen && seen.likes, 5000, 80),
  };
  fs.writeFileSync(APPRAISER_SEEN_PATH, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

function appraiserDecodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function appraiserHtmlToText(html) {
  return appraiserDecodeHtmlEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' '))
    .trim();
}

function appraiserExtractLinksFromText(text) {
  const out = [];
  const seen = new Set();
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  for (const match of String(text || '').match(re) || []) {
    const url = match.replace(/[),.;!?]+$/, '');
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= 20) break;
  }
  return out;
}

function appraiserTitleFromText(text, fallback = '') {
  const line = String(text || '').split('\n').map((item) => item.trim()).find(Boolean) || '';
  return (line || fallback || '').slice(0, 300);
}

function appraiserIsXPostUrl(url) {
  return /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+/i.test(String(url || '').trim());
}

function appraiserParseGithubRepo(url) {
  const m = String(url || '').trim().match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:[/?#]|$)/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  return { owner, repo, fullName: `${owner}/${repo}`, cloneUrl: `https://github.com/${owner}/${repo}.git`, webUrl: `https://github.com/${owner}/${repo}` };
}

function appraiserParseArxivId(url) {
  const m = String(url || '').trim().match(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/([a-z0-9.+/-]+?)(?:\.pdf)?(?:[?#].*)?$/i);
  return m ? m[1] : null;
}

function appraiserCollectItemLinks(item) {
  return uniqStrings([
    ...(item.links || []),
    ...appraiserExtractLinksFromText(item.tweetText),
    ...appraiserExtractLinksFromText(item.note),
    item.url,
  ].filter(Boolean), 20, 2000);
}

async function appraiserFetchTwitterOembed(url, fetchImpl = fetch) {
  const endpoint = 'https://publish.twitter.com/oembed?' + new URLSearchParams({ url: String(url || '').trim(), omit_script: 'true' });
  const res = await fetchImpl(endpoint, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`oEmbed ${res.status}`);
  const json = await res.json();
  const text = appraiserHtmlToText(json && json.html);
  return {
    title: appraiserTitleFromText(text),
    tweetText: text,
    authorName: typeof json.author_name === 'string' ? json.author_name : '',
  };
}

function appraiserRepoFromItem(item) {
  for (const link of appraiserCollectItemLinks(item)) {
    const repo = appraiserParseGithubRepo(link);
    if (repo) return repo;
  }
  return null;
}

async function appraiserFetchGithubContext(repo, fetchImpl = fetch) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ai-agents-view' };
  const repoRes = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, { headers });
  if (!repoRes.ok) throw new Error(`GitHub repo ${repoRes.status}`);
  const repoJson = await repoRes.json();
  const readmeRes = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/readme`, { headers });
  let readme = '';
  if (readmeRes.ok) {
    const readmeJson = await readmeRes.json();
    if (readmeJson && readmeJson.content) {
      try { readme = Buffer.from(String(readmeJson.content).replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { /* ignore */ }
    }
  }
  const description = typeof repoJson.description === 'string' ? repoJson.description : '';
  const topics = Array.isArray(repoJson.topics) ? repoJson.topics.join(', ') : '';
  return {
    kind: 'github',
    url: repo.webUrl,
    title: repo.fullName,
    text: [
      `Repository: ${repo.fullName}`,
      description ? `Description: ${description}` : '',
      topics ? `Topics: ${topics}` : '',
      Number.isFinite(Number(repoJson.stargazers_count)) ? `Stars: ${repoJson.stargazers_count}` : '',
      Number.isFinite(Number(repoJson.forks_count)) ? `Forks: ${repoJson.forks_count}` : '',
      typeof repoJson.language === 'string' && repoJson.language ? `Language: ${repoJson.language}` : '',
      typeof repoJson.updated_at === 'string' ? `Updated: ${repoJson.updated_at}` : '',
      readme ? `README:\n${readme.slice(0, 20000)}` : '',
    ].filter(Boolean).join('\n'),
    metadata: {
      fullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
      stars: repoJson.stargazers_count || 0,
      language: repoJson.language || '',
    },
  };
}

async function appraiserFetchArxivContext(url, fetchImpl = fetch) {
  const id = appraiserParseArxivId(url);
  if (!id) throw new Error('arXiv URL ではありません');
  const res = await fetchImpl(`https://arxiv.org/abs/${id}`, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`arXiv ${res.status}`);
  const html = await res.text();
  const title = appraiserDecodeHtmlEntities((html.match(/<meta\s+name="citation_title"\s+content="([^"]+)"/i) || [])[1] || (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || `arXiv:${id}`);
  const authors = [...html.matchAll(/<meta\s+name="citation_author"\s+content="([^"]+)"/gi)].map((m) => appraiserDecodeHtmlEntities(m[1])).slice(0, 12);
  const abstract = appraiserHtmlToText((html.match(/<blockquote[^>]*class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i) || [])[1] || '');
  return {
    kind: 'arxiv',
    url: `https://arxiv.org/abs/${id}`,
    title,
    text: [
      `Title: ${title}`,
      authors.length ? `Authors: ${authors.join(', ')}` : '',
      abstract ? `Abstract:\n${abstract}` : '',
    ].filter(Boolean).join('\n'),
    metadata: { arxivId: id },
  };
}

async function appraiserFetchGenericContext(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 ai-agents-view',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const contentType = String(res.headers.get('content-type') || '');
  if (contentType.includes('application/json')) {
    const json = await res.json();
    const text = JSON.stringify(json, null, 2).slice(0, 20000);
    return { kind: 'json', url, title: appraiserTitleFromText(url, url), text, metadata: {} };
  }
  const html = await res.text();
  const title = appraiserDecodeHtmlEntities((html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) || [])[1] || (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || url);
  const desc = appraiserDecodeHtmlEntities((html.match(/<meta\s+name="description"\s+content="([^"]+)"/i) || [])[1] || (html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) || [])[1] || '');
  const text = appraiserHtmlToText(html).slice(0, 20000);
  return {
    kind: 'web',
    url,
    title,
    text: [title ? `Title: ${title}` : '', desc ? `Description: ${desc}` : '', text].filter(Boolean).join('\n'),
    metadata: {},
  };
}

async function appraiserFetchLinkContext(url, fetchImpl = fetch) {
  const repo = appraiserParseGithubRepo(url);
  if (repo) return appraiserFetchGithubContext(repo, fetchImpl);
  if (appraiserParseArxivId(url)) return appraiserFetchArxivContext(url, fetchImpl);
  return appraiserFetchGenericContext(url, fetchImpl);
}

function appraiserPromptPrelude(config) {
  return `ユーザー関心プロフィール: ${config.interestProfile}\n重点: AI/ロボティクス研究に役立つ技術、AIエージェントの収益化、個人開発での再現性と実装可能性。`;
}

function appraiserParseJson(text) {
  return JSON.parse(stripJsonCodeFence(text));
}

async function runAppraiserJsonTask({ cfg, prompt, timeoutSec, maxTokens = 2200, useResearch = false }) {
  let lastErr = null;
  let currentPrompt = prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = useResearch
      ? (cfg.mode === 'api'
        ? await runResearchApi({ apiKey: cfg.apiKey, model: cfg.model, prompt: currentPrompt })
        : await runResearchCli({ cli: cfg.cli, model: cfg.model, prompt: currentPrompt }))
      : await runHustlerTextTask({
        cfg,
        system: 'あなたは技術調査アシスタントです。指定された JSON スキーマどおりに JSON のみ返してください。',
        prompt: currentPrompt,
        maxTokens,
        timeoutSec,
      });
    try {
      return appraiserParseJson(raw);
    } catch (error) {
      lastErr = error;
      currentPrompt = `${prompt}\n\n前回は JSON 解析に失敗しました。コードフェンスや説明文なしで、必ず JSON のみを返してください。`;
    }
  }
  throw lastErr || new Error('JSON解析に失敗しました');
}

async function classifyAppraiserItem(item, cfg, config, timeoutSec) {
  const prompt = `${appraiserPromptPrelude(config)}

次の受信アイテムを分類してください。
- category は research | money | tool | other
- relevance は 0-100
- reason は日本語で簡潔に
- 研究価値・収益化可能性・再現性を重視
- JSON のみ返す

入力:
${JSON.stringify({
    url: item.url,
    note: item.note,
    tweetText: item.tweetText,
    links: appraiserCollectItemLinks(item),
  }, null, 2)}

返却スキーマ:
{"category":"research|money|tool|other","relevance":0,"reason":"..."}`
;
  return normalizeAppraiserClassification(await runAppraiserJsonTask({ cfg, prompt, timeoutSec, maxTokens: 900 }));
}

async function appraiserResearchVerdict(item, cfg, config, contexts, timeoutSec) {
  const prompt = `${appraiserPromptPrelude(config)}

次の受信アイテムを調査し、研究価値または収益価値を評価してください。
- 必要に応じて Web 検索を使って補完してよい
- 事実と推測を混同しない
- summary / novelty / howToUse / nextAction は日本語で具体的に
- monetizationIdea は category が money に近いときだけ積極的に具体化
- score は 0-100
- JSON のみ返す

入力メタ:
${JSON.stringify({
    url: item.url,
    note: item.note,
    tweetText: item.tweetText,
    classification: item.classification,
    links: appraiserCollectItemLinks(item),
  }, null, 2)}

取得済みコンテキスト:
${JSON.stringify(contexts.map((ctx) => ({
    kind: ctx.kind,
    url: ctx.url,
    title: ctx.title,
    text: String(ctx.text || '').slice(0, 8000),
  })), null, 2)}

返却スキーマ:
{
  "score": 0,
  "summary": "...",
  "novelty": "...",
  "howToUse": "...",
  "monetizationIdea": "...",
  "nextAction": "...",
  "sources": ["https://..."]
}`;
  return normalizeAppraiserVerdict(await runAppraiserJsonTask({
    cfg,
    prompt,
    timeoutSec,
    maxTokens: 1700,
    useResearch: true,
  }));
}

function appraiserBuildReportBody(item, report) {
  const lines = [
    `# ${report.summary || item.title || item.url}`,
    '',
    '## 対象',
    `- URL: ${item.url}`,
    item.note ? `- メモ: ${item.note}` : '',
    item.tweetText ? `- 受信テキスト: ${item.tweetText}` : '',
    '',
    '## 要約',
    report.summary || '要約なし',
    '',
    '## 新規性',
    report.novelty || '特記事項なし',
    '',
    '## 活用案',
    report.howToUse || '特記事項なし',
    '',
    report.monetizationIdea ? '## 収益化アイデア' : '',
    report.monetizationIdea || '',
    '',
    report.testResult ? '## 実地検証' : '',
    report.testResult ? `- 状態: ${report.testResult.status || 'n/a'}\n- 要約: ${report.testResult.summary || ''}\n\n${report.testResult.output ? `\`\`\`\n${report.testResult.output}\n\`\`\`` : ''}` : '',
    '',
    '## 次の一手',
    report.nextAction || '継続ウォッチ',
    '',
    report.sources && report.sources.length ? '## 参照' : '',
    report.sources && report.sources.length ? report.sources.map((src) => `- ${src}`).join('\n') : '',
  ];
  return lines.filter((line, index, arr) => !(line === '' && arr[index - 1] === '')).join('\n').trim();
}

function appraiserHandsOnPrompt(repoUrl) {
  return `このリポジトリを README に従って最小構成でセットアップし、スモークテストを1つだけ実行してください。

要件:
- まず README と主要ファイルを読み、最短の再現手順を選ぶ
- GPU必須・大容量ダウンロード必須・外部APIキー必須なら中止して理由を書く
- 破壊的変更はしない
- 最終回答は日本語で、以下の JSON のみ返す
{"status":"passed|skipped|failed","summary":"...","output":"実行ログ要約"}

対象リポジトリ: ${repoUrl}`;
}

async function runAppraiserHandsOn(item, repo, config, provider) {
  if (!config.handsOn) return null;
  if (!repo) return null;
  if (!provider.cli) {
    return {
      status: 'skipped',
      summary: 'Claude CLI が見つからないため実地検証をスキップしました。',
      output: '',
      repoUrl: repo.webUrl,
    };
  }
  const labRoot = path.join(os.tmpdir(), 'appraiser-lab');
  const workDir = path.join(labRoot, item.id);
  ensureDir(labRoot);
  fs.rmSync(workDir, { recursive: true, force: true });
  try {
    await runSpawn('git', ['clone', '--depth', '1', repo.cloneUrl, workDir], { cwd: labRoot, timeoutMs: 180000 });
    const raw = await new Promise((resolve, reject) => {
      const args = [
        '-p', appraiserHandsOnPrompt(repo.webUrl),
        '--model', provider.model,
        '--output-format', 'json',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      ];
      let child;
      try { child = spawn(provider.cli, args, { env: process.env, cwd: workDir }); }
      catch (error) { reject(new Error('起動失敗: ' + error.message)); return; }
      let out = ''; let err = ''; let settled = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          reject(new Error(`タイムアウト(${config.testTimeoutSec}秒)`));
        }
      }, config.testTimeoutSec * 1000);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('起動失敗: ' + error.message));
      });
      child.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          const json = JSON.parse(out);
          if (json.is_error) reject(new Error(String(json.result || 'CLI エラー').slice(0, 300)));
          else resolve(String(json.result || '').trim());
        } catch {
          reject(new Error((err || out || '応答なし').slice(0, 300)));
        }
      });
    });
    const parsed = appraiserParseJson(raw);
    return {
      status: typeof parsed.status === 'string' ? parsed.status.slice(0, 40) : 'failed',
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 4000) : '',
      output: typeof parsed.output === 'string' ? parsed.output.slice(0, 12000) : '',
      repoUrl: repo.webUrl,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function appraiserMerchantSourceKey(item) {
  return `appraiser:${item.id}`;
}

function maybeQueueHustlerFromAppraiser(item, verdict) {
  if (!item || !verdict) return null;
  if (!(item.classification && item.classification.category === 'money' && verdict.score >= 70)) return null;
  const jobs = loadHustlerJobs();
  const sourceKey = appraiserMerchantSourceKey(item);
  const existing = jobs.find((job) => job.type === 'idea_research' && job.source === sourceKey);
  if (existing) return { queued: false, job: existing };
  return enqueueHustlerJob({
    type: 'idea_research',
    topic: verdict.monetizationIdea || item.title || item.url,
  }, {
    source: sourceKey,
    note: '鑑定士の高評価 money レポートから自動追加',
  });
}

function appraiserXStatusFromConfig(config, state) {
  const xApi = config.xApi || DEFAULT_APPRAISER_CONFIG.xApi;
  const configured = !!(xApi.bearerToken && xApi.userId && (xApi.pollBookmarks || xApi.pollLikes));
  return {
    configured,
    pollBookmarks: !!xApi.pollBookmarks,
    pollLikes: !!xApi.pollLikes,
    intervalHours: xApi.intervalHours,
    userId: xApi.userId ? `${String(xApi.userId).slice(0, 6)}…` : '',
    lastPollAt: state.xPolling.lastPollAt,
    lastSuccessAt: state.xPolling.lastSuccessAt,
    lastImported: state.xPolling.lastImported,
    lastError: state.xPolling.lastError,
    authError: state.xPolling.authError,
  };
}

function getAppraiserRuntimeGuard(nowMs = Date.now(), options = {}) {
  const manual = !!options.manual;
  const provider = loadHustlerProviderConfig();
  const hustlerConfig = loadHustlerConfig();
  const window5h = getWindow5hUsageStats();
  const lastActivityMs = getLatestLocalActivityMs();
  const idle = !lastActivityMs || (nowMs - lastActivityMs) >= hustlerConfig.idleMinutes * 60 * 1000;
  const withinBudget = (window5h.totalTokens + HUSTLER_TOKEN_HEADROOM) < hustlerConfig.tokenBudget5h;
  const blockers = [];
  if (provider.mode === 'off') blockers.push('Claude CLI か Anthropic API が未設定です');
  if (!manual && !idle) blockers.push(`遊休判定(${hustlerConfig.idleMinutes}分)を満たしていません`);
  if (!manual && !withinBudget) blockers.push('直近5時間トークン予算を超過しています');
  if (explorerRunning) blockers.push('探検家が実行中です');
  if (hustlerRunning) blockers.push('商人が実行中です');
  if (creatorRunning) blockers.push('動画職人が実行中です');
  if (traderRunning) blockers.push('トレーダーが実行中です');
  if (appraiserRunning) blockers.push('鑑定士が実行中です');
  return {
    mode: provider.mode,
    model: provider.model,
    cli: provider.cli,
    apiKey: provider.apiKey,
    idle,
    idleMinutes: hustlerConfig.idleMinutes,
    tokenBudget5h: hustlerConfig.tokenBudget5h,
    window5h,
    withinBudget,
    blockers,
    canRun: !blockers.length,
    manual,
  };
}

function getAppraiserStatus(options = {}) {
  const config = options.config || loadAppraiserConfig();
  const state = options.state || loadAppraiserState();
  const items = options.items || loadAppraiserItems();
  const runtime = options.runtime || getAppraiserRuntimeGuard(Date.now(), { manual: false });
  const counts = {
    total: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    classifying: items.filter((item) => item.status === 'classifying').length,
    researching: items.filter((item) => item.status === 'researching').length,
    testing: items.filter((item) => item.status === 'testing').length,
    done: items.filter((item) => item.status === 'done').length,
    error: items.filter((item) => item.status === 'error').length,
  };
  const lastRun = items
    .map((item) => item.finishedAt || item.startedAt || '')
    .filter(Boolean)
    .sort()
    .pop() || null;
  return {
    config,
    running: appraiserRunning,
    runningItemId: appraiserRunningItemId,
    queue: counts,
    lastRun,
    runtime: {
      mode: runtime.mode,
      idle: runtime.idle,
      idleMinutes: runtime.idleMinutes,
      tokenBudget5h: runtime.tokenBudget5h,
      window5h: runtime.window5h,
      withinBudget: runtime.withinBudget,
      canRun: runtime.canRun && counts.pending > 0,
      blockers: runtime.blockers,
    },
    xStatus: appraiserXStatusFromConfig(config, state),
  };
}

async function appraiserCreateInboxItem(input, options = {}) {
  const src = (input && typeof input === 'object') ? input : {};
  const url = typeof src.url === 'string' ? src.url.trim().slice(0, 2000) : '';
  if (!/^https?:\/\//i.test(url)) throw new Error('url は http(s) URL を指定してください');
  const note = typeof src.note === 'string' ? src.note.trim().slice(0, 4000) : '';
  let tweetText = typeof src.tweetText === 'string' ? src.tweetText.trim().slice(0, 12000) : '';
  let title = typeof src.title === 'string' ? src.title.trim().slice(0, 300) : '';
  const links = uniqStrings(src.links, 20, 2000);
  if (appraiserIsXPostUrl(url) && !tweetText) {
    try {
      const oembed = await appraiserFetchTwitterOembed(url, options.fetchImpl || fetch);
      tweetText = oembed.tweetText || tweetText;
      title = oembed.title || title;
    } catch { /* 失敗しても URL のみで進める */ }
  }
  const item = normalizeAppraiserItem({
    id: typeof src.id === 'string' ? src.id : makeId('app'),
    url,
    note,
    title: title || appraiserTitleFromText(tweetText, url),
    tweetId: typeof src.tweetId === 'string' ? src.tweetId : '',
    tweetText,
    links: uniqStrings([...links, ...appraiserExtractLinksFromText(tweetText), ...appraiserExtractLinksFromText(note)], 20, 2000),
    source: typeof src.source === 'string' ? src.source : 'manual',
    status: 'pending',
    createdAt: typeof src.createdAt === 'string' ? src.createdAt : new Date().toISOString(),
    updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : new Date().toISOString(),
  });
  const items = loadAppraiserItems();
  items.push(item);
  saveAppraiserItems(items);
  return item;
}

async function appraiserFetchXTimeline(kind, config, seenSet, fetchImpl = fetch) {
  const pathName = kind === 'likes' ? 'liked_tweets' : 'bookmarks';
  const isInitial = seenSet.size === 0;
  const limit = isInitial ? 20 : 50;
  const imported = [];
  const headers = {
    Authorization: `Bearer ${config.xApi.bearerToken}`,
    Accept: 'application/json',
  };
  let nextToken = null;
  let hitKnown = false;
  do {
    const params = new URLSearchParams({
      'tweet.fields': 'text,entities,created_at',
      expansions: 'author_id',
      'user.fields': 'username,name',
      max_results: String(Math.min(50, limit - imported.length)),
    });
    if (nextToken) params.set('pagination_token', nextToken);
    const res = await fetchImpl(`https://api.x.com/2/users/${encodeURIComponent(config.xApi.userId)}/${pathName}?${params}`, { headers });
    if (res.status === 401) {
      const err = new Error('X API 401: bearerToken が無効か期限切れです');
      err.status = 401;
      throw err;
    }
    if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const users = new Map(((json.includes && json.includes.users) || []).map((user) => [String(user.id), user]));
    for (const tweet of Array.isArray(json.data) ? json.data : []) {
      const id = String(tweet.id || '');
      if (!id) continue;
      if (seenSet.has(id)) {
        hitKnown = true;
        break;
      }
      const user = users.get(String(tweet.author_id || ''));
      const links = [];
      for (const entry of (((tweet.entities || {}).urls) || [])) {
        const expanded = entry && (entry.unwound_url || entry.expanded_url || entry.url);
        if (expanded) links.push(String(expanded));
      }
      for (const entry of appraiserExtractLinksFromText(tweet.text)) links.push(entry);
      imported.push({
        tweetId: id,
        url: `https://x.com/${user && user.username ? user.username : 'i/web'}/status/${id}`,
        title: appraiserTitleFromText(tweet.text, id),
        tweetText: typeof tweet.text === 'string' ? tweet.text : '',
        links: uniqStrings(links, 20, 2000),
        note: kind === 'likes' ? 'X API likes' : 'X API bookmarks',
        source: kind === 'likes' ? 'x-likes' : 'x-bookmarks',
        createdAt: typeof tweet.created_at === 'string' ? tweet.created_at : new Date().toISOString(),
      });
      if (imported.length >= limit) break;
    }
    nextToken = json.meta && json.meta.next_token ? String(json.meta.next_token) : null;
  } while (!isInitial && nextToken && !hitKnown && imported.length < limit);
  return imported;
}

async function maybePollAppraiserX(options = {}) {
  const config = options.config || loadAppraiserConfig();
  const state = options.state || loadAppraiserState();
  const xApi = config.xApi;
  if (!(xApi.bearerToken && xApi.userId && (xApi.pollBookmarks || xApi.pollLikes))) return { ok: true, imported: { bookmarks: 0, likes: 0 }, skipped: 'not-configured' };
  if (state.xPolling.authError) return { ok: false, imported: { bookmarks: 0, likes: 0 }, skipped: 'auth-error' };
  const lastPollMs = state.xPolling.lastPollAt ? Date.parse(state.xPolling.lastPollAt) : 0;
  const intervalMs = xApi.intervalHours * 60 * 60 * 1000;
  if (!options.force && lastPollMs && (Date.now() - lastPollMs) < intervalMs) {
    return { ok: true, imported: { bookmarks: 0, likes: 0 }, skipped: 'interval' };
  }
  const seen = loadAppraiserSeen();
  const nextSeen = { ...seen };
  const importedCounts = { bookmarks: 0, likes: 0 };
  try {
    for (const kind of ['bookmarks', 'likes']) {
      if (kind === 'bookmarks' && !xApi.pollBookmarks) continue;
      if (kind === 'likes' && !xApi.pollLikes) continue;
      const feed = await appraiserFetchXTimeline(kind, config, new Set(seen[kind] || []), options.fetchImpl || fetch);
      for (const tweet of feed) {
        await appraiserCreateInboxItem(tweet, { fetchImpl: options.fetchImpl || fetch });
      }
      importedCounts[kind] = feed.length;
      nextSeen[kind] = uniqStrings([...(feed.map((tweet) => tweet.tweetId)), ...(seen[kind] || [])], 5000, 80);
    }
    saveAppraiserSeen(nextSeen);
    saveAppraiserState({
      xPolling: {
        lastPollAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        lastImported: importedCounts,
        lastError: '',
        authError: null,
      },
    });
    return { ok: true, imported: importedCounts };
  } catch (error) {
    saveAppraiserState({
      xPolling: {
        lastPollAt: new Date().toISOString(),
        lastSuccessAt: state.xPolling.lastSuccessAt,
        lastImported: importedCounts,
        lastError: String(error.message || error).slice(0, 500),
        authError: error.status === 401 ? {
          at: new Date().toISOString(),
          message: String(error.message || error).slice(0, 400),
          status: 401,
        } : state.xPolling.authError,
      },
    });
    throw error;
  }
}

async function executeAppraiserItem(itemId, options = {}) {
  if (appraiserRunning) throw new Error('別の鑑定ジョブを実行中です');
  const runtime = options.runtime || getAppraiserRuntimeGuard(Date.now(), { manual: !!options.manual });
  if (!runtime.canRun) throw new Error(runtime.blockers[0] || '鑑定を実行できません');
  const config = loadAppraiserConfig();
  const provider = loadHustlerProviderConfig();
  const items = loadAppraiserItems();
  const target = items.find((item) => item.id === itemId);
  if (!target) throw new Error('アイテムが見つかりません');
  const timeoutSec = loadHustlerConfig().cliTimeoutSec;
  appraiserRunning = true;
  appraiserRunningItemId = itemId;
  let item = updateAppraiserItemById(itemId, (current) => ({
    ...current,
    status: 'classifying',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  })) || target;
  try {
    const classification = await classifyAppraiserItem(item, provider, config, timeoutSec);
    item = updateAppraiserItemById(itemId, (current) => ({
      ...current,
      classification,
      status: classification && classification.relevance >= 40 ? 'researching' : 'done',
      title: current.title || appraiserTitleFromText(current.tweetText, current.url),
    })) || item;

    let contexts = [];
    let verdict = normalizeAppraiserVerdict({
      score: classification ? Math.round(classification.relevance * 0.6) : 0,
      summary: classification && classification.reason ? classification.reason : '関連性が低いため軽量判定で完了しました。',
      novelty: classification && classification.relevance < 40 ? '関連性が低く、詳細調査は見送りました。' : '',
      howToUse: classification && classification.relevance < 40 ? '必要になったら URL を再確認してください。' : '',
      monetizationIdea: '',
      nextAction: classification && classification.relevance < 40 ? '保留' : '',
      sources: uniqStrings([item.url, ...appraiserCollectItemLinks(item)], 20, 2000),
    });

    if (classification && classification.relevance >= 40) {
      for (const link of appraiserCollectItemLinks(item).slice(0, 4)) {
        try { contexts.push(await appraiserFetchLinkContext(link, options.fetchImpl || fetch)); }
        catch (error) {
          contexts.push({
            kind: 'error',
            url: link,
            title: link,
            text: `取得失敗: ${String(error.message || error).slice(0, 300)}`,
            metadata: {},
          });
        }
      }
      if (!contexts.length) {
        contexts.push({
          kind: 'inline',
          url: item.url,
          title: item.title || item.url,
          text: [item.note, item.tweetText].filter(Boolean).join('\n').slice(0, 10000),
          metadata: {},
        });
      }
      verdict = appraiserResearchVerdict(item, provider, config, contexts, timeoutSec);
      verdict = normalizeAppraiserVerdict(await verdict);
      const repo = appraiserRepoFromItem(item);
      if (repo && config.handsOn) {
        item = updateAppraiserItemById(itemId, (current) => ({ ...current, status: 'testing' })) || item;
        verdict.testResult = await runAppraiserHandsOn(item, repo, config, provider);
      }
    }

    const merchant = maybeQueueHustlerFromAppraiser(item, verdict);
    if (merchant && merchant.job) {
      verdict.merchantQueued = merchant.queued !== false;
      verdict.merchantJobId = merchant.job.id;
    }
    const reportMeta = {
      itemId: item.id,
      url: item.url,
      title: item.title || verdict.summary || item.url,
      category: item.classification ? item.classification.category : 'other',
      relevance: item.classification ? item.classification.relevance : 0,
      score: verdict.score,
      summary: verdict.summary,
      merchantQueued: !!verdict.merchantQueued,
      merchantJobId: verdict.merchantJobId || null,
      createdAt: item.createdAt,
      updatedAt: new Date().toISOString(),
    };
    saveAppraiserReport(item.id, reportMeta, appraiserBuildReportBody(item, verdict));
    item = updateAppraiserItemById(itemId, (current) => ({
      ...current,
      status: 'done',
      verdict,
      reportId: item.id,
      finishedAt: new Date().toISOString(),
      error: null,
    })) || item;
    return item;
  } catch (error) {
    updateAppraiserItemById(itemId, (current) => ({
      ...current,
      status: 'error',
      finishedAt: new Date().toISOString(),
      error: String(error.message || error).slice(0, 500),
    }));
    throw error;
  } finally {
    appraiserRunning = false;
    appraiserRunningItemId = null;
  }
}

async function maybeRunAppraiserScheduled() {
  const config = loadAppraiserConfig();
  try { await maybePollAppraiserX({ config }); } catch (error) { console.error('[appraiser] X polling 失敗:', error.message); }
  const status = getAppraiserStatus({ config });
  if (!status.runtime.canRun) return null;
  const target = loadAppraiserItems()
    .filter((item) => item.status === 'pending')
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))[0];
  if (!target) return null;
  console.log(`[appraiser] 定期実行を開始: ${target.id} ${target.url}`);
  return executeAppraiserItem(target.id, { runtime: getAppraiserRuntimeGuard(Date.now(), { manual: false }) });
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
function maybeQueueHustlerFromExplorer(topic) {
  const config = loadHustlerConfig();
  if (!config.autoFromExplorer) return null;
  return enqueueHustlerJob({
    type: 'article_draft',
    topic,
  }, {
    dedupeTopic: true,
    source: 'explorer',
    note: '探検家の新規レポートから自動追加',
  });
}

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
  try {
    maybeQueueHustlerFromExplorer(topic);
    maybeQueueCreatorFromExplorer(topic);
  } catch (e) { console.error('[hustler] 探検家連携失敗:', e.message); }
  return { topic, report, at: st.reports[topic].at, provider };
}

/** 直近の「月曜9:00」を跨いでいたら、保存トピックを順次調査する */
async function checkWeekly() {
  if (explorerRunning || hustlerRunning || creatorRunning) return;
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
        if (explorerRunning || hustlerRunning || creatorRunning) { sendJson(res, 200, { error: '別の調査/生成ジョブを実行中です。少し待ってから再度お試しください。', running: true }); return; }
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

  /* ── 鑑定士──────────────────────────── */
  if (url.pathname === '/api/appraiser/status') {
    sendJson(res, 200, getAppraiserStatus());
    return;
  }

  if (url.pathname === '/api/appraiser/config') {
    if (req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const config = saveAppraiserConfig(body || {});
          sendJson(res, 200, { ok: true, config, status: getAppraiserStatus({ config }) });
        })
        .catch((e) => sendJson(res, 500, { error: String(e.message) }));
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/appraiser/inbox') {
    readJsonBody(req)
      .then(async (body) => {
        const item = await appraiserCreateInboxItem(body || {});
        sendJson(res, 200, { ok: true, item });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/appraiser/items') {
    const items = loadAppraiserItems().sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
    sendJson(res, 200, { items });
    return;
  }

  if (req.method === 'DELETE' && /^\/api\/appraiser\/items\/[^/]+$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const items = loadAppraiserItems();
    const idx = items.findIndex((item) => item.id === id);
    if (idx < 0) { sendJson(res, 404, { error: 'アイテムが見つかりません' }); return; }
    if (appraiserRunning && appraiserRunningItemId === id) { sendJson(res, 409, { error: '実行中アイテムは削除できません' }); return; }
    const removed = items.splice(idx, 1)[0];
    saveAppraiserItems(items);
    const reportPath = appraiserReportPath(id);
    if (fs.existsSync(reportPath)) fs.rmSync(reportPath, { force: true });
    sendJson(res, 200, { ok: true, item: removed });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/appraiser/run') {
    readJsonBody(req)
      .then(async (body) => {
        const items = loadAppraiserItems();
        const target = body && body.id
          ? items.find((item) => item.id === String(body.id))
          : items.filter((item) => item.status === 'pending').sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))[0];
        if (!target) throw new Error('実行できるアイテムがありません');
        const runtime = getAppraiserRuntimeGuard(Date.now(), { manual: true });
        sendJson(res, 200, { ok: true, item: await executeAppraiserItem(target.id, { manual: true, runtime }) });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/appraiser/reports') {
    sendJson(res, 200, { reports: listAppraiserReports() });
    return;
  }

  if (req.method === 'GET' && /^\/api\/appraiser\/reports\/[^/]+$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const report = readAppraiserReport(id);
    if (!report) { sendJson(res, 404, { error: 'レポートが見つかりません' }); return; }
    sendJson(res, 200, report);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/appraiser/add') {
    Promise.resolve()
      .then(async () => {
        const rawUrl = url.searchParams.get('url') || '';
        const note = url.searchParams.get('note') || '';
        if (!rawUrl.trim()) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('<!doctype html><meta charset="utf-8"><title>鑑定士</title><body style="font-family:sans-serif;padding:24px"><h1>URL が必要です</h1><p><code>?url=https://...</code> を付けて呼び出してください。</p></body>');
          return;
        }
        const item = await appraiserCreateInboxItem({ url: rawUrl, note, source: 'share-sheet' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><title>鑑定士</title><body style="font-family:sans-serif;padding:24px;line-height:1.6"><h1>受信しました</h1><p>鑑定士の受信箱に追加しました。</p><p><b>ID:</b> ${escapeHtml(item.id)}</p><p><a href="/">ダッシュボードへ戻る</a></p></body>`);
      })
      .catch((e) => {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><title>鑑定士</title><body style="font-family:sans-serif;padding:24px"><h1>追加に失敗しました</h1><pre>${escapeHtml(String(e.message || e))}</pre></body>`);
      });
    return;
  }

  /* ── 商人(内職)──────────────────────────── */
  if (url.pathname === '/api/hustler/status') {
    sendJson(res, 200, getHustlerStatus());
    return;
  }

  if (url.pathname === '/api/hustler/config') {
    if (req.method === 'GET') {
      sendJson(res, 200, { config: loadHustlerConfig(), status: getHustlerStatus() });
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const config = saveHustlerConfig(body || {});
          sendJson(res, 200, { ok: true, config, status: getHustlerStatus() });
        })
        .catch((e) => sendJson(res, 500, { error: String(e.message) }));
      return;
    }
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
          const queued = enqueueHustlerJob(body || {});
          sendJson(res, 200, { ok: true, job: queued.job });
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
    if (HUSTLER_RESTARTABLE_STATUSES.has(jobs[idx].status)) { sendJson(res, 409, { error: '実行中ジョブは削除できません' }); return; }
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

  if (req.method === 'POST' && /^\/api\/hustler\/publish\/[^/]+$/.test(url.pathname)) {
    const outputId = decodeURIComponent(url.pathname.split('/').pop());
    Promise.resolve()
      .then(async () => {
        const output = await publishHustlerOutput(outputId, { manual: true });
        sendJson(res, 200, { ok: true, output, status: getHustlerStatus() });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  if (req.method === 'POST' && /^\/api\/hustler\/retry\/[^/]+$/.test(url.pathname)) {
    const outputId = decodeURIComponent(url.pathname.split('/').pop());
    Promise.resolve()
      .then(() => {
        const result = retryHustlerOutput(outputId);
        sendJson(res, 200, { ok: true, ...result, status: getHustlerStatus() });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
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

  /* ── 動画職人──────────────────────────── */
  if (url.pathname === '/api/creator/status') {
    sendJson(res, 200, getCreatorStatus());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/creator/config') {
    readJsonBody(req)
      .then((body) => {
        const config = saveCreatorConfig(body || {});
        sendJson(res, 200, { ok: true, config, status: getCreatorStatus() });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  if (url.pathname === '/api/creator/jobs') {
    if (req.method === 'GET') {
      const jobs = loadCreatorJobs().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      sendJson(res, 200, { jobs });
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const queued = enqueueCreatorJob(body || {});
          sendJson(res, 200, { ok: true, job: queued.job });
        })
        .catch((e) => sendJson(res, 500, { error: String(e.message) }));
      return;
    }
  }

  if (req.method === 'DELETE' && /^\/api\/creator\/jobs\/[^/]+$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const jobs = loadCreatorJobs();
    const idx = jobs.findIndex((job) => job.id === id);
    if (idx < 0) { sendJson(res, 404, { error: 'ジョブが見つかりません' }); return; }
    if (CREATOR_RESTARTABLE_STATUSES.has(jobs[idx].status)) { sendJson(res, 409, { error: '実行中ジョブは削除できません' }); return; }
    const removed = jobs.splice(idx, 1)[0];
    saveCreatorJobs(jobs);
    sendJson(res, 200, { ok: true, job: removed });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/creator/run') {
    readJsonBody(req)
      .then(async (body) => {
        let target = null;
        if (body && typeof body.topic === 'string' && body.topic.trim()) {
          target = enqueueCreatorJob({ topic: body.topic.trim() }).job;
        } else {
          const jobs = loadCreatorJobs();
          target = body && body.id
            ? jobs.find((job) => job.id === String(body.id))
            : jobs.filter((job) => job.status === 'pending').sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))[0];
        }
        if (!target) throw new Error('実行できるジョブがありません');
        sendJson(res, 200, {
          ok: true,
          job: await executeCreatorJob(target.id, {
            skipRuntimeGuard: true,
            useDraft: !!body.useDraft,
            sceneCount: body.sceneCount,
            sceneSeconds: body.sceneSeconds,
          }),
        });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  if (url.pathname === '/api/creator/videos') {
    if (req.method === 'GET') {
      sendJson(res, 200, { videos: listCreatorVideos() });
      return;
    }
  }

  if (req.method === 'GET' && /^\/api\/creator\/videos\/[^/]+$/.test(url.pathname)) {
    const videoId = decodeURIComponent(url.pathname.split('/').pop());
    const record = readCreatorVideoRecord(videoId);
    const filePath = creatorVideoFilePath(videoId);
    if (!record || !fs.existsSync(filePath)) { sendJson(res, 404, { error: '動画が見つかりません' }); return; }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (req.method === 'POST' && /^\/api\/creator\/publish\/[^/]+$/.test(url.pathname)) {
    const videoId = decodeURIComponent(url.pathname.split('/').pop());
    Promise.resolve()
      .then(async () => {
        const video = await publishCreatorVideo(videoId, { manual: true });
        sendJson(res, 200, { ok: true, video, status: getCreatorStatus() });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  /* ── トレーダー(ペーパートレード) ───────────── */
  if (url.pathname === '/api/trader/status') {
    sendJson(res, 200, getTraderStatus());
    return;
  }

  if (url.pathname === '/api/trader/config') {
    if (req.method === 'GET') {
      sendJson(res, 200, { config: loadTraderConfig(), status: getTraderStatus() });
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const config = saveTraderConfig(body || {});
          sendJson(res, 200, { ok: true, config, status: getTraderStatus({ config }) });
        })
        .catch((e) => sendJson(res, 500, { error: String(e.message) }));
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/trader/analyze') {
    Promise.resolve()
      .then(async () => {
        // 手動実行は遊休判定と5h予算を免除(プロバイダ/実行中のブロッカーは維持)
        const guard = getTraderRuntimeGuard();
        const blockers = guard.blockers.filter((b) => !b.startsWith('遊休判定') && !b.startsWith('直近5時間トークン予算'));
        const result = await analyzeTrader({ runtime: { ...guard, blockers, canAnalyze: !blockers.length } });
        sendJson(res, 200, result);
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/trader/history') {
    const config = loadTraderConfig();
    const portfolio = loadTraderPortfolio(null, config);
    sendJson(res, 200, {
      equityHistory: portfolio.equityHistory,
      trades: portfolio.trades.slice().reverse(),
      lastAnalysis: portfolio.lastAnalysis || null,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/trader/reset') {
    Promise.resolve()
      .then(() => {
        const config = loadTraderConfig();
        const portfolio = resetTraderPortfolio(null, config);
        sendJson(res, 200, { ok: true, portfolio, status: getTraderStatus({ config, portfolio }) });
      })
      .catch((e) => sendJson(res, 500, { error: String(e.message) }));
    return;
  }

  if (url.pathname === '/api/zones') {
    if (req.method === 'GET') {
      sendJson(res, 200, loadZoneOverrides());
      return;
    }
    if (req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const projectName = String(body.projectName || '').trim();
          const zone = sanitizeZone(body.zone);
          if (!projectName) throw new Error('projectName が必要です');
          if (!zone) throw new Error('zone は auto または interactive を指定してください');
          const overrides = saveZoneOverrides({ [projectName]: zone });
          sendJson(res, 200, { ok: true, projectName, zone, overrides });
        })
        .catch((e) => sendJson(res, 400, { ok: false, error: String(e.message) }));
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/tmux/panes') {
    listProjectTmuxPanes(url.searchParams.get('project') || '')
      .then((result) => sendJson(res, 200, result))
      .catch((e) => sendJson(res, 500, { available: true, panes: [], error: String(e.message) }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/tmux/send') {
    readJsonBody(req)
      .then(async (body) => {
        const paneId = sanitizeTmuxPaneId(body.paneId);
        const rawText = body.text;
        const hasText = typeof rawText === 'string' && rawText.length > 0;
        const hasKeyField = body.key !== undefined && body.key !== null && body.key !== '';
        const key = sanitizeTmuxKey(body.key);
        if (!paneId) throw new Error('paneId は %数字 形式で指定してください');
        if (hasKeyField && !key) throw new Error('許可されていない key です');
        if ((hasText ? 1 : 0) + (key ? 1 : 0) !== 1) {
          throw new Error('text か key のどちらか一方を指定してください');
        }

        try {
          if (hasText) {
            if (/[\r\n]/.test(rawText)) throw new Error('text に改行は含められません');
            await sendTmuxText(paneId, rawText);
          } else {
            await sendTmuxKey(paneId, key);
          }
        } catch (error) {
          if (isTmuxCommandMissing(error) || isTmuxPermissionError(error)) {
            sendJson(res, 503, { ok: false, error: 'tmux を利用できません' });
            return;
          }
          if (isTmuxNoServerError(error) || /can['’]t find pane/i.test(String(error.stderr || error.message || ''))) {
            sendJson(res, 404, { ok: false, error: '指定した tmux ペインが見つかりません' });
            return;
          }
          throw error;
        }

        sendJson(res, 200, { ok: true });
      })
      .catch((e) => sendJson(res, 400, { ok: false, error: String(e.message) }));
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

ensureHustlerStorage();
ensureCreatorStorage();
ensureTraderStorage();
ensureAppraiserStorage();
resetStaleHustlerJobs();
queueRetryableHustlerErrors();
resetStaleCreatorJobs();

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

function startServer() {
  server.listen(PORT, () => {
    console.log(`AI Agents View: http://localhost:${PORT}`);
    console.log(`watching: ${PROJECTS_DIR}`);
  });

  refreshPeers();
  setInterval(refreshPeers, 5000);

  const runWeekly = () => checkWeekly().catch((e) => console.error('[explorer] 週次エラー:', e.message));
  runWeekly();
  setInterval(runWeekly, 30 * 60 * 1000);

  const runHustler = () => maybeRunHustlerScheduled().catch((e) => console.error('[hustler] 定期実行エラー:', e.message));
  runHustler();
  setInterval(runHustler, HUSTLER_CHECK_MS);

  const runCreator = () => maybeRunCreatorScheduled().catch((e) => console.error('[creator] 定期実行エラー:', e.message));
  runCreator();
  setInterval(runCreator, HUSTLER_CHECK_MS);

  const runTrader = () => maybeRunTraderScheduled().catch((e) => console.error('[trader] 定期実行エラー:', e.message));
  runTrader();
  setInterval(runTrader, HUSTLER_CHECK_MS);

  const runAppraiser = () => maybeRunAppraiserScheduled().catch((e) => console.error('[appraiser] 定期実行エラー:', e.message));
  runAppraiser();
  setInterval(runAppraiser, HUSTLER_CHECK_MS);
}

if (require.main === module) startServer();

module.exports = {
  server,
  startServer,
  loadHustlerConfig,
  saveHustlerConfig,
  loadCreatorConfig,
  saveCreatorConfig,
  loadTraderConfig,
  saveTraderConfig,
  loadTraderFetchState,
  saveTraderFetchState,
  loadTraderPortfolio,
  saveTraderPortfolio,
  loadTraderPriceHistory,
  appendTraderPriceRecord,
  getTraderStatus,
  analyzeTrader,
  maybeRunTraderScheduled,
  resetTraderPortfolio,
  loadHustlerJobs,
  saveHustlerJobs,
  loadHustlerRevenue,
  saveHustlerRevenue,
  getHustlerStatus,
  listHustlerOutputs,
  getHustlerOutput,
  executeHustlerJob,
  maybeRunHustlerScheduled,
  getCreatorStatus,
  loadCreatorJobs,
  saveCreatorJobs,
  listCreatorVideos,
  readCreatorVideoRecord,
  saveCreatorVideoRecord,
  executeCreatorJob,
  maybeRunCreatorScheduled,
  publishCreatorVideo,
  enqueueCreatorJob,
  retryHustlerOutput,
  publishHustlerOutput,
  loadAppraiserConfig,
  saveAppraiserConfig,
  loadAppraiserItems,
  saveAppraiserItems,
  getAppraiserStatus,
  executeAppraiserItem,
  maybeRunAppraiserScheduled,
  maybePollAppraiserX,
  appraiserCreateInboxItem,
  listAppraiserReports,
  readAppraiserReport,
  doResearch,
  checkWeekly,
  enqueueHustlerJob,
  loadExplorerState,
  loadSecretaryConfig,
  flattenForCli,
  runClaudeCli,
  readHustlerOutputRecord,
  saveHustlerOutputRecord,
  _test: {
    buildHustlerReviewPrompt,
    buildHustlerRevisionPrompt,
    parseHustlerEvaluation,
    extractPublishBodyFromDraft,
    makeZennSlug,
    buildZennArticleContent,
    buildGenericArticleContent,
    finalizeHustlerContentForStorage,
    replaceAffiliatePlaceholders,
    ensureAffiliateDisclosure,
    resolvePublishTargetForRecord,
    maybeQueueHustlerFromExplorer,
    transitionHustlerJob,
    transitionHustlerOutput,
    traderPaths,
    makeDefaultTraderPortfolio,
    sanitizeTraderConfig,
    sanitizeTraderPortfolio,
    computeTraderIndicators,
    traderLatestPricesMap,
    computeTraderEquity,
    parseTraderAnalysis,
    appraiserFetchXTimeline,
    appraiserParseGithubRepo,
    normalizeAppraiserItem,
    fetchTraderPricesFromCoinGecko,
    fetchTraderPricesFromApi,
    fetchTraderPricesFromYahoo,
    fetchTraderPrices,
    maybeFetchTraderPrices,
    executeTraderSignals,
    getTraderRuntimeGuard,
    getHustlerResumeDraftRecord,
    queueRetryableHustlerErrors,
    parseCreatorResolution,
    runCreatorScene,
    concatCreatorScenes,
    creatorVideoFilePath,
    transitionCreatorVideo,
  },
};
