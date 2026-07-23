// 审批与沙箱预设映射（对位 openai_codex _approval_mode.py / _sandbox.py）
import type { ApprovalsReviewer } from './generated/v2/ApprovalsReviewer'
import type { AskForApproval } from './generated/v2/AskForApproval'
import type { SandboxMode } from './generated/v2/SandboxMode'
import type { SandboxPolicy } from './generated/v2/SandboxPolicy'

/** deny_all：从不请求审批；auto_review：升级请求交给子代理自动评审 */
export type ApprovalMode = 'deny_all' | 'auto_review'

export interface ApprovalSettings {
  approvalPolicy: AskForApproval
  approvalsReviewer: ApprovalsReviewer | null
}

export function approvalModeSettings(mode: ApprovalMode): ApprovalSettings {
  if (mode === 'auto_review') return { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
  return { approvalPolicy: 'never', approvalsReviewer: null }
}

export type Sandbox = 'read-only' | 'workspace-write' | 'full-access'

/** thread 生命周期参数用 mode 表示 */
export function sandboxMode(sandbox: Sandbox): SandboxMode {
  if (sandbox === 'full-access') return 'danger-full-access'
  return sandbox
}

/** turn 覆盖参数用 policy 表示；缺省字段交给 serde 默认值 */
export function sandboxPolicy(sandbox: Sandbox): SandboxPolicy {
  switch (sandbox) {
    case 'read-only':
      return { type: 'readOnly' } as SandboxPolicy
    case 'workspace-write':
      return { type: 'workspaceWrite' } as unknown as SandboxPolicy
    case 'full-access':
      return { type: 'dangerFullAccess' }
  }
}
