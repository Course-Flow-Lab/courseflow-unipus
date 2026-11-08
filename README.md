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
  空答案提交可以成功；带 `user_answer` 的答案结构还在验证，默认关闭自动提交（`enable_task_submit: true` 才启用）。

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
