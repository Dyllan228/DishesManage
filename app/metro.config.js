const { getDefaultConfig } = require('expo/metro-config')
const { withNativeWind } = require('nativewind/metro')

// withNativeWind 负责两件事：把 global.css 编译成 RN 能吃的样式表，
// 并让 Metro 在解析 className 时走 NativeWind 的运行时。
// 不写 alias 块——Metro 认 tsconfig.json 的 paths，`@/*` 开箱可用。
const config = getDefaultConfig(__dirname)

module.exports = withNativeWind(config, { input: './global.css' })
