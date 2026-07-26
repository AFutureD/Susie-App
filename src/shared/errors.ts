/** 错误 → 可读文案。全仓 `error instanceof Error ? error.message : String(error)` 惯用语的唯一归宿。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
