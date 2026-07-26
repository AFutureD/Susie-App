// IPC 通道命名规则：invoke 走 `susie:<group>.<method>`，主进程 → 渲染进程事件走 `susie-evt:<group>.<name>`。
// preload 以前缀做门卫（渲染进程只能触达 susie 命名空间，够不到 Electron 内部通道），
// 因此本文件必须保持零依赖（会被打进 CJS sandbox 的 preload）。

export const INVOKE_PREFIX = 'susie:'
export const EVENT_PREFIX = 'susie-evt:'

export function invokeChannel(group: string, method: string): string {
  return `${INVOKE_PREFIX}${group}.${method}`
}

export function eventChannel(name: string): string {
  return `${EVENT_PREFIX}${name}`
}
