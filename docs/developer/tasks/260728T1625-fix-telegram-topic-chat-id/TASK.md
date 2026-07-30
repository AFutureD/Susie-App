# 修正 Telegram Topic chat_id 判定

* Task: 260728T1625-fix-telegram-topic-chat-id
* Author: [Huanan](https://github.com/AFutureD)
* Status: DONE
* Type: BUG
* Related: [260722T1917-migrate-macos-desktop-app](../260722T1917-migrate-macos-desktop-app)

## 一句话

只有真正的 Telegram Topic 才生成带第三段的 `chat_id`；普通消息线程归入基础会话，同时保留原线程中的回复体验。

## 问题证据

当前实现只要看到 `message_thread_id`，就生成
`<type>:<chat_id>:<message_thread_id>`。但 Telegram 的三个字段含义不同：

| 字段 | 含义 |
|---|---|
| `chat.is_forum` | supergroup 是否开启 Topics |
| `message.is_topic_message` | 当前消息是否属于 Topic |
| `message.message_thread_id` | 普通消息线程或 Topic 的标识，不能单独证明 Topic |

“MapRunner 测试群”实测为非 Forum supergroup，但历史库已有
`S:-1003778872743:59`、`:73`、`:79`。这些后缀来自普通消息线程，当前实现把它们错误拆成了独立会话。

## 目标行为

| 场景 | Telegram 信号 | canonical chat_id |
|---|---|---|
| 普通 supergroup 消息 | 无 Topic 信号 | `S:<chat_id>` |
| 普通 supergroup 线程 | 只有 `message_thread_id` | `S:<chat_id>` |
| Forum 非 General Topic | `is_forum=true`、`is_topic_message=true`、thread ID 非空且不为 `1` | `S:<chat_id>:<topic_id>` |
| Forum General Topic | `is_topic_message` 不为 true，即使带普通 thread ID | `S:<chat_id>` |
| 普通 bot 私聊 | `is_topic_message` 不为 true | `P:<chat_id>` |
| bot 私聊 Topic | `is_topic_message=true`、thread ID 非空且不为 `1` | `P:<chat_id>:<topic_id>` |
| 信号矛盾或 callback 信息不可得 | 无法证明属于 Topic | 基础 chat_id，并记录诊断 |
| Channel Direct Messages Topic | 使用独立的 `direct_messages_topic` 语义 | 不生成 Forum Topic 后缀 |

规范式：私聊仅凭消息自身的 `is_topic_message === true && message_thread_id != null && message_thread_id !== 1` 生成第三段；supergroup 还必须满足 `chat.is_forum === true`。`getMe.has_topics_enabled` 只用于诊断，不参与判定。

## 关键决策

1. **单一判定入口**

   `message` 与可访问的 `callback_query.message` 共享同一个纯函数。chat_id codec 和字符串协议保持不变；第三段只能由该入口决定。

2. **会话归并与回复位置解耦**

   只有“入站带 thread、canonical chat_id 未保留第三段”的消息使用回复锚点。合法 Topic 不新增引用块。锚点使用 `reply_parameters.message_id` 和 `allow_sending_without_reply=true`，原消息删除时允许发送到基础会话。

3. **MCP 回复必须确定性携带锚点**

   `send_message.reply_to` 省略时使用当前 turn 的锚点；正整数表示显式覆盖，`null` 表示跳出普通线程。定时任务和主动发送没有 turn 锚点，行为不变。prompt 只解释覆盖方式，不承担正确性。

4. **Topic 出站不静默降级**

   Topic 文本、附件和 typing 继续携带 `message_thread_id`，失败时绝不去掉 thread 重发。回执 thread 明确不匹配时一律失败；supergroup 回执缺少 Topic 证明时失败；私聊回执字段缺失时先告警，待真实冒烟确认字段形状后再收紧。typing 只返回 `True`，无法校验实际落点。

5. **历史数据只盘点、不猜测迁移**

   不自动重写历史、bindings 或定时任务。上线前产出只读报告，列出所有带第三段的 Telegram chat_id，并人工确认基础会话 binding。旧 binding 不会自动匹配修复后的基础 chat_id，这是发布前必须处理的兼容断点。

## 安全边界

- HTML 纯文本重试只允许 Telegram entity/parser 错误：`can't parse entities`、`unsupported start tag`、`can't find end tag`；Topic、权限和未知错误直接失败。
- 私聊 Topic 的历史回归见 #847；删除 Topic 后曾静默落主聊天见 #854。两条 issue 当前均已关闭，但不能替代本项目真实冒烟。
- 当前 `@inston_huanan_susie_bot` 的 `has_topics_enabled=false`，不能验证私聊 Topic 出站；获得合适 bot 和发送许可前，该能力保持“未验证”。
- `InaccessibleMessage` 缺少 Topic 字段，只能回退基础会话；Forum Topic 内的旧按钮可能因此进入不同 Susie 会话。
- 当前通道不消费 `edited_message`、`channel_post`、`edited_channel_post`；本任务不新增这些入口，也不支持 Channel Direct Messages Topic。

## 验收

1. 表驱动测试覆盖目标行为矩阵，包括 General Topic 携带无关 thread、私聊 Topic、Direct Messages Topic 和不可访问 callback。
2. 普通线程归入基础会话；其命令、错误、直接输出和 MCP 主回复仍使用回复锚点；合法 Topic 的发送形状不变。
3. Topic 出站不做无 thread fallback；回执按群聊/私聊规则处理；HTML 仅对明确 parser 错误重试。
4. 上线前报告列出历史、bindings、定时任务中的第三段目标；MapRunner 基础 `S:-1003778872743` binding 已人工确认。
5. `npm run check && npm run build && npm run smoke && npm run test:e2e` 通过；私聊 Topic 在取得许可后单独做真实 API 冒烟。

## 非目标

- 不清洗或合并现有历史记录。
- 不创建、编辑、关闭或枚举 Telegram Topic。
- 不获取或持久化 Topic 名称。
- 不改变用户权限的群级归一化规则。

## 参照

- 代码：[Telegram bot](/src/main/channels/telegram/bot.ts)、[chat-id codec](/src/shared/chat-id.ts)
- 官方文档：[Message](https://core.telegram.org/bots/api#message)、[sendMessage](https://core.telegram.org/bots/api#sendmessage)、[ReplyParameters](https://core.telegram.org/bots/api#replyparameters)
- 语义说明：[General Topic / generic thread #356](https://github.com/tdlib/telegram-bot-api/issues/356)、[Bot API 9.3 private topics](https://core.telegram.org/bots/api-changelog#december-31-2025)
- 风险记录：[私聊 Topic 明确失败 #847](https://github.com/tdlib/telegram-bot-api/issues/847)、[删除后静默落主聊天 #854](https://github.com/tdlib/telegram-bot-api/issues/854)
