// src/gui/i18n/index.ts —— 聚合所有语言词典，导出宿主 catalog。
// en 必填（宿主兜底）：宿主按 `i18n.en ?? {}` 读取 en，其他语言按 {...en, ...locale}
// 合并注册，缺键自动回退 en。宿主没有区域回退链，catalog 键必须是宿主界面语言的
// 精确短码（zh / fr / es / br / ru / ar / de / ja / hi / ko）。
// import 带显式 .ts 扩展名：测试经 node --experimental-strip-types 加载本模块，要求显式扩展。
import { en } from "./en.ts"
import { zh } from "./zh.ts"

export const catalog = {
  en,
  // 三个中文键指向同一份词典：zh 是宿主实际查找的短码键；
  // zh-Hans / zh-CN 是兼容别名，保留无害
  "zh-Hans": zh,
  zh,
  "zh-CN": zh,
} as const
