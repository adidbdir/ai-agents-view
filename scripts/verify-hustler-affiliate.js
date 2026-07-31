#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const configPath = path.join(repoRoot, 'hustler-config.json');
const dataDir = path.join(repoRoot, 'data');
const hustlerDir = path.join(dataDir, 'hustler');
const outputsDir = path.join(hustlerDir, 'outputs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-agents-view-verify-'));
const backupDir = path.join(tempRoot, 'backup');
const configBackupPath = path.join(backupDir, 'hustler-config.json');
const dataBackupPath = path.join(backupDir, 'data');
let restored = false;
const originalFetch = global.fetch;

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function backupWorkspace() {
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(configPath)) fs.copyFileSync(configPath, configBackupPath);
  if (fs.existsSync(dataDir)) fs.cpSync(dataDir, dataBackupPath, { recursive: true });
}

function restoreWorkspace() {
  if (restored) return;
  restored = true;
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (fs.existsSync(dataBackupPath)) fs.cpSync(dataBackupPath, dataDir, { recursive: true });
  if (fs.existsSync(configBackupPath)) fs.copyFileSync(configBackupPath, configPath);
  global.fetch = originalFetch;
}

function installMockFetch() {
  global.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    const prompt = body.messages && body.messages[0] ? String(body.messages[0].content || '') : '';
    const system = String(body.system || '');
    let result = '';
    if (system.includes('審査担当')) {
      const isAffiliate = /ジョブ種別:\\s*affiliate_article/.test(prompt);
      result = JSON.stringify({
        score: isAffiliate ? 92 : 89,
        verdict: 'pass',
        strengths: isAffiliate
          ? ['読者課題から書けている', '比較軸が明確']
          : ['構成が整理されている', '実務価値がある'],
        issues: [],
        fixInstructions: isAffiliate ? '比較の具体例を少し補強してください。' : '具体例を維持してください。',
      });
    } else if (prompt.includes('Zenn / 技術ブログ向け')) {
      result = [
        '# タイトル案',
        '- Claude CLIの遊休時間活用術',
        '',
        '# 見出し構成',
        '- H2: 背景',
        '- H2: 実装',
        '',
        '# 本文',
        'Claude CLI の遊休時間を活用して、記事生成パイプラインを安定運用する方法をまとめます。',
        '',
        '## 背景',
        'ローカル環境で自動実行するときは、トークン予算と公開経路を分けて考えるのが重要です。',
        '',
        '## 実装',
        'ジョブの審査と公開を分離すると、失敗時の切り戻しが簡単になります。',
        '',
        '## まとめ',
        '小さく始めて、承認済みの成果物だけを公開する設計が安全です。',
        '',
        '<!-- HUSTLER_META {"title":"Claude CLIの遊休時間活用術","emoji":"📝","topics":["claude-cli","automation"]} -->',
      ].join('\\n');
    } else if (prompt.includes('読者の課題解決を最優先にした、日本語の比較 / レビュー記事')) {
      result = [
        '※本記事にはアフィリエイトリンクが含まれます。',
        '',
        '# 初心者向けVPS比較',
        '',
        '個人開発や検証用途で最初の VPS を選ぶときは、価格だけでなく初期設定のしやすさとスケールのしやすさが重要です。',
        '',
        '## 比較ポイント',
        '- すぐ始めたいなら {{aff:ConoHa VPS}}',
        '- 柔軟性を重視するなら {{aff:Vultr}}',
        '',
        '## まとめ',
        '短時間で始めるなら {{aff:ConoHa VPS}}、構成を細かく選ぶなら {{aff:Vultr}} が有力です。',
      ].join('\\n');
    } else if (prompt.includes('次のアフィリエイト記事ドラフトを、日本語の比較 / レビュー記事として全面的に書き直してください。')) {
      result = [
        '※本記事にはアフィリエイトリンクが含まれます。',
        '',
        '# 初心者向けVPS比較 改訂版',
        '',
        'VPS を初めて選ぶ読者向けに、費用、初期設定、拡張性の3点で比較します。',
        '',
        '## 候補ごとのレビュー',
        'セットアップの速さを優先するなら {{aff:ConoHa VPS}}、細かい構成調整をしたいなら {{aff:Vultr}} が候補になります。',
      ].join('\\n');
    } else {
      result = '汎用のモック応答です。';
    }
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: result }],
      }),
    };
  };
}

function initRepo(name, trackedDir) {
  const root = path.join(tempRoot, name);
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(root, { recursive: true });
  run('git', ['init', '--bare', remote]);
  fs.mkdirSync(work, { recursive: true });
  run('git', ['init'], { cwd: work });
  run('git', ['-C', work, 'config', 'user.name', 'Verifier']);
  run('git', ['-C', work, 'config', 'user.email', 'verifier@example.com']);
  run('git', ['-C', work, 'checkout', '-b', 'main']);
  fs.mkdirSync(path.join(work, trackedDir), { recursive: true });
  fs.writeFileSync(path.join(work, trackedDir, '.gitkeep'), '\n');
  fs.writeFileSync(path.join(work, 'README.md'), `# ${name}\n`);
  run('git', ['-C', work, 'add', '.']);
  run('git', ['-C', work, 'commit', '-m', 'Initial commit']);
  run('git', ['-C', work, 'remote', 'add', 'origin', remote]);
  run('git', ['-C', work, 'push', '-u', 'origin', 'main']);
  return { remote, work };
}

function resetHustlerStorage(app) {
  fs.rmSync(hustlerDir, { recursive: true, force: true });
  app.saveHustlerJobs([]);
  app.saveHustlerRevenue([]);
  fs.mkdirSync(outputsDir, { recursive: true });
}

async function main() {
  backupWorkspace();
  installMockFetch();
  process.env.ANTHROPIC_API_KEY = 'dummy-key';
  process.env.SECRETARY_PROVIDER = 'api';
  process.env.HUSTLER_PROVIDER = 'api';

  const app = require(path.join(repoRoot, 'server.js'));
  resetHustlerStorage(app);

  const hugoRepo = initRepo('hugo', 'content/posts');
  const zennRepo = initRepo('zenn', 'articles');

  const config = app.saveHustlerConfig({
    enabled: false,
    activeHours: '22-8',
    idleMinutes: 15,
    tokenBudget5h: 2000000,
    maxRunsPerDay: 8,
    qualityThreshold: 75,
    maxRevisions: 2,
    autoFromExplorer: true,
    publish: {
      enabled: false,
      mode: 'generic-git',
      repoPath: zennRepo.work,
      genericRepoPath: hugoRepo.work,
      genericDir: 'content/posts',
      genericFrontmatter: 'hugo',
      articleType: 'tech',
      price: 0,
      topics: ['ai-agents'],
      publishedFlag: true,
    },
    affiliate: {
      enabled: true,
      disclosure: '※本記事にはアフィリエイトリンクが含まれます。',
      links: [
        { label: 'ConoHa VPS', url: 'https://example.com/conoha?aff=abc123', note: '国内向けで初期設定が簡単' },
        { label: 'Vultr', url: 'https://example.com/vultr?aff=xyz789', note: '構成の柔軟性が高い' },
      ],
    },
  });

  const hugoBefore = Number(run('git', ['-C', hugoRepo.work, 'rev-list', '--count', 'HEAD']));
  const affQueued = app.enqueueHustlerJob({
    type: 'affiliate_article',
    topic: '初心者向けVPS比較',
    publishTarget: 'generic',
    affiliateLinkLabels: ['ConoHa VPS', 'Vultr'],
  }).job;
  const affJob = await app.executeHustlerJob(affQueued.id);
  assert(affJob.status === 'approved', `affiliate_article が approved になっていません: ${affJob.status}`);
  const affOutput = app.readHustlerOutputRecord(affJob.outputId);
  assert(affOutput, 'affiliate_article の成果物を読み込めません');
  assert(affOutput.rawBody.startsWith(config.affiliate.disclosure), 'affiliate disclosure が先頭にありません');
  assert(affOutput.rawBody.includes('https://example.com/conoha?aff=abc123'), 'ConoHa の実URL置換に失敗しました');
  assert(affOutput.rawBody.includes('https://example.com/vultr?aff=xyz789'), 'Vultr の実URL置換に失敗しました');
  assert(!affOutput.rawBody.includes('{{aff:'), 'affiliate プレースホルダが保存後も残っています');
  assert(affOutput.state === 'approved', `affiliate output の state が approved ではありません: ${affOutput.state}`);

  const affPublished = await app.publishHustlerOutput(affOutput.id, { manual: true });
  const hugoAfter = Number(run('git', ['-C', hugoRepo.work, 'rev-list', '--count', 'HEAD']));
  const hugoFile = path.join(hugoRepo.work, 'content/posts', `${affPublished.slug}.md`);
  const hugoContent = fs.readFileSync(hugoFile, 'utf8');
  assert(hugoAfter === hugoBefore + 1, `Hugo リポジトリの commit 数が増えていません: ${hugoBefore} -> ${hugoAfter}`);
  assert(hugoContent.includes('draft: false'), 'Hugo frontmatter が生成されていません');
  assert(hugoContent.includes(config.affiliate.disclosure), '公開ファイルに disclosure がありません');
  assert(hugoContent.includes('https://example.com/conoha?aff=abc123'), '公開ファイルに実URLがありません');

  const jekyllPreview = app._test.buildGenericArticleContent(affOutput, {
    genericFrontmatter: 'jekyll',
  }, 'jekyll-preview');
  assert(jekyllPreview.content.includes('layout: post'), 'jekyll frontmatter が生成されていません');

  const zennBefore = Number(run('git', ['-C', zennRepo.work, 'rev-list', '--count', 'HEAD']));
  const articleQueued = app.enqueueHustlerJob({
    type: 'article_draft',
    topic: 'Claude CLIの遊休時間活用術',
    publishTarget: 'zenn',
  }).job;
  const articleJob = await app.executeHustlerJob(articleQueued.id);
  assert(articleJob.status === 'approved', `article_draft が approved になっていません: ${articleJob.status}`);
  const articleOutput = app.readHustlerOutputRecord(articleJob.outputId);
  assert(articleOutput, 'article_draft の成果物を読み込めません');
  const zennPublished = await app.publishHustlerOutput(articleOutput.id, { manual: true });
  const zennAfter = Number(run('git', ['-C', zennRepo.work, 'rev-list', '--count', 'HEAD']));
  const zennFile = path.join(zennRepo.work, 'articles', `${zennPublished.slug}.md`);
  const zennContent = fs.readFileSync(zennFile, 'utf8');
  assert(zennAfter === zennBefore + 1, `Zenn リポジトリの commit 数が増えていません: ${zennBefore} -> ${zennAfter}`);
  assert(zennContent.includes('title:'), 'Zenn frontmatter の title がありません');
  assert(zennContent.includes('emoji:'), 'Zenn frontmatter の emoji がありません');
  assert(zennContent.includes('published: true'), 'Zenn frontmatter の published がありません');

  console.log('[PASS] affiliate_article approved -> generic-git publish');
  console.log(`  outputId=${affOutput.id} slug=${affPublished.slug} hugoCommits=${hugoBefore}->${hugoAfter}`);
  console.log(`  disclosure=${config.affiliate.disclosure}`);
  console.log(`  genericFile=${hugoFile}`);
  console.log('[PASS] generic-git frontmatter variants');
  console.log('  hugo=draft:false tags / jekyll=layout:post title date tags');
  console.log('[PASS] article_draft approved -> zenn-git publish');
  console.log(`  outputId=${articleOutput.id} slug=${zennPublished.slug} zennCommits=${zennBefore}->${zennAfter}`);
  console.log(`  zennFile=${zennFile}`);
}

main()
  .catch((error) => {
    console.error('[FAIL]', error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    restoreWorkspace();
  });
