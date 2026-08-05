#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const configPath = path.join(repoRoot, 'hustler-config.json');
const dataDir = path.join(repoRoot, 'data');
const hustlerDir = path.join(dataDir, 'hustler');
const outputsDir = path.join(hustlerDir, 'outputs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-agents-view-hustler-retry-'));
const backupDir = path.join(tempRoot, 'backup');
const backupConfigPath = path.join(backupDir, 'hustler-config.json');
const backupHustlerDir = path.join(backupDir, 'hustler');
let restored = false;

function backupWorkspace() {
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupConfigPath);
  if (fs.existsSync(hustlerDir)) fs.cpSync(hustlerDir, backupHustlerDir, { recursive: true });
}

function restoreWorkspace() {
  if (restored) return;
  restored = true;
  fs.rmSync(hustlerDir, { recursive: true, force: true });
  if (fs.existsSync(backupHustlerDir)) fs.cpSync(backupHustlerDir, hustlerDir, { recursive: true });
  if (fs.existsSync(backupConfigPath)) fs.copyFileSync(backupConfigPath, configPath);
}

function writeMockCli(logPath) {
  const cliPath = path.join(tempRoot, 'mock-claude');
  fs.writeFileSync(cliPath, `#!/usr/bin/env bash
set -euo pipefail
prompt=""
system=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p)
      prompt="\${2-}"
      shift 2
      ;;
    --system-prompt)
      system="\${2-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
kind="draft"
if [[ "$system" == *"審査担当"* ]]; then
  kind="review"
fi
if [[ -n "${logPath}" ]]; then
  printf '{"kind":"%s"}\\n' "$kind" >> "${logPath}"
fi
sleep_ms="\${MOCK_DRAFT_SLEEP_MS:-0}"
if [[ "$kind" == "review" ]]; then
  sleep_ms="\${MOCK_REVIEW_SLEEP_MS:-0}"
fi
python3 - <<'PY' "$sleep_ms"
import sys, time
ms = float(sys.argv[1]) if len(sys.argv) > 1 else 0
if ms > 0:
    time.sleep(ms / 1000.0)
PY
if [[ "$kind" == "review" ]]; then
  cat <<'EOF'
{"result":"{\\"score\\":88,\\"verdict\\":\\"pass\\",\\"strengths\\":[\\"具体性がある\\",\\"構成が自然\\"],\\"issues\\":[],\\"fixInstructions\\":\\"このままで問題ありません。\\"}"}
EOF
else
  cat <<'EOF'
{"result":"# タイトル案\\n- モックCLIで商人パイプラインを安定化する\\n\\n# 見出し構成\\n- H2: 背景\\n- H2: 実装\\n\\n# 本文\\nモックCLIを使って、商人パイプラインのタイムアウトと再開動作を検証します。\\n\\n## 背景\\n生成と評価の所要時間が異なるため、タイムアウトは用途ごとに切り分ける必要があります。\\n\\n## 実装\\n保存済みドラフトを使って評価から再開できると、失敗時のやり直しを最小化できます。\\n\\n## まとめ\\n生成済みドラフトを再利用すると、夜間バッチの再試行コストを抑えられます。\\n\\n<!-- HUSTLER_META {\\"title\\":\\"モックCLIで商人パイプラインを安定化する\\",\\"emoji\\":\\"🧪\\",\\"topics\\":[\\"hustler\\",\\"retry\\"]} -->"}
EOF
fi
`, { mode: 0o755 });
  return cliPath;
}

function resetHustlerStorage(app) {
  fs.rmSync(hustlerDir, { recursive: true, force: true });
  app.saveHustlerJobs([]);
  app.saveHustlerRevenue([]);
  fs.mkdirSync(outputsDir, { recursive: true });
}

function loadMockLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function main() {
  backupWorkspace();
  const logPath = path.join(tempRoot, 'mock-claude.log');
  const cliPath = writeMockCli(logPath);

  process.env.CLAUDE_CLI_PATH = cliPath;
  process.env.SECRETARY_PROVIDER = 'cli';
  process.env.HUSTLER_PROVIDER = 'cli';
  process.env.MOCK_CLAUDE_LOG = logPath;
  process.env.MOCK_DRAFT_SLEEP_MS = '0';
  process.env.MOCK_REVIEW_SLEEP_MS = '3000';

  const app = require(path.join(repoRoot, 'server.js'));
  resetHustlerStorage(app);

  const baseConfig = {
    enabled: false,
    activeHours: '22-8',
    idleMinutes: 15,
    tokenBudget5h: 2000000,
    maxRunsPerDay: 8,
    qualityThreshold: 75,
    maxRevisions: 2,
    autoFromExplorer: true,
    cliTimeoutSec: 2,
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
  app.saveHustlerConfig(baseConfig);

  const queued = app.enqueueHustlerJob({
    type: 'article_draft',
    topic: 'モックCLIで商人パイプラインを検証する',
    publishTarget: 'zenn',
  }).job;

  let timeoutError = null;
  try {
    await app.executeHustlerJob(queued.id);
  } catch (e) {
    timeoutError = e;
  }
  assert(timeoutError, '最初の実行はタイムアウトする想定です');
  assert(String(timeoutError.message).includes('タイムアウト(2秒)'), `想定外のエラー: ${timeoutError.message}`);

  const failedJob = app.loadHustlerJobs().find((job) => job.id === queued.id);
  assert(failedJob && failedJob.status === 'error', '失敗後に job が error になっていません');
  assert(failedJob.outputId, '失敗後のドラフト成果物が保存されていません');
  const failedOutput = app.readHustlerOutputRecord(failedJob.outputId);
  assert(failedOutput && failedOutput.state === 'error', '失敗後の成果物 state が error ではありません');
  assert(failedOutput.body.includes('モックCLIを使って'), '保存済みドラフト本文を確認できません');

  const firstLog = loadMockLog(logPath);
  assert.equal(firstLog.filter((entry) => entry.kind === 'draft').length, 1);
  assert.equal(firstLog.filter((entry) => entry.kind === 'review').length, 1);

  const retried = app.retryHustlerOutput(failedOutput.id);
  assert.equal(retried.job.status, 'pending');
  assert.equal(retried.job.resumeFromDraft, true);
  assert.equal(retried.job.retryCount, 1);
  assert.equal(retried.output.state, 'pending');

  const autoQueued = app.enqueueHustlerJob({
    type: 'article_draft',
    topic: '自動リトライの pending 戻し確認',
    publishTarget: 'zenn',
  }).job;
  app.saveHustlerJobs(app.loadHustlerJobs().map((job) => (
    job.id === autoQueued.id
      ? { ...job, status: 'error', error: 'simulate', outputId: null, retryCount: 0 }
      : job
  )));
  const changed = app._test.queueRetryableHustlerErrors('verify');
  assert.equal(changed, true);
  const autoRetried = app.loadHustlerJobs().find((job) => job.id === autoQueued.id);
  assert.equal(autoRetried.status, 'pending');
  assert.equal(autoRetried.retryCount, 1);
  assert.equal(autoRetried.resumeFromDraft, false);

  process.env.MOCK_REVIEW_SLEEP_MS = '0';
  app.saveHustlerConfig({ ...baseConfig, cliTimeoutSec: 5 });
  const approved = await app.executeHustlerJob(retried.job.id);
  assert.equal(approved.status, 'approved');

  const finalJob = app.loadHustlerJobs().find((job) => job.id === retried.job.id);
  const finalOutput = app.readHustlerOutputRecord(finalJob.outputId);
  assert(finalOutput && finalOutput.state === 'approved', '再開後に成果物が approved になっていません');
  assert.equal(finalOutput.score, 88);

  const finalLog = loadMockLog(logPath);
  assert.equal(finalLog.filter((entry) => entry.kind === 'draft').length, 1, '再開時にドラフト生成が再実行されています');
  assert.equal(finalLog.filter((entry) => entry.kind === 'review').length, 2, '評価再開回数が想定と異なります');

  console.log('verify-hustler-retry: OK');
  console.log(`timeout_error=${timeoutError.message}`);
  console.log(`resume_output=${failedOutput.id} retry_count=${retried.job.retryCount} final_status=${finalJob.status} final_score=${finalOutput.score}`);
  console.log(`mock_cli_calls draft=${finalLog.filter((entry) => entry.kind === 'draft').length} review=${finalLog.filter((entry) => entry.kind === 'review').length}`);
  console.log(`auto_retry_job=${autoRetried.id} status=${autoRetried.status} retry_count=${autoRetried.retryCount}`);
}

main()
  .catch((error) => {
    console.error('verify-hustler-retry: FAILED');
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreWorkspace();
  });
