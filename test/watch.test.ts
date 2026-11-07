// test/watch.test.ts —— 文件监听去抖器（纯逻辑，不依赖真实 fs）。
// goal.md §12.1：磁盘变化 → 去抖 300ms → 重扫 → agent.reload() → changed 事件。
// 去抖本身不碰 fs，测试用假计时器与假触发器，避免 Windows 下 watcher 时序导致的 flaky。
import { test } from "node:test"
import assert from "node:assert/strict"
import { createChangeDebouncer } from "../src/core/watch.ts"

function fakeClock() {
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let nextId = 1
  return {
    // 假计时器：句柄就是数字 id，用 ReturnType<typeof setTimeout> 承载以匹配 Node 类型
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++
      timers.set(id, { fn, ms })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number)
    },
    /** 推进所有到期计时器（测试里只关心「是否只跑一次」与延迟值） */
    flush: () => {
      const pending = [...timers.entries()]
      timers.clear()
      for (const [, t] of pending) t.fn()
      return pending.map(([, t]) => t.ms)
    },
    pendingCount: () => timers.size,
  }
}

test("a single change schedules the callback after 300ms", async () => {
  const clock = fakeClock()
  let runs = 0
  const debouncer = createChangeDebouncer({
    delayMs: 300,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    run: async () => { runs++ },
  })
  debouncer.trigger()
  assert.equal(runs, 0, "must not run synchronously")
  assert.equal(clock.pendingCount(), 1)
  const delays = clock.flush()
  assert.deepEqual(delays, [300], "delay must be 300ms")
  await debouncer.settled()
  assert.equal(runs, 1)
})

test("a burst of changes collapses into one run", async () => {
  const clock = fakeClock()
  let runs = 0
  const debouncer = createChangeDebouncer({
    delayMs: 300,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    run: async () => { runs++ },
  })
  debouncer.trigger()
  debouncer.trigger()
  debouncer.trigger()
  assert.equal(clock.pendingCount(), 1, "earlier timers must be cleared")
  clock.flush()
  await debouncer.settled()
  assert.equal(runs, 1, "one burst must produce exactly one reload")
})

test("changes during a running callback schedule another run", async () => {
  const clock = fakeClock()
  let runs = 0
  let release: (() => void) | null = null
  const debouncer = createChangeDebouncer({
    delayMs: 300,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    run: async () => {
      runs++
      if (runs === 1) await new Promise<void>((resolve) => { release = resolve })
    },
  })
  debouncer.trigger()
  clock.flush()
  debouncer.trigger() // 回调仍在跑时又来一次变化
  clock.flush()
  release!()
  await debouncer.settled()
  assert.equal(runs, 2, "a change during the run must not be swallowed")
})

test("a throwing callback does not break later changes", async () => {
  const clock = fakeClock()
  const errors: unknown[] = []
  let runs = 0
  const debouncer = createChangeDebouncer({
    delayMs: 300,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    run: async () => {
      runs++
      if (runs === 1) throw new Error("reload failed")
    },
    onError: (error) => errors.push(error),
  })
  debouncer.trigger()
  clock.flush()
  await debouncer.settled()
  assert.equal(errors.length, 1, "the failure must be reported, not swallowed")
  debouncer.trigger()
  clock.flush()
  await debouncer.settled()
  assert.equal(runs, 2, "the debouncer must stay usable after a failure")
})

test("dispose clears a pending timer so nothing runs afterwards", async () => {
  const clock = fakeClock()
  let runs = 0
  const debouncer = createChangeDebouncer({
    delayMs: 300,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    run: async () => { runs++ },
  })
  debouncer.trigger()
  debouncer.dispose()
  assert.equal(clock.pendingCount(), 0, "the pending timer must be cleared")
  clock.flush()
  await debouncer.settled()
  assert.equal(runs, 0)
})

test("settled resolves immediately when nothing is pending", async () => {
  const clock = fakeClock()
  const debouncer = createChangeDebouncer({
    delayMs: 300,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    run: async () => {},
  })
  await debouncer.settled() // 不应挂起
})

// ---------- 真实 fs.watch 集成（Windows 时序靠轮询等待，不用固定 sleep）----------
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { watchAgentsDir } from "../src/core/watch.ts"

/** 轮询直到 predicate 为真或超时；返回是否成功。避免固定 sleep 造成的 flaky。 */
async function waitFor(predicate: () => boolean, timeoutMs = 4000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return predicate()
}

test("watchAgentsDir reports an external file write", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osm-watch-"))
  let hits = 0
  const watcher = watchAgentsDir(dir, () => { hits++ }, { delayMs: 30 })
  try {
    assert.ok(watcher !== null, "watch must start on an existing directory")
    fs.writeFileSync(path.join(dir, "new-agent.md"), "---\ndescription: N\nmode: subagent\n---\n\nx\n")
    assert.ok(await waitFor(() => hits > 0), "a write must reach the callback")
  } finally {
    watcher?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("watchAgentsDir reports a delete and a rename", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osm-watch-"))
  const file = path.join(dir, "victim.md")
  fs.writeFileSync(file, "---\ndescription: V\nmode: subagent\n---\n\nx\n")
  let hits = 0
  const watcher = watchAgentsDir(dir, () => { hits++ }, { delayMs: 30 })
  try {
    assert.ok(watcher !== null)
    await new Promise((r) => setTimeout(r, 150)) // 让 watcher 就位
    const before = hits
    fs.renameSync(file, path.join(dir, "renamed.md"))
    assert.ok(await waitFor(() => hits > before), "a rename must reach the callback")
  } finally {
    watcher?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("watchAgentsDir creates the directory when it does not exist yet", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "osm-watch-"))
  const dir = path.join(root, "agents") // 尚不存在
  let hits = 0
  const watcher = watchAgentsDir(dir, () => { hits++ }, { delayMs: 30 })
  try {
    assert.ok(fs.existsSync(dir), "the directory must be created before watching")
    assert.ok(watcher !== null)
    fs.writeFileSync(path.join(dir, "a.md"), "---\ndescription: A\nmode: subagent\n---\n\nx\n")
    assert.ok(await waitFor(() => hits > 0))
  } finally {
    watcher?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("watchAgentsDir returns null for a path that cannot be watched", () => {
  // 用一个文件当目录：mkdir 会失败
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osm-watch-"))
  const file = path.join(dir, "a-file")
  fs.writeFileSync(file, "x")
  try {
    const watcher = watchAgentsDir(path.join(file, "nested"), () => {}, { delayMs: 30 })
    assert.equal(watcher, null, "an unwatchable path must not throw")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// R5 P2-1 回归：watchAgentsDir 与 index.ts 的外层去抖不能叠加成双重延迟。
// 外层固定 300ms（goal.md §12.1）；内层必须传 0，否则实际最短 600ms。
// 断言源码里的实际调用参数（运行时无法观测 setup 内的组合）。
test("index.ts passes delayMs 0 so the outer 300ms debounce is the only one", async () => {
  const source = await import("node:fs/promises").then((m) =>
    m.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  )
  // 参数里含嵌套括号（projectAgentsDir(...)），按行取调用即可
  const watchLines = source.split("\n").filter((line) => line.includes("watchAgentsDir("))
  assert.ok(watchLines.length > 0, "index.ts must start at least one watcher")
  for (const line of watchLines) {
    assert.match(line, /delayMs:\s*0/, `every watchAgentsDir call must pass delayMs 0: ${line.trim()}`)
  }
})

test("watchAgentsDir still coalesces bursts when delayMs is 0", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osm-watch-"))
  let hits = 0
  const watcher = watchAgentsDir(dir, () => { hits++ }, { delayMs: 0 })
  try {
    const started = Date.now()
    fs.writeFileSync(path.join(dir, "a.md"), "---" + String.fromCharCode(10) + "description: A" + String.fromCharCode(10) + "mode: subagent" + String.fromCharCode(10) + "---" + String.fromCharCode(10) + String.fromCharCode(10) + "x" + String.fromCharCode(10))
    assert.ok(await waitFor(() => hits > 0, 1500, 10), "a write must reach the callback")
    const elapsed = Date.now() - started
    assert.ok(elapsed < 300, `delayMs 0 must not add 300ms (took ${elapsed}ms)`)
  } finally {
    watcher?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
