/** 指数退避（无抖动；单通道单飞不需要） */
export class Backoff {
  private readonly baseMs: number
  private readonly capMs: number
  private current: number

  constructor(baseMs: number, capMs: number) {
    this.baseMs = baseMs
    this.capMs = capMs
    this.current = baseMs
  }

  next(): number {
    const value = this.current
    this.current = Math.min(this.current * 2, this.capMs)
    return value
  }

  reset(): void {
    this.current = this.baseMs
  }
}
