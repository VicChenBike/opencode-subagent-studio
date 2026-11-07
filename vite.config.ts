import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// entry 显式指向 src/gui/gui.tsx：gui() 的默认值是 src/gui.tsx（§0.1-2），
// 而 §1.3 的模块布局把 GUI 入口放在 src/gui/gui.tsx。
export default defineConfig({ plugins: [gui({ entry: "src/gui/gui.tsx" })] })
