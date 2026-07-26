import { app } from 'electron'
import { App } from './app'

// 测试/冒烟隔离：userData 可被环境变量覆盖（须在单实例锁之前设置——锁按 userData 计算）
const userDataOverride = process.env['SUSIE_USER_DATA_DIR']
if (userDataOverride && userDataOverride !== '') {
  app.setPath('userData', userDataOverride)
}

// 同一 userData 只允许一个实例（双开会导致 Telegram polling 409 互踢）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  new App().bootstrap()
}
