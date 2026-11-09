# courseflow-unipus-classic

Courseflow 的 U校园**普通版**（`u.unipus.cn`）模块，和 AI 版（`ucontent` ipublish / `course-v3`）是两套协议。

## 状态

已跑通：

- CAS 密码登录（`u.unipus.cn/user/student`），取 `getToken` 的 `openId` + `token`
- 进入 `ucontent` 经典课件会话（`/cas-auth/login/?next=/courses/<courseId>/menus`）
- 课程目录页解析 `course_v1` 课程 ID
- 课程树 + 每个 Unit 的 `course_progress`，映射成阅读/视频/题组单元

现在已跑通单页、多页、排序/匹配、多选、短答和表格短答的完整链路：

- 题组：`summary` 取 qid、`/course/api/v3/content` 解密题面与参考解析
- 题组提交：`POST /course/api/v3/submit/<course>/<group>/`，真实 envelope 已对齐
- 首次提交即可拿满分，不再依赖空提交或补交
- 平台默认按“首次得分”记录（`record_every_submit=false`、`record_max_submit=false`），所以第一次提交必须用正确答案
- 处理策略：
  - 判断题、选择题、填空题属于**客观题**，会计分；默认走浏览器或显式 API 提交
  - 简答题、写作、翻译等**主观题**才按“写了就行”处理：自动提交文本并标记完成
  - `task_mini_score_pct = 0` 只表示该任务“交了就算过”，不代表分数不计入课程成绩
  - 客观题 API 提交需要设置 `enable_task_submit: true`；浏览器提交由 `browser_study` 控制

实测：u2g72（简答）提交后 `pass=1`；u2g76、u2g567 属于客观题，即使 `pass=1` 也会记录 0 分。

## study flow 初始化（已确认）

打开课件页**不会**创建 `user_module`。平台在首次提交时由前端生成 `version`（Unix 秒级时间戳），直接带进提交体：

- `record_version` = 当前时间戳
- `state.version` = 同一个时间戳
- 没有 `base` 字段
- 提交成功后服务端才创建 `user_module`，并回写 `progress/v2`

如果 `user_module` 已存在，则复用 `data.state.version`。所以不需要额外的 init 请求。

## 答题与提交结构（已实测）

### 填空题 `fillblankScoop`

答案从 `content[].audio.script` 的下划线 `<span style="text-decoration: underline">` 提取。

```json
{
  "enable_mistake": false,
  "version": "default",
  "record_version": "<version>",
  "state": "{\"version\":\"<version>\",\"p_1\":{\"c_1_1\":{\"student_answers\":{\"0\":\"...\"}}},\"__EXTEND_DATA__\":{\"__SUMMARY__\":{\"answerList\":{\"0\":{\"student_answer\":\"...\",\"isDone\":true,\"version\":\"v2\",\"rule\":\"in\"}}}}}",
  "specific_scores": [null, ...],
  "answers": {
    "0": {
      "student_answer": "...",
      "isDone": true,
      "version": "v2",
      "rule": "in",
      "user_answer": {
        "qid": "...",
        "rule": "in",
        "answer": { "index": 0, "answer": "...", "version": "v2" },
        "content": "",
        "id": "<qid>-0",
        "offset": 0
      }
    }
  }
}
```

### 单选 / 判断 `singlechoice`

判断题也是 `singlechoice`，只是选项固定为 `A=True`、`B=False`。结构相同，`rule` 为 `eq`，答案为选项字母。

```json
{
  "state": "{\"version\":\"<version>\",\"p_1\":{\"c_1_1\":{\"student_answers\":{\"0\":\"D\",\"1\":\"B\"}}},\"__EXTEND_DATA__\":{\"__SUMMARY__\":{\"answerList\":{\"0\":{\"student_answer\":\"D\",\"isDone\":true,\"version\":\"v2\",\"rule\":\"eq\"},\"1\":{\"student_answer\":\"B\",\"isDone\":true,\"version\":\"v2\",\"rule\":\"eq\"}}}}}",
  "answers": {
    "0": {
      "student_answer": "D",
      "isDone": true,
      "version": "v2",
      "rule": "eq",
      "user_answer": {
        "qid": "...",
        "rule": "eq",
        "answer": { "index": 0, "answer": "D", "version": "v2" },
        "content": "",
        "id": "<qid>-0",
        "offset": 0
      }
    }
  }
}
```

注意：AI 返回 `"B"` 这类单字母时，只能按 `caption` 精确匹配。不能对选项原文做 `includes("B")`，否则 `"Because ..."` 会被误判成 B 选项。

选择题现在会把 `content[].audio.script` 的听力原文、`content[].scoop.html` 的阅读材料和 `content[].video.file` 的 VTT 字幕一起注入模型 prompt，不再只靠题干和选项猜答案。没有原文的题组会退回只发题干和选项。

如果 `audio.script` 和 VTT 都没有，模块会下载音频再转写：

- 优先调用宿主的 `cw.asr.transcribe`（清单需声明 `asr: true`）：模块不写临时文件、不起子进程，能跑在框架的模块沙箱里
- 宿主没有 ASR 服务时，回退到本地 `scripts/transcribe_audio.py`：
  - 依赖 `faster-whisper` 和 `ffmpeg`
  - 默认模型 `base.en`
  - HuggingFace 下载默认走 `https://hf-mirror.com`，可用 `HF_ENDPOINT` 覆盖
  - 典型 2.5 分钟音频约 20 秒完成
- 转写文本会缓存到模块进程内，避免同一任务重复跑

实测 `u4g624` 这类没有原文的多选题：ASR 得到 2285 字符，提交 100 分。

### 多页题组（Short conversations）

多页题组和单页结构不同：

- `summary.questionsList` 使用 `p_1..p_N`，每页单独 qid
- `content` 也被拆成 `content_1..content_N`，每个 group 只有一个 question
- 模块会按顺序合并所有 `content_*.questions`，再统一作答
- `state` 里每页写数组：
  ```json
  "p_1": { "c_1_1": { "student_answers": ["B"] } },
  "p_2": { "c_1_1": { "student_answers": ["A"] } }
  ```
- `__SUMMARY__.answerList` 仍用全局 `0..N`
- `answers[i].user_answer.answer.index` 是页内索引 `0`
- `answers[i].user_answer.id` 是 `<qid>-0`
- `answers[i].user_answer.offset` 是页序号 `0..N`

实测 `u8g514`（Short conversations，5 页）：**100 分**。

### 排序 / 匹配题 `sequence`

排序题在接口里不是数组，而是对象：

```json
"p_1": {
  "c_1_0": {
    "student_answers": {
      "0": "D",
      "1": "E",
      "2": "G"
    }
  }
}
```

- `rule` 是 `eq_ig_case`
- `answerList` 仍用全局 `0..N`
- `answers[i].user_answer.answer.answer` 是单个选项 caption
- 题目图片按顺序对应原文中的人物/段落，模块会把 VTT/听力原文一起交给模型

实测 `u3g565`（8 个匹配项）：**100 分**。

### 多选题 `multichoice`

多选题每题的答案是数组，整个 `student_answers` 是数组的数组：

```json
"p_1": {
  "c_1_1": {
    "student_answers": [
      ["A", "B"],
      ["C"],
      ["D"]
    ]
  }
}
```

- `rule` 是 `contain`
- `answerList[i].student_answer` 是数组
- `answers[i].user_answer.answer.answer` 也是数组

`u4g624` 的本地状态结构已通过页面 `saveAnswer` 验证；但它是 required 任务，而且音频没有 `script`/VTT，尚未做真实提交，避免首次得分锁成 0。

### 短答题 `shortanswer` / `shortanswerScoop`

短答题按“主观题”处理，规则是 `subjective`：

```json
"p_1": {
  "c_1_1": {
    "student_answers": {
      "0": "answer one",
      "1": "answer two"
    }
  }
}
```

- 单题 `shortanswer:shortanswer` 用 `c_1_1`
- 多题 `questions:shortanswer` 用 `c_1_0`
- 表格型 `shortanswerScoop` 用 `c_1_1`
- `answerList` 和 `answers` 的 `student_answer` 都是字符串
- 不要求正确率，提交后 `state=1`、`score_pct=1`

实测：

- `u3g139`（单题短答）：100
- `u2g85`（多题短答）：100
- `u2g110`（表格短答 8 空）：100

### 口语 / 录音题策略

这些类型明确返回 `needs_human`，不再尝试自动提交：

- `roleplay:roleplay`
- `presentation:individualpresentation-course`
- `sentencesforrecord`
- `individualpresentation-course`

原因是需要录音/音频上传，当前模块不做伪提交，避免把任务状态写坏。

## Playwright 浏览器提交（已验证）

用 Edge 远程调试（`--remote-debugging-port=9222`）+ Playwright `connectOverCDP`，通过模块的 `cw.browser` 已完成：

- u7g453（fillblankScoop，10 空）：100 分
- u3g191（singlechoice，2 题）：100 分

纯 API 路径（`browser_study=false` + `enable_task_submit=true`）也已完成：

- u4g254（fillblankScoop，10 空，required）：100 分
- u3g192（singlechoice，2 题）：100 分
- u8g514（Short conversations，多页 5 题）：100 分
- u4g250（Short conversations，多页 5 题，required）：100 分
- u3g565（sequence，8 个匹配项）：100 分

流程：

1. 打开课件页；
2. 删除 `.bfg-mask`，点“我知道了”关闭新手指引；
3. 点任务提示里的“确定”（“本单元学习时间/是否必修”弹窗），否则提交按钮只弹提示；
4. 填空用原生 setter 写值并派发 `input`/`change`/`blur`；选择题按 `input[type=radio]` 的 `name` 分组，再按答案字母点对应 `label`；
5. 点最后一个 `button.submit-bar-pc--btn`（提交）；
6. 在“小U只记录你第一次答题的得分”弹窗里点 **确认**（不是“确定”）；
7. 平台返回 `code 0`，回读 `score_avg=100`、`state=1`。

单页题组的浏览器路径失败时，如果平台状态仍是 `state=0`（没有提交成功），模块会自动用同一组答案走 API 兜底，避免无头布局导致白跑。多页题组直接走 API，不依赖浏览器。框架没有配置 `CF_CHROMIUM` 时也会走 API 兜底。

已确认可用：

- 阅读/视频：`POST /api/mobile/user_group/<course>/<group>/progress/`，body
  `{"status":1,"rid":"flowengine:studyStatus:1:<group>","groupId":"<group>","version":"default"}`

## uexercise 单元测试 runner

单元测试是 `uexercise.unipus.cn` 的独立试卷应用，不在普通 `study.step` 协议里。仓库提供独立 runner：

```bash
npm run uexercise -- --help
```

### 1. 导出题目

```bash
node scripts/uexercise-runner.mjs \
  --storage-state u-storage.json \
  --courseware-url "https://ucontent.unipus.cn/.../u3g196/p_1" \
  --dump --out ut-questions.json
```

输出包含：

- 25 道题的 `qIndex`
- 每题的选项（注意页面选项顺序是随机的）
- 输入框题目
- 音频 URL 列表
- `sppid`、`exerciseId`、表单 action

### 2. 自动生成答案

```bash
node scripts/uexercise-runner.mjs \
  --storage-state u-storage.json \
  --courseware-url "https://ucontent.unipus.cn/.../u3g196/p_1" \
  --generate \
  --answers-out ut-answers.json \
  --transcripts-out ut-transcripts.json \
  --ai-base http://127.0.0.1:6000/v1 \
  --ai-model auto/deepseek-v4.1-flash
```

流程：

- 下载试卷里的 19 个音频
- 调 `faster-whisper` 批量转写（默认 `base.en`，可按需换 `small.en`）
- 复合式听写：把试卷段落（带 `16)` 空位）和 ASR 原文做词级对齐，直接抠出空位原词，不让模型改写
- 选择题：逐题带上对应音频的转写，要求模型返回“选项原文”而不是字母（页面选项每次刷新都会重排）
- 生成 `answers.json`

`--transcripts` 可以复用已有的 ASR 结果，`--details-out` 会保存当次解析出的题目/选项/段落，便于和 review 页答案键做离线评估。

没有 AI Key 时可以加 `--heuristic` 用关键词匹配兜底，但准确率有限。

### 3. 准备答案

```json
{
  "1": "The woman wants to play golf while the man wants to play tennis.",
  "2": "No one will pay attention to how the man dances.",
  "16": "audience",
  "17": "teenage"
}
```

规则：

- 选择题推荐写选项原文，runner 按文本匹配；写显示字母 `A/B/C/D` 也可以，但字母只对当次页面顺序有效
- 填空题写文本
- 没有答案的题可以留空；runner 会报告 `missing`

### 4. 演练或交卷

```bash
# 只填答案，不提交
node scripts/uexercise-runner.mjs \
  --storage-state u-storage.json \
  --courseware-url "https://ucontent.unipus.cn/.../u3g196/p_1" \
  --answers ut-answers.json

# 真正交卷
node scripts/uexercise-runner.mjs \
  --storage-state u-storage.json \
  --courseware-url "https://ucontent.unipus.cn/.../u3g196/p_1" \
  --answers ut-answers.json --submit
```

当前 runner 已验证：

- 能打开课件页并触发 `PCUtButton.todoSubject`
- 能拿到 `enter_unit_test` iframe URL
- 能解析 25 题
- 能按 qIndex 填 15 个单选 + 10 个填空
- 能自动下载 19 个音频并批量 ASR
- 能生成 25 条答案
- 能真实提交到 `POST /itest/s/clsanswer/submitUT`

实测 Unit 3：

```text
第一次提交（旧版整卷提示）：25 题，答对 15 题，60%
第二次提交（逐题 + 听写对齐）：25 题，答对 23 题，92%
  选择题 13/15，听写 10/10
```

课程只记录首次成绩，所以第二次的 92% 不会覆盖 60%；但同一份卷子上 runner 的答案正确率已经从 60% 提到 92%。

选择题的剩余误差主要来自语义相近选项（如 "America is large..." vs "America has more tourist attractions than Europe"）；听写空位由原文对齐产出，基本不会改写。

### 5. 模块内直接跑（部署方式）

设置 `enable_unit_test=true` 后，`study.step` 对 `quiz-paper-link` 不再返回 `needs_human`，而是在模块内用框架的 `cw.browser` 完成整条链路：

1. 打开课件页，调 `todoSubject()` 拿 `enter_unit_test` 地址
2. 打开试卷页，解析 25 题（题目/选项/段落/音频）
3. 用 `cw.net.fetch` 下载音频，本地 ASR 转写
4. 选择题逐题带转写给模型，要求返回选项原文；听写空位按原文对齐抠词
5. 填题后调用 `paperSubmit(1)`，再用 `progress/v2` 确认 `state` 和 `score_pct`

`unit_test_dry_run=true` 时只做到第 4 步（填好不交），返回 `needs_human`，便于部署前演练。

实测：Unit 3 演练（`u3g196`）15 道选择全对、10 个听写空全对；真实提交路径在已交卷的 Unit 3 上验证通过，不影响首考记录。

## 已知限制

- 平台强制单会话：账号在手机/其他浏览器登录时，`getToken` 会 302 到 `repeatLogin`，模块返回 `platform_session_conflict`。需要先在官方页面退出，或让模块自动把其他会话踢下线。
- 写入有频率限制（`600001/600002 操作过于频繁`），模块返回 `in_progress`，需要等几分钟再继续。
- 题组有开放时间：`flowStrategy.startTime` 未到时平台会提示“学习开始时间未到，不能提交”；模块在打开浏览器前直接返回 `blocked`，不会白白消耗首次得分。
- 首次得分锁定：`record_every_submit=false`、`record_max_submit=false`，第一次提交必须用正确答案。
- 多页题组、排序题、多选题都走 API 自动提交；浏览器路径仍只用于单页单选/填空。
- ASR 是本地 CPU 转写，2.5 分钟音频约 20 秒；如果框架调用预算更紧，可把 `asr_model` 改成 `tiny.en`，或提前把模型缓存好。
- ASR 依赖 `python`、`faster-whisper`、`ffmpeg`；模块安装时会把 `scripts/transcribe_audio.py` 一起复制。
- 口语/录音题（roleplay、presentation、sentencesforrecord）不做自动提交，统一返回 `needs_human`。
- 单元测试 `quiz-paper-link` 已纳入目录，并带 `exercise_id`/`exam_id` 元数据；它实际是 `uexercise.unipus.cn` 的独立试卷应用（25 题，含听力/听写）。默认仍返回 `needs_human`；设置 `enable_unit_test=true` 后，模块会用 `cw.browser` 打开课件页→触发 `todoSubject`→进试卷→转写音频→生成答案→填题→交卷，并用 `progress/v2` 确认分数。`unit_test_dry_run=true` 可只填不交。独立 runner 保留作为调试/离线验分工具。

## 安装

```bash
npm install
npm run build

# 可选：没有 audio.script/VTT 时需要本地 ASR
python -m pip install faster-whisper
# 并确保 ffmpeg 在 PATH 里
```

在 Courseflow 里：

```bash
npm run cli -- module add /path/to/courseflow-unipus-classic
npm run cli -- module config unipus_classic '{
  "class_url": "https://u.unipus.cn/user/student/mycourse/courseCatalog?courseId=...&school_id=...&eccId=...&classId=...&coursetype=0",
  "school_id": "..."
}'
```

`class_url` 就是浏览器里课程目录页的地址。

## 配置

| 键 | 说明 |
| --- | --- |
| `class_url` | 课程目录页 URL，必需 |
| `school_id` | 学校 ID，可以从 `class_url` 自动解析 |
| `course_id` | 可选，直接指定 `course-v1:...`，跳过目录页解析 |
| `base_url` | 默认 `https://u.unipus.cn` |
| `content_base_url` | 默认 `https://ucontent.unipus.cn` |
| `browser_study` | 默认 `true`；用官方浏览器（Playwright/CDP）做客观题 |
| `enable_task_submit` | 默认 `false`；`browser_study=false` 时允许走 API 提交客观题 |
| `enable_unit_test` | 默认 `false`；开启后单元测试（`quiz-paper-link`）在模块内用 `cw.browser` 走完整试卷流程 |
| `unit_test_dry_run` | 默认 `false`；开启后只解析/生成/填答案，不交卷，方便部署前演练 |
| `asr_enabled` | 默认 `true`；没有原文/VTT 时用 faster-whisper 转写音频 |
| `asr_python` | 默认 `python`；指向装有 `faster-whisper` 的 Python |
| `asr_model` | 默认 `base.en`；可改 `tiny.en` 降低耗时 |
| `asr_timeout_ms` | 默认 `24000`；ASR 超时时间 |

## 协议要点

- 登录：`sso.unipus.cn/sso/0.1/sso/cip/login`，账号密码 AES-128-CBC 加密
- 登录后可能返回 `1506`，表示需要图形/滑块验证码；模块会返回 `platform_verification_required`
- `GET /user/data/getToken` → `{ openId, token }`
- 课程树：`GET /course/api/course/<course-v1>/default/`
- 进度：`GET /course/api/v2/course_progress/<course>/<unit>/<openId>/default/`，需要 `x-annotator-auth-token`
- 内容：`GET /course/api/v3/content/<course>/<group>/default/`，返回 `unipus.<hex>`；AES-128-ECB，key = `1a2b3c4d` + `k`
- 提交：`POST /course/api/v3/submit/<course>/<group>/`

## 隐私

- 账号密码只用于登录交换，不写入模块状态。
- `token`、`openId` 存在框架的 `cw.state`，不写入仓库。
- 仓库不包含账号、Cookie、课程 ID 或答案。
