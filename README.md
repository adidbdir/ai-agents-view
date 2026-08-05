# AI Agents View

Claude Code / AI エージェントのセッションを、アイソメトリックなビジネス・インフォグラフィック風に可視化するローカルダッシュボードです。
[claude-code-park](https://github.com/t-soda/claude-code-park) と同じく `~/.claude/projects/` 配下のセッションログ (JSONL) を読み取りますが、ピクセルアートではなく俯瞰型のダイアグラム表示にしています。

## 特徴

- **アイソメトリック・オフィス** — プロジェクトごとにデスク+モニター+猫を配置したオフィスフロア
  - 稼働中(3分以内): 猫が着席して作業中(前足をキーボードに乗せて画面がシアンに発光・パルスリング)
  - 直近1時間: デスク横で猫が待機
  - 待機中: 空席・暗いモニター
  - 床を **💻 ワークスペース(対話ゾーン)** と **⚙️ 自動化エリア(自動ゾーン)** に分割。`/tmp` 起点や「長文1発プロンプト」のセッションは自動側に寄せ、対話セッションはワークスペース側に配置
  - 中央に緑のラグと猫用クッションベッド、ホワイトボードでのプレゼン猫、サーバーラック(`~/.claude/projects` の象徴)、コーヒーコーナーのフードボウル、観葉植物そばのキャットタワーなどのオフィス小物
  - ambient 猫がフロアを自由に徘徊し、ときどき昼寝や毛づくろいをする
  - **時間帯で変わる外の空** — 現在時刻に連動してオフィスの外の背景が早朝〜日中〜夕暮れ〜深夜へと滑らかに遷移。太陽/月が空を横断し、夜は星が瞬く(右上に「🌙 深夜・21:27」のような時間帯ピルを表示)
- **サブエージェントの可視化** — セッションが複数エージェント(Agent ツール / サブエージェント)を並列実行すると、その数だけデスクに猫が集まる(最大4匹表示、ネームプレートに 🤖×n)。エージェントの実行が終わると猫も帰る
- **リアルタイム更新** — 3秒ごとにポーリングし、状態変化が即座に反映(データ変化時のみ再描画)
- **接続アニメーション** — 中央テーブルと各デスクを流れるドットラインで接続
- **詳細パネル** — デスクをクリックすると表示
  - **tmux 返信** — 同じマシンでそのプロジェクトを開いている tmux ペインを見つけ、詳細パネルからテキストや承認キー(`Enter` / `y` / `n` など)を送信可能。スマホから Tailscale 越しに承認待ちセッションへ返答する用途を想定
  - 直近30日の実行タイムライン(定期実行の頻度を棒グラフ+セッション開始マーカーで把握)
  - セッション一覧: AIタイトル / モデル / ブランチ / メッセージ数 / トークン数 / ツール実行内訳
- **今日の予定 / タスク管理(任意)** — Google カレンダーと Google ToDo (Tasks) に連携
  - 左上「📅 今日の予定」パネルに、今日のスケジュールのまとめ(進行中・次の予定・残タスク数)と予定一覧を表示
  - Google ToDo のタスクをチェックで完了/未完了に切替、その場で追加(期日=今日)も可能
- **秘書アシスタント(任意)** — オフィス手前の「秘書」デスクをクリックするとチャットが開く
  - 今日の予定・タスクを把握したうえで、やるべきこと・締め切り・各予定に向けた準備を相談できる
  - Anthropic API キーを設定すると自由に会話でき、未設定でも今日の情報の定型ブリーフィングを返す
- **探検家 — トピック調査(任意)** — オフィス右手前の「探検家」(⛺🧭)をクリックすると調査パネルが開く
  - 指定トピックのニュース・論文を Web 検索で調べ、**🔥 hot なトピック / 📄 注目の論文(arXiv 等・リンク付き) / 🌊 分野の潮流** にまとめて表示
  - トピックを入力してその場で調査でき、保存したトピックは**毎週月曜の朝9時**に自動で最新化(サーバー起動中のみ)
  - 実行手段は秘書と同じ(Claude CLI のサブスク枠 / Anthropic API)。新着レポートがあるとキャラに「!」バッジ
- **鑑定士(任意)** — 自動化エリアの「鑑定士」(🧐)をクリックすると、X のいいね/ブックマークや手動共有 URL を夜間の遊休時間に深掘り検証するパネルが開く
  - `POST /api/appraiser/inbox` または `GET /appraiser/add?url=...` で URL を受信箱へ積み、X ポスト URL は `publish.twitter.com/oembed` で本文取得を試す(失敗しても URL のみで継続)
  - `appraiser-config.json` に `xApi` を設定すると `GET https://api.x.com/2/users/{id}/bookmarks` / `liked_tweets` を差分ポーリングし、分類 → 調査 → レポート生成まで自動実行
  - GitHub / arXiv / 一般記事の本文を拾って `data/appraiser/reports/*.md` に Markdown レポートを保存し、高評価の `money` 判定は商人の `idea_research` に自動連携
- **商人・内職(任意)** — オフィス右手前の「商人・内職」(💰)をクリックすると、遊休時間に回す収益化ジョブの管理パネルが開く
  - Claude Code の**直近5時間トークン使用量**と**直近の遊休時間**を見て、サブスク枠の余りを使える時だけ最古の待機ジョブを自動実行
  - ジョブ種別は **記事ドラフト / SNS導線 / 収益化ネタ調査 / 自由プロンプト**。成果物は Markdown で `data/hustler/outputs/` に保存され、新着があるとキャラに「!」バッジ
  - 収益記録(日付・金額・メモ)も同じパネルで管理でき、月次合計を簡易グラフで確認できる
- **動画職人(任意)** — 自動化エリアの「動画職人」(🎬)をクリックすると、ローカル MiniMax H3 でショート動画を作る制作パネルが開く
  - Claude CLI / Anthropic API で **タイトル / 概要欄 / 3シーン前後のJSON台本**を生成し、ComfyUI 上の **MiniMax H3** へ直列投入
  - 各シーンは **H3 ネイティブ音声 + 日本語字幕焼き込み**で生成し、`ffmpeg` の concat demuxer で `data/creator/videos/*.mp4` に連結保存
  - 探検家の新着レポートを topic キューへ自動投入でき、審査(score)合格時だけ YouTube Data API へ自動投稿(未取得スコープ時は再認証を案内)
  - 参照画像 `assets/h3/character_ref.png` があれば **ref2va** に切り替えてキャラ固定、無ければ t2va/fl2va で生成
- **トレーダー猫(任意 / ペーパートレード専用)** — オフィス左手前の「トレーダー・相場」(📈)をクリックすると、暗号資産の**ペーパートレード(仮想資金)**パネルが開く
  - 実売買は行わず、CoinGecko の無料 API で取得した価格を `data/trader/prices.jsonl` に保存し、SMA / RSI / 24h・7d 変化率を表示
  - 分析は Claude CLI 優先(未設定なら Anthropic API)で、商人と同じ**遊休判定 / 直近5時間トークン予算**を尊重して 1 日 1 回だけ実行
  - シグナルは **buy / sell / hold** の仮想約定として `data/trader/portfolio.json` に保存し、総資産・損益・equity カーブ・取引履歴を同じパネルで確認できる
- **セッション一覧ページ** (`/sessions`) — 過去・実行中のセッションをタイムチャートとリストでまとめて確認
  - 右上「📊 セッション一覧」から開く。実行中セッションを上部に強調表示
  - ガントチャート(開始〜最終時刻をステータス色の帯で表示)/ リスト の2ビュー、期間・並び替え・検索・プロジェクトまとめ・実行中のみ で絞り込み
  - 行をクリックすると、最初のプロンプト・モデル・トークン内訳・ツール実行内訳・サブエージェントを展開表示
- **完全ローカル** — 依存パッケージなし(Node.js 標準ライブラリのみ)。外部通信は opt-in の Google API / CoinGecko API / X API / `publish.twitter.com` / GitHub API / Anthropic API のみ

## 使い方

```bash
node server.js
# → http://localhost:4370 をブラウザで開く
```

ポートを変えたい場合:

```bash
PORT=8080 node server.js
```

## tmux 返信機能

デスク詳細パネルの「⌨️ ターミナルに返信」から、**同じマシン上の tmux ペイン**へ入力を送れます。

- 対象ペインは `tmux list-panes -a` で列挙し、Claude Code セッションログの `cwd` と `pane_current_path` が一致するものだけを候補にします
- `claude` / `node` を実行中のペインを優先し、複数候補がある場合は直近活動したウィンドウを既定選択します
- テキスト送信は `send-keys -l` でリテラル入力し、その後に `Enter` を送ります
- クイックキーは `Enter`, `y`, `n`, `Esc`, `Up`, `Down`, `1`, `2`, `3`, `Tab`, `Ctrl+C` の固定リストだけを許可します

必要条件:

- このサーバーと tmux が**同じホスト**で動いていること
- 返信したいプロジェクトを tmux ペイン側でもそのプロジェクトのパスで開いていること

注意:

- `ai-agents-view` を `0.0.0.0` で待ち受けし、Tailscale や LAN 越しに公開している場合、**その URL に到達できるピアは誰でも tmux ペインへキー送信できます**
- 認証は別途入っていないため、信頼できるピアだけに公開してください。必要なら Tailscale ACL / Funnel 無効化 / リバースプロキシの認証などで保護してください

## ゾーン分け / 手動切替

- 各プロジェクトには `zone: "interactive" | "auto"` が付き、床上で **💻 ワークスペース** か **⚙️ 自動化エリア** に配置されます。
- 自動判定は次の順です。
  - `cwd` が `os.tmpdir()` 配下なら `auto`
  - 実際のユーザープロンプトが 1 件だけで、その最初のプロンプトが長文(220文字以上)なら `auto`
  - それ以外は `interactive`
- プロジェクト全体のゾーンは、所属セッションの多数決で決め、同数なら最新セッションを優先します。
- デスク詳細パネルの「自動エリアへ移動 / 対話エリアへ移動」で手動上書きできます。上書き内容はリポジトリ直下の `zone-overrides.json` に保存され、`.gitignore` 済みです。
- 現在の上書き一覧は `GET /api/zones`、保存は `POST /api/zones` (`{ "projectName": "...", "zone": "auto" }`) で扱えます。

## 複数PCのセッションをまとめて表示する

Claude Code のセッションログは各マシンのローカル (`~/.claude/projects`) にのみ保存され、
Claude アカウント経由で他マシンのログを取得する API はありません。
代わりに、**各PCでこのアプリを起動してネットワーク越しに集約**できます。

1. 各PCにこのリポジトリを置き、`node server.js` を起動(ポート 4370 で全インターフェース待受)
2. メインのPCで、他のPCの URL をピアとして登録:
   ```bash
   # 環境変数で指定
   PEERS="http://other-pc.local:4370,mac-mini=http://100.64.0.12:4370" node server.js
   ```
   または `peers.json` を作成([peers.json.example](peers.json.example) 参照):
   ```json
   { "peers": ["mac-mini=http://100.64.0.12:4370"] }
   ```
   `ラベル=URL` 形式にすると表示上のホスト名を上書きできます。
3. メインPCのダッシュボードに全ホストのデスクが並びます
   - リモートのデスクはネームプレートに `@ホスト名` が付き、ヘッダーに「ホスト」統計が追加されます
   - ピアに接続できないときは右下に ⚠ 表示されます(ローカル分は表示継続)

tmux 返信は**各ホストのローカル tmux**だけを操作します。集約先ダッシュボードからリモートホストの tmux を直接操作する機能はありません。

別ネットワークのPCは [Tailscale](https://tailscale.com/) などの VPN を使うと簡単です。
ピアの表示名は各PC側で `HOST_LABEL=my-mac node server.js` としても変更できます。
5台以上のデスクは自動的にグリッドレイアウトに切り替わり、数に応じてデスクが縮小されます。
左下の「表示期間」フィルタ(24時間 / 7日 / 30日 / すべて、既定30日)で古いプロジェクトを非表示にできます。

> 補足: ネットワーク集約を使わない代替として、他マシンの `~/.claude/projects` を
> Syncthing / iCloud Drive 等で同期し、同期先を読む方法もあります(リアルタイム性は落ちます)。

## Google カレンダー / ToDo 連携(任意)

左上の「📅 今日の予定」から、Google カレンダーの今日のスケジュールと Google ToDo のタスクを表示・管理できます。
利用には自分の Google Cloud プロジェクトで OAuth クライアントを一度だけ作成します(無料・約5分):

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) でプロジェクトを作成
2. 「APIとサービス → ライブラリ」で **Google Calendar API** と **Google Tasks API** を有効化
3. 「認証情報 → 認証情報を作成 → OAuth クライアント ID」で種類 **デスクトップアプリ** を選択して作成
   - 初回は「OAuth 同意画面」の設定を求められます。User Type は **外部** でよく、テストユーザーに自分の Gmail アドレスを追加してください
4. JSON をダウンロードし、このリポジトリ直下に `google-credentials.json` として保存
   (環境変数 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` でも指定可)
5. ダッシュボード左上「📅 今日の予定」→「Google と連携する」→ ブラウザで許可

- スコープは `calendar.readonly`(予定は読み取りのみ)と `tasks`(タスクの完了切替・追加のため読み書き)です
- 動画職人の YouTube 投稿を使う場合は、同じ OAuth 連携で `youtube.upload` スコープも一緒に取得します。既存トークンにこのスコープが無い場合、投稿時に「再認証が必要です(⚙️→Googleと連携)」と表示されます
- トークンは `google-token.json` としてローカルにのみ保存されます(`google-credentials.json` と共に gitignore 済み)
- 連携の許可操作は、サーバーが動いている PC のブラウザ(`http://localhost:4370`)から行ってください(OAuth のリダイレクト先が localhost のため)
- 連携を解除するには `google-token.json` を削除してください

| API | 用途 |
|---|---|
| Calendar API (`calendars/primary/events`) | 今日 0:00〜24:00 の予定(読み取りのみ) |
| Tasks API (`users/@me/lists`, `lists/{id}/tasks`) | タスク一覧・完了切替・追加(未完了 + 今日完了分を表示) |
| YouTube Data API (`videos.insert`) | 動画職人の mp4 を resumable upload で投稿 |

## 秘書アシスタント(任意)

オフィス手前の「秘書アシスタント」デスク(💬)をクリックするとチャットパネルが開き、
今日の予定・タスクを踏まえて「今やるべきこと」「予定に向けた準備」などを相談できます。

動作モードは自動で選ばれます(`configured` の順に優先):

| モード | 条件 | 課金 |
|---|---|---|
| **cli** | この PC に Claude Code CLI があり、API キーが未設定 | **追加課金なし**(Claude Code のサブスク利用枠を消費) |
| **api** | `ANTHROPIC_API_KEY` か `anthropic-credentials.json` を設定 | Anthropic API の従量課金 |
| **off** | どちらも無い | 無料(定型ブリーフィングのみ) |

**A) Claude Code のサブスクで会話する(追加課金なし)**
サーバーを、Claude Code に**ログイン済みの端末**から起動するだけです:
```bash
node server.js   # claude コマンドをヘッドレス実行し、サブスクのログインを使う
```
- Claude Code の CLI (`claude`) がインストール済み・ログイン済みであることが前提です(未ログインなら一度 `claude` を起動して `/login`)。
- 初回は macOS がキーチェーンへのアクセス許可を一度尋ねる場合があります。
- サブスクの利用上限(Pro/Max のレート制限)を消費します。1リクエストごとに `claude` を起動するため API より数秒遅くなります。
- `claude` のパスを明示するには `CLAUDE_CLI_PATH=/path/to/claude`。

**B) Anthropic API キーで会話する(従量課金)**
```bash
ANTHROPIC_API_KEY=sk-ant-... node server.js        # モデル変更は SECRETARY_MODEL=...
```
またはリポジトリ直下に `anthropic-credentials.json`:
```json
{ "apiKey": "sk-ant-...", "model": "claude-haiku-4-5-20251001" }
```

**C) 未設定(無料)** — 今日の予定・タスクを整理した定型ブリーフィング(次の予定・やるべきタスク・期限切れ警告・準備アドバイス)を返します。

- モードを固定したいときは `SECRETARY_PROVIDER=cli|api|auto|off`(既定 `auto`)。
- 予定・タスクの文脈は上記 Google 連携から取得します(未連携なら一般的な相談のみ)。
- **今日だけでなく過去〜先の予定も相談できます**(「明日の予定は?」「先週の会議は?」など)。既定は過去7日〜先14日。範囲は `SECRETARY_CAL_PAST_DAYS` / `SECRETARY_CAL_FUTURE_DAYS` で変更できます(例: `SECRETARY_CAL_FUTURE_DAYS=30`)。左上「今日の予定」パネルは今日のみの表示です。
- **過去に完了した ToDo タスクも文脈に含みます**(既定 過去14日 / `SECRETARY_TASK_DONE_DAYS` で変更可)。完了日ごとに整理して渡すので、週末に「今週やった作業を週報にまとめて」と頼めば、完了タスクと予定を踏まえた週次レポートを作成できます。左上「今日の予定」パネルは従来どおり今日完了分のみ表示します。
- **Claude Code のセッション作業ログも文脈に含みます**(既定 過去30日 / `SECRETARY_SESSION_DAYS` で変更可)。`~/.claude/projects` の全プロジェクトのセッションから、作業日ごとに「セッションタイトル・プロジェクト名・依頼件数・稼働時間帯」を抽出して渡すので、週報や月次の振り返りで「どの案件にいつ取り組んだか」を完了タスク・予定と突き合わせられます。件数が多い場合は新しい順に最大 `SECRETARY_SESSION_MAX` 件(既定200)まで渡し、超過分は件数のみ通知します。一時セッション(`-private*`)は対象外。`SECRETARY_INCLUDE_SESSIONS=0` で無効化できます。プロンプト本文は渡さず、タイトルと件数のみを使います。
- 既定モデルは `claude-haiku-4-5-20251001`。応答は毎回、その時点の予定・タスクを文脈として送ります。
- API キーはこの PC 内でのみ使用し、Anthropic 以外へは送信しません(`anthropic-credentials.json` は gitignore 済み)。

## 探検家 — トピック調査(任意)

オフィス右手前の「探検家」(⛺🧭)をクリックすると調査パネルが開きます。トピックを入力して「🔍 調査」を押すと、
探検家が **Web 検索**でニュースと論文を調べ、次の3セクションにまとめて表示します
(**カンマ区切りで複数トピックを一度に追加**でき、順番に調査されます):

- **🔥 hot なトピック** — いま盛り上がっている話題・ニュース
- **📄 注目の論文** — arXiv などの新着・話題の論文(リンク付き)
- **🌊 分野の潮流** — その分野で進んでいる大きな流れ・トレンド

動作モードは秘書アシスタントと同じ設定を流用します(`cli` 優先 → `api` → 未設定なら無効):

| モード | 条件 | 課金 |
|---|---|---|
| **cli** | Claude Code CLI があり API キー未設定 | **追加課金なし**(サブスク利用枠を消費。Web 検索を有効化して実行) |
| **api** | `ANTHROPIC_API_KEY` か `anthropic-credentials.json` を設定 | Anthropic API の従量課金(`web_search` ツール利用分を含む) |
| **off** | どちらも無い | 調査不可(パネルに設定を促すメッセージ) |

- **週に一度の自動調査** — 保存したトピックは**毎週月曜の朝9時**に自動で最新化されます(サーバー起動中のみ動作)。
  新着レポートがあると探検家キャラに「!」バッジが付きます。
- モード/モデルを探検家だけ変えたいときは `EXPLORER_PROVIDER=cli|api|auto|off` / `EXPLORER_MODEL=...`(未指定なら秘書設定を流用)。
- 調査結果と保存トピックは `explorer-state.json` にローカル保存されます(gitignore 済み)。
- 週次の自動調査は CLI のサブスク枠(または API の従量課金)を消費します。不要なら未設定(off)にするか、トピックを保存しないでください。
- 探検家・秘書アシスタントのパネルは**左端をドラッグすると幅を変更**でき、幅はブラウザに保存されます(長いレポートを読みやすく表示)。
- **オフィスビューは拡大・縮小できます** — 右下の `＋ / −` ボタン、マウスホイール(トラックパッドのピンチ)、キーボード `+` / `−` でズーム。ホイールはカーソル位置を中心に拡大します。背景をドラッグすると表示位置を移動でき、`⤢` ボタンまたは `0` キーで全体表示に戻せます。ズーム中もキャラクターのクリック操作はそのまま使えます。

## 鑑定士 — X いいね / ブックマーク検証(任意)

鑑定士は、X に溜めた「研究に使えそうな技術」「稼げそうなネタ」を、夜間の遊休時間に 1 件ずつ深掘り検証するエージェントです。

- 受信方法は 2 系統です。
  - 手動: パネルの受信箱フォーム、または `GET /appraiser/add?url=...&note=...`
  - 自動: `appraiser-config.json` の `xApi` を設定して bookmarks / likes を差分ポーリング
- 各アイテムは `pending -> classifying -> researching -> testing -> done|error` の状態で `data/appraiser/items.json` に保存されます。
- relevance 40 以上のものだけ本文取得と深掘り調査に進み、結果は `data/appraiser/reports/{id}.md` に frontmatter 付き Markdown で保存されます。
- `handsOn: true` のときだけ GitHub リポジトリを `/tmp/appraiser-lab/{id}` に shallow clone し、Claude CLI へ「README どおりに最小セットアップ + スモークテスト」を依頼します。GPU 必須・大容量ダウンロード必須なら中止理由を残します。
- `money` 判定かつ score 70 以上のレポートは、商人の `idea_research` ジョブへ自動投入します(同一レポートの重複投入は防止)。

既定設定は `appraiser-config.json` に保存されます:

```json
{
  "handsOn": false,
  "testTimeoutSec": 900,
  "interestProfile": "AI/ロボティクス研究、AIエージェントの収益化、個人開発での技術活用に関心が高い。",
  "xApi": {
    "bearerToken": "",
    "userId": "",
    "pollBookmarks": true,
    "pollLikes": false,
    "intervalHours": 6
  }
}
```

X API のセットアップ:

1. X Developer Portal で OAuth 2.0 User Context のアクセストークンを発行
2. 自分の numeric `userId` を確認
3. `appraiser-config.json` かパネル UI へ `bearerToken` / `userId` / `pollBookmarks|pollLikes` / `intervalHours` を保存
4. `pollBookmarks` か `pollLikes` を true にすると、10分ごとの定期チェック時に差分取得を試みます

注意:

- 初回ポーリングは最新20件だけを受信し、2回目以降は `data/appraiser/seen.json` を使って既知 tweet id に当たった時点でページングを止めます。
- 1回のポーリングで受け取るのは最大50件です。
- 401(トークン期限切れなど)が出た場合は `status` に表示し、設定を保存し直すまで自動再試行しません。
- X API の Owned Reads は目安として **$0.001 / 件** なので、likes まで広げる場合は件数に注意してください。

## トレーダー猫(ペーパートレード)(任意)

オフィス左手前の「トレーダー・相場」(📈)をクリックすると、暗号資産の**ペーパートレード(仮想資金)**パネルが開きます。
ここでの売買はすべて仮想約定で、**実際の取引所 API への発注は一切行いません**。

- 既定設定は `trader-config.json` に保存されます:
  ```json
  {
    "enabled": false,
    "assets": ["bitcoin", "ethereum"],
    "vsCurrency": "jpy",
    "priceIntervalMin": 15,
    "analysisHour": 7,
    "startBalance": 100000
  }
  ```
- `enabled: true` のときだけ CoinGecko の無料 API (`/api/v3/simple/price`) にアクセスし、価格履歴を `data/trader/prices.jsonl` に追記します。**opt-in** で、無効時は外部通信しません。
- 分析は 1 日 1 回(指定時刻の最初のチェック)だけ行い、プロバイダは **Claude CLI 優先 → Anthropic API** の順で選びます。
- 価格サマリと指標(SMA 24h/7d, RSI14, 24h/7d 変化率)をもとに `buy / sell / hold` の JSON シグナルを受け取り、`data/trader/portfolio.json` に仮想ポートフォリオを保存します。
- 直近5時間トークン予算と遊休判定は商人エージェントと同じロジックを再利用します。商人や探検家の実行中は分析しません。
- UI では「相場 / ポートフォリオ / 取引履歴」の 3 タブで、最新価格・損益・equity カーブ・売買根拠を確認できます。

## 動画職人(ローカル H3)(任意)

動画職人は **ComfyUI 0.30 + MiniMax H3** がローカルで動いている前提の機能です。既定設定は `creator-config.json` に保存されます。

```json
{
  "enabled": false,
  "comfyUrl": "http://127.0.0.1:8188",
  "dailyLimit": 2,
  "sceneCount": 3,
  "sceneSeconds": 5,
  "resolution": "768x1344",
  "draftResolution": "512x896",
  "qualityThreshold": 70,
  "autoFromExplorer": true,
  "publish": {
    "enabled": false,
    "privacyStatus": "public",
    "categoryId": "28",
    "disclosureText": "この動画はAIによって生成されています。"
  }
}
```

- 実行順は **台本生成 → H3 シーン生成(直列) → mp4 連結 → 審査 → YouTube 投稿** です
- H3 ワークフローは `assets/h3/` のテンプレートと `h3_submit.py` と同じノード列を使います
  - `CLIPLoader device:"cpu"`
  - `24fps`
  - `SamplerCustomAdvanced + res_multistep + simple + 20steps`
  - `VAEDecode + VAEDecodeAudio -> CreateVideo -> SaveVideo`
- 1シーンのフレーム数は **17k+5** グリッドへ自動スナップします
- `assets/h3/character_ref.png` を置くと `MiniMaxH3ReferenceToVideo(ref2va)` を使い、同じキャラを固定しやすくします
- 生成済み動画は `data/creator/videos/{id}.mp4` とメタデータ JSON に保存されます
- 投稿時は概要欄の末尾へ **AI 生成開示文言** を必ず追記します
- `containsSyntheticMedia: true` を付けて YouTube に送ります

## データソース

`~/.claude/projects/{プロジェクト}/{セッションID}.jsonl` を読み取り専用で走査します。
追記型ファイルのため、mtime + サイズをキーにパース結果をキャッシュし、変更があったファイルだけ再パースします。

集計している情報:

| 項目 | 取得元 |
|---|---|
| セッションタイトル | `ai-title` 行の `aiTitle` |
| プロジェクトパス / ブランチ | `user` 行の `cwd` / `gitBranch` |
| モデル | `assistant` 行の `message.model` |
| トークン数 | `assistant` 行の `message.usage` |
| ツール実行 | `assistant` 行の `tool_use` コンテンツ |
| タイムライン | 各イベントの `timestamp`(時間単位で集計) |
| サブエージェント | `{セッションID}/subagents/agent-*.jsonl`(mtime が3分以内なら実行中)+ `agent-*.meta.json`(agentType・説明) |

## ステータス判定

| 状態 | 条件 | オフィス上の表現 |
|---|---|---|
| 稼働中 | 最終イベントから 3 分以内 | 着席して作業中・画面発光・パルスリング |
| 直近実行 | 1 時間以内 | デスク横で待機 |
| 待機中 | それ以外 | 空席・暗いモニター |

## 構成

```
server.js            # HTTP サーバー + JSONL パーサー (依存ゼロ)
public/index.html    # オフィスビュー (SVG アイソメトリック描画、単一ファイル)
public/sessions.html # セッション一覧ページ (タイムチャート + リスト、単一ファイル)
```

## ページ

| パス | 内容 |
|---|---|
| `/` | アイソメトリックなオフィスビュー(既定) |
| `/sessions` | セッション一覧(タイムチャート + リスト) |
