// src/core/watch.ts —— 磁盘变化的去抖器（纯逻辑，fs.watch 由调用方接）。
// goal.md §12.1：磁盘变化 → 去抖 300ms → 重扫 → agent.reload() → changed 事件。
//
// 为什么把去抖单独抽出来：fs.watch 在 Windows 上一次保存会连发多个事件，
// 直接把回调接到 watcher 上会重复 reload；而且真实 watcher 的时序不适合单测。
// 这里只做「合并事件 + 串行执行 + 错误隔离」，计时器可注入。

import { watch, mkdirSync } from "node:fs"
import type { FSWatcher } from "node:fs"

export interface ChangeDebouncerOptions {
  delayMs: number
  run: () => Promise<void>
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
  onError?: (error: unknown) => void
}

export interface ChangeDebouncer {
  /** 报告一次磁盘变化；多次调用在 delayMs 内只触发一次 run。 */
  trigger: () => void
  /** 等待当前排队/运行中的 run 结束（测试与清理时用）。 */
  settled: () => Promise<void>
  /** 取消待执行的回调并停止接收新的触发。 */
  dispose: () => void
}

export function createChangeDebouncer(options: ChangeDebouncerOptions): ChangeDebouncer {
  const schedule = options.setTimeout ?? setTimeout
  const cancel = options.clearTimeout ?? clearTimeout

  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let running: Promise<void> | null = null
  let rerun = false

  const report = (error: unknown) => {
    if (options.onError) options.onError(error)
    else console.error("[subagent-manager] change handling failed:", error)
  }

  const execute = () => {
    if (disposed) return
    if (running) {
      // 回调仍在跑：记下再来一次，等当前这次结束后补跑（不能吞掉变化）
      rerun = true
      return
    }
    running = (async () => {
      try {
        await options.run()
      } catch (error) {
        report(error)
      } finally {
        running = null
        if (rerun && !disposed) {
          rerun = false
          execute()
        }
      }
    })()
  }

  return {
    trigger() {
      if (disposed) return
      if (timer !== null) cancel(timer)
      timer = schedule(() => {
        timer = null
        execute()
      }, options.delayMs)
    },
    async settled() {
      // 等到没有待执行的计时器、也没有运行中的回调
      while (timer !== null || running !== null) {
        await (running ?? Promise.resolve())
        if (timer !== null) {
          // 还有排队中的计时器：让出一次微任务，由调用方的假时钟 flush 推进
          await Promise.resolve()
          if (timer !== null && running === null) break
        }
      }
    },
    dispose() {
      disposed = true
      rerun = false
      if (timer !== null) {
        cancel(timer)
        timer = null
      }
    },
  }
}

export interface AgentsWatcher {
  close: () => void
}

/**
 * 监听一个 agents 目录（递归），任何变化都交给去抖器。
 *
 * - 目录不存在时先创建（goal.md §0.4：项目级 agents/ 可能尚未存在）
 * - `recursive: true` 在 win32 与 darwin 可用；其他平台退化为非递归（顶层文件仍能监听）
 * - 创建/监听失败返回 null，由调用方决定是否降级，不抛错打断插件加载
 */
export function watchAgentsDir(
  dir: string,
  onChange: () => void,
  options: { delayMs?: number } = {},
): AgentsWatcher | null {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    console.error("[subagent-manager] cannot create agents dir:", dir, error)
    return null
  }

  const debouncer = createChangeDebouncer({
    delayMs: options.delayMs ?? 300,
    run: async () => { onChange() },
  })

  let watcher: FSWatcher
  try {
    watcher = watch(dir, { recursive: true }, () => debouncer.trigger())
  } catch {
    // 某些平台不支持 recursive，退化为非递归
    try {
      watcher = watch(dir, () => debouncer.trigger())
    } catch (error) {
      console.error("[subagent-manager] cannot watch agents dir:", dir, error)
      debouncer.dispose()
      return null
    }
  }

  // EventEmitter 的 'error' 事件未处理会直接抛崩进程；watcher 出错只记录并继续（第七轮审查）
  watcher.on("error", (error) => {
    console.error("[subagent-manager] agents watcher error:", dir, error)
  })

  return {
    close: () => {
      debouncer.dispose()
      // 只摘 change 监听、保留 error 处理器：removeAllListeners() 会把上面那个处理器一起摘掉，
      // 若 close 期间仍偶发 'error'，就会变成未处理事件直接崩进程（第七轮补充修复）。
      watcher.removeAllListeners("change")
      watcher.close()
    },
  }
}
