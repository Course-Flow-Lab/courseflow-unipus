# courseflow-unipus-classic

Courseflow 的 U校园**普通版**（`u.unipus.cn`）模块，和 AI 版（`ucontent` ipublish / `course-v3`）是两套协议。

## 状态

已跑通：

- CAS 密码登录（`u.unipus.cn/user/student`），取 `getToken` 的 `openId` + `token`
- 进入 `ucontent` 经典课件会话（`/cas-auth/login/?next=/courses/<courseId>/menus`）
- 课程目录页解析 `course_v1` 课程 ID
- 课程树 + 每个 Unit 的 `course_progress`，映射成阅读/视频/题组单元

现在已跑通单页、多页、排序/匹配和多选客观题的完整链路：

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

## 已知限制

- 平台强制单会话：账号在手机/其他浏览器登录时，`getToken` 会 302 到 `repeatLogin`，模块返回 `platform_session_conflict`。需要先在官方页面退出，或让模块自动把其他会话踢下线。
- 写入有频率限制（`600001/600002 操作过于频繁`），模块返回 `in_progress`，需要等几分钟再继续。
- 题组有开放时间：`flowStrategy.startTime` 未到时平台会提示“学习开始时间未到，不能提交”；模块在打开浏览器前直接返回 `blocked`，不会白白消耗首次得分。
- 首次得分锁定：`record_every_submit=false`、`record_max_submit=false`，第一次提交必须用正确答案。
- 多页题组、排序题、多选题都走 API 自动提交；浏览器路径仍只用于单页单选/填空。
- 多选题如果既没有 `audio.script` 也没有 VTT（例如 `u4g624`），模型只能靠题目和选项猜，正确率无法保证；这类题建议先补音频转写或人工答案。

## 安装

```bash
npm install
npm run build
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
