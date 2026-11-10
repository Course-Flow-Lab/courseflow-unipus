# courseflow-unipus

Courseflow 的 U校园**普通版**（`u.unipus.cn`）平台模块，提供课程目录、学习任务、章节题目和单元测试的协议实现。与 AI 版（[courseflow-uai](https://github.com/Course-Flow-Lab/courseflow-uai)，走 `ucontent` ipublish）是两套协议，不要混用配置。

> 请只在你有权访问的账号和课程上使用。运行前确认符合平台条款和学校规定。

## 功能

- CAS 账号密码登录，`getToken` 换取 `openId` + `token`
- 每个账号登录后从自己的课程列表选择课程和班级，多用户互不影响
- 课程树、单元进度回读，映射成阅读 / 视频 / 题组
- 视频和阅读节点完成
- 章节题目：单选、判断、填空（`fillblankScoop`）、多页题组、排序 / 匹配、多选、短答和表格短答
- 音频转写：优先使用 `audio.script` / VTT；没有原文时调用宿主 `cw.asr.transcribe`
- 单元测试：独立 `uexercise` 试卷应用，模块内通过 `cw.browser` 完成解析、答题、交卷
- 提交护栏：按题型选择 API 或浏览器提交，首次得分锁定前先确认答案完整

## 环境

- Node.js 24 或更高
- Courseflow Framework `>=0.1.1 <0.2.0`
- Chrome / Chromium，用于官方页面和单元测试
- 可选：Python + `faster-whisper` + `ffmpeg`，只在宿主没有 ASR 服务时用于本地转写

## 安装

```bash
git clone <this-repo>
cd courseflow-unipus-classic
npm install
npm run build
```

把模块加入 Courseflow：

```bash
cd ../courseflow-framework
npm run cli -- module add /path/to/courseflow-unipus-classic
npm run cli -- module list
```

启动服务：

```bash
npm run serve
```

## 配置

模块配置的必填项只保留平台地址。课程、班级和学校信息从每个账号登录后的课程列表读取，不再写进模块配置：

```json
{
  "base_url": "https://u.unipus.cn",
  "content_base_url": "https://ucontent.unipus.cn"
}
```

| 键 | 说明 |
| --- | --- |
| `base_url` | 默认 `https://u.unipus.cn` |
| `content_base_url` | 默认 `https://ucontent.unipus.cn` |

可选行为开关（不影响每个用户选择自己的课程）：

| 键 | 说明 |
| --- | --- |
| `browser_study` | 默认 `true`；用官方浏览器（Playwright/CDP）做客观题 |
| `enable_task_submit` | 默认 `false`；`browser_study=false` 时允许走 API 提交客观题 |
| `enable_unit_test` | 默认 `false`；开启后单元测试在模块内用 `cw.browser` 自动答题/交卷 |
| `unit_test_dry_run` | 默认 `false`；只解析、生成、填答案，不交卷，便于部署前演练 |
| `asr_enabled` | 默认 `true`；没有原文/VTT 时转写音频 |
| `asr_python` | 默认 `python`；本地回退用的解释器 |
| `asr_model` | 默认 `base.en`；本地回退用的 faster-whisper 模型 |
| `asr_timeout_ms` | 默认 `24000`；本地转写超时 |

> 旧版的 `class_url`、`school_id`、`course_id` 已移除。每个用户连接自己的账号后，在「学习目录」里选择自己的课程和班级；模块按平台用户分别缓存课程选择，不会把别人的课程带进来。

宿主环境变量（框架侧）：

```bash
CF_CHROMIUM=/path/to/chrome        # 官方页面和单元测试
CF_ASR_URL=https://asr.example.com/v1   # 或 CF_ASR_COMMAND，二选一
CF_CALL_TIMEOUT_MS=1800000         # 整套试卷需要，默认 30 秒不够
```

## 使用

1. 在 Courseflow 里连接 `unipus_classic`，输入自己的账号密码。
2. 连接完成后，在「学习目录」里从当前账号的课程列表选择课程和班级。不同用户可以选择不同课程，选择结果只保存在该用户下。
3. 在「模型与任务设置」里选择一个模型；章节客观题和单元测试需要模型。
4. 在「学习目录」里选择单元执行学习任务。
5. 需要单元测试时打开 `enable_unit_test`；不确定结果就先开 `unit_test_dry_run` 演练。
6. 口语、录音、上传和讨论任务会返回 `needs_human`，需要人工完成。

## 工作方式

模块运行在 Courseflow 的模块宿主里，通过 JSON-RPC 调用宿主提供的能力：

- `cw.net.fetch`：访问 U校园接口，处理 Cookie、授权和网络白名单
- `cw.browser.open/evaluate/mouse/close`：打开官方页面，完成视频播放、客观题填写和单元测试
- `cw.ai.generate`：章节题和单元测试的答案生成
- `cw.asr.transcribe`：把音频交给宿主转写，模块不写临时文件、不起子进程
- `cw.session.identity` / `cw.state` / `cw.log`：会话身份、模块状态和日志

登录先用 CAS 拿到 `jwt`，再交换 `openId` + `token`；之后的课程、内容和提交接口都走 `cw.net.fetch`。课程列表从账号自己的 `/user/student/index` 页面解析，课程目录页只用于把选中的课程映射到 `course-v1:...` 和发布版本。`cw.state` 的课程缓存按 `open_id`、课程 ID 和班级 ID 分开保存，多个用户共用同一个模块进程时不会互相覆盖。

模块按框架的沙箱运行（`node --permission`），不写文件、不创建子进程。没有宿主 ASR 服务时，音频任务会回退到本地 Python，但该回退在沙箱里不可用。

## 项目结构

```text
src/module.ts            模块入口和方法实现
scripts/transcribe_audio.py   单文件本地转写（可选回退）
scripts/transcribe_many.py    批量本地转写（runner 用）
scripts/uexercise-runner.mjs  独立试卷 runner（调试/离线验分）
courseflow.module.json   模块清单
index.mjs                esbuild 打包产物
```

## 构建

```bash
npm install
npm run build
```

`index.mjs` 由 `src/module.ts` 打包生成，不要直接修改。

## 测试情况

开发时在真实课程上验证过：

- 普通任务：阅读、视频、单选、填空、排序、多选、短答和表格短答均能完成并回读
- Unit 2：全部客观题和短答完成，Unit test 96%（24/25）
- Unit 3：Unit test 92%（23/25）
- 框架 0.1.7 + 宿主 ASR：单元测试演练解析 25 题、填题 `radio=15 text=10 missing=[]`，听写 10/10，选择 13/15

以上是样本结果，不同课程、试卷和模型会有差异。独立 runner 也可以脱离框架运行，用于演练和离线对分：

```bash
npm run uexercise -- --help
```

## 已知限制

- 课程列表来自账号已经加入的班课；老师新拉入的班级需要刷新课程列表后才会出现
- 平台强制单会话：账号在手机或其他浏览器登录时会被踢下线，需要重新登录
- 首次得分锁定：课程默认只记录第一次提交，交卷前务必先演练
- 口语、录音、上传和讨论任务不做自动提交，统一返回 `needs_human`
- 整套单元测试包含十几段音频和模型调用，默认 30 秒调用上限不够，需要调大 `CF_CALL_TIMEOUT_MS`，或等待后续的分步实现
- 选择题存在模型波动，个别语义相近选项可能选错；听写空位由原文对齐产出，基本稳定

## 贡献

欢迎提交 issue 和 pull request。

## License

MIT
