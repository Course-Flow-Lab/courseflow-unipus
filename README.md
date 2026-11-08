# courseflow-unipus-classic

Courseflow 的 U校园**普通版**（`u.unipus.cn`）模块，和 AI 版（`ucontent` ipublish / `course-v3`）是两套协议。

## 状态

已跑通：

- CAS 密码登录（`u.unipus.cn/user/student`），取 `getToken` 的 `openId` + `token`
- 进入 `ucontent` 经典课件会话（`/cas-auth/login/?next=/courses/<courseId>/menus`）
- 课程目录页解析 `course_v1` 课程 ID
- 课程树 + 每个 Unit 的 `course_progress`，映射成阅读/视频/题组单元

联调中：

- 题组：`summary` 取 qid、`/course/api/v3/content` 解密题面与参考解析
- 题组提交：已抓到真实 envelope：
  ```json
  {
    "enable_mistake": false,
    "version": "default",
    "record_version": "<user_module.state.version>",
    "base": "<user_module.commit>",
    "state": "<JSON 字符串>",
    "specific_scores": [null, null],
    "answers": { "0": { "score": 0 } }
  }
  ```
  空答案提交可以成功；带 `user_answer` 的答案结构已确认到：
  ```json
  {
    "user_answer": {
      "qid": "...",
      "rule": "eq",
      "answer": {
        "index": 0,
        "answer": { "student_answer": { "answers": "A" } },
        "version": "v3"
      },
      "content": ""
    }
  }
  ```
  但真正计分还依赖 `scoreType`、`question_type`、`versions` 等元数据；目前提交后 `real_score_pct` 仍为 0。
- 平台默认按“首次得分”记录（`record_every_submit=false`、`record_max_submit=false`），所以“先乱填、再按标准答案重交”无法把分数改回来。
- 处理策略：
  - 判断题、选择题、填空题属于**客观题**，会计分；默认暂停自动提交。
  - 简答题、写作、翻译等**主观题**才按“写了就行”处理：自动提交文本并标记完成。
  - `task_mini_score_pct = 0` 只表示该任务“交了就算过”，不代表分数不计入课程成绩。
  - 客观题只有设置 `enable_task_submit: true` 且能提供答案时才自动提交。

实测：u2g72（简答）提交后 `pass=1`；u2g76、u2g567 属于客观题，即使 `pass=1` 也会记录 0 分。

## 已知硬限制：Flash 录音器遮罩

这套视听说课件在题目页会加载 Flash 录音器组件，并弹出 `bfg-mask` 遮罩（提示“Flash 版本过低/正在下载 Flash 录音器”）。在无头 Chromium 里：

- 遮罩会拦截选项和提交按钮的点击；
- 即使绕过遮罩、把输入框填好，点“提交”也只会弹 Flash 提示，不会发出 `/course/api/v3/submit` 请求；
- 因此音频类客观题目前无法在纯 HTTP 或无头浏览器里完成自动交卷。

阅读和视频节点不依赖该录音器，仍可正常自动完成。

## Playwright 真实提交（已验证）

用 Edge 远程调试（`--remote-debugging-port=9222`）+ Playwright `connectOverCDP`，在真实 Edge 里完成了 u2g126：

1. 打开课件页；
2. 删除 `.bfg-mask` / tooltip 遮罩；
3. 用原生 setter 填输入框并派发 `input`/`change`；
4. 点最后一个 `button.submit-bar-pc--btn`（提交）；
5. 在“小U只记录你第一次答题的得分”弹窗里点 **确认**（不是“确定”）；
6. 平台返回 `code 0`，回读 `score_avg=100`、`state=1`，页面显示「是否计入教程学习成绩：不计入」。

抓到的 fillblankScoop 提交结构：

```json
{
  "enable_mistake": false,
  "version": "default",
  "record_version": "<user_module.state.version>",
  "state": "{\"version\":\"...\",\"p_1\":{\"c_1_1\":{\"student_answers\":{\"0\":\"...\"}}},\"__EXTEND_DATA__\":{\"__SUMMARY__\":{\"answerList\":{\"0\":{\"student_answer\":\"...\",\"isDone\":true,\"version\":\"v2\",\"rule\":\"in\"}}}}}",
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

fillblankScoop 的答案还能直接从 `content[].audio.script` 的下划线 span 提取。

已确认可用：

- 阅读/视频：`POST /api/mobile/user_group/<course>/<group>/progress/`，body
  `{"status":1,"rid":"flowengine:studyStatus:1:<group>","groupId":"<group>","version":"default"}`

## 已知限制

- 平台强制单会话：账号在手机/其他浏览器登录时，`getToken` 会 302 到 `repeatLogin`，模块返回 `platform_session_conflict`。需要先在官方页面退出，或让模块自动把其他会话踢下线。
- 写入有频率限制（`600001/600002 操作过于频繁`），模块返回 `in_progress`，需要等几分钟再继续。

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
