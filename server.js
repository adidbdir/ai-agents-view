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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

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
