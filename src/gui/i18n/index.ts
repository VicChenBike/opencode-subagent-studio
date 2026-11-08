// src/gui/i18n/index.ts —— 聚合所有语言词典，导出宿主 catalog。
// en 必填（宿主兜底）：宿主按 `i18n.en ?? {}` 读取 en，并用 en 填充其他语言缺失的键
// （官方 GUI 文档：Write every locale inline; English fills every key a locale lacks），
// 因此本目录只注册各语言自己的词典，不手工合并。宿主没有区域回退链，catalog 键必须是
// 宿主界面语言的精确短码（zh / fr / es / br / ru / ar / de / ja / hi / ko）。
// import 带显式 .ts 扩展名：测试经 node --experimental-strip-types 加载本模块，要求显式扩展。
import { en } from "./en.ts"
import { zh } from "./zh.ts"
import { fr } from "./fr.ts"
import { es } from "./es.ts"
import { br } from "./br.ts"
import { ru } from "./ru.ts"
import { ar } from "./ar.ts"
import { de } from "./de.ts"
import { ja } from "./ja.ts"
import { hi } from "./hi.ts"
import { ko } from "./ko.ts"

export const catalog = {
  en,
  // 三个中文键指向同一份词典：zh 是宿主实际查找的短码键；
  // zh-Hans / zh-CN 是兼容别名，保留无害
  "zh-Hans": zh,
  zh,
  "zh-CN": zh,
  // 新增语言一律只注册宿主短码键（br = 宿主唯一的葡萄牙语选项 pt-BR）
  fr,
  es,
  br,
  ru,
  ar,
  de,
  ja,
  hi,
  ko,
} as const
