import type { SusieBridge } from '../../shared/ipc'

declare global {
  interface Window {
    susie: SusieBridge
  }
}

export {}
