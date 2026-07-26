/**
 * preload 暴露到 window.susie 的泛型桥形状。
 * 通道名的拼装与类型化封装都在 renderer 侧（lib/ipc.ts 的 Proxy 客户端）；
 * preload 只负责前缀门卫 + 错误信封还原，保持最薄。
 */
export interface SusieGenericBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>
  on(channel: string, listener: (payload: unknown) => void): () => void
}
