import { watch, type FSWatcher } from 'chokidar'
import type { ConfigStore } from './store'

/**
 * 监听 config.toml 的外部修改并触发 store 热加载。
 * awaitWriteFinish 兼容编辑器的分段写入；自写回环由 store 的内容 hash 抑制。
 */
export function watchConfigFile(store: ConfigStore): FSWatcher {
  const watcher = watch(store.configPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  })

  let timer: NodeJS.Timeout | null = null
  const trigger = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => store.reloadFromDisk(), 150)
  }

  watcher.on('add', trigger)
  watcher.on('change', trigger)
  watcher.on('unlink', trigger)

  return watcher
}
