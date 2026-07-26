import type { ApprovalStatus } from '../core/approval-repo'

// bot 侧全部用户可见文案的唯一出处（zh-Hans）。
// 纯 const + 模板函数，不引 i18n 框架；未来本地化 = 按 locale 选 catalog 模块，签名不变。
// 注意：auto-review 的判定 instruction 是 prompt 工程不是 UI 文案，不进本表。

export const botCopy = {
  approval: {
    /** 卡片标题状态 tag：随裁决更新（曾经固定「待审核」，自动放行后的卡片标签误导 owner） */
    statusTag: {
      pending: '待审核',
      auto_reviewing: '自动审核中',
      auto_passed: '已放行',
      terminated: '已终止',
      approved: '已允许',
      denied: '已拒绝',
      failed: '未执行',
    } satisfies Record<ApprovalStatus, string>,

    action: { allow: '允许', deny: '拒绝', stop: '终止' },

    cardHeader: (tag: string, sender: string, chatLabel: string) => `【${tag}】${sender} 在「${chatLabel}」发来消息：`,
    fileCount: (count: number) => `（含 ${count} 个附件）`,
    autoReviewing: '🤖 自动审核中…',
    autoPassedLine: '✅ 自动审核通过，已放行处理。',
    autoRejectedLine: (reason: string) => `🤖 自动审核未通过：${reason}`,
    unknownSender: '未知用户',

    decision: {
      approved: '✅ 已允许',
      denied: '🚫 已拒绝',
      terminatedActive: '⛔ 已终止，进行中的处理已中断',
      terminatedIdle: '⛔ 已终止（处理已结束，无可中断任务）',
      bindingGone: '⚠️ 绑定已失效，未执行',
    },

    /** answerCallback 的即时反馈（点按者客户端 toast） */
    callbackToast: {
      handled: '已处理',
      ownerOnly: '仅 owner 可操作',
      missing: '该审核请求不存在或已失效',
      bindingGone: '绑定已失效，未执行',
      terminated: '已终止',
      denied: '已拒绝',
      approved: '已允许',
    },

    memberPending: '⏳ 消息已提交 owner 审核。',
    memberDenied: '🚫 消息未获 owner 批准。',
    memberUndeliverable: 'Error: 审核请求发送失败（owner 不可达），消息未处理。',
  },

  gate: {
    permissionIgnored: '⛔ 你没有使用权限。',
    noOwner: '⚠️ 该频道未绑定 owner，消息无法审核。',
  },
} as const
