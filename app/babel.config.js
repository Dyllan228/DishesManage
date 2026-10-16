// NativeWind v4 的 JSX 转换，加上 Reanimated/Worklets 的转换，两件事都在 babel 这一层接。
//
// 关于 `reanimated: false`——这是个必须显式处理的重复注册问题，不是随手写的开关：
//
//   1. Expo SDK 57 的 babel-preset-expo 在检测到 react-native-worklets 时会**自动**挂上
//      `react-native-worklets/plugin`（见
//      node_modules/expo/node_modules/babel-preset-expo/build/configs/expo.js:97-101）。
//   2. 而 NativeWind 官方文档让你把 `nativewind/babel` 也放进 presets，它内部是
//      `react-native-css-interop/babel`，其中又硬编码了 `"react-native-reanimated/plugin"`。
//   3. 在 Reanimated 4 里，`react-native-reanimated/plugin` 只是一个转发：
//      `module.exports = require('react-native-worklets/plugin')`（实测 node_modules/react-native-reanimated/index.js）。
//
// 也就是说按官方文档原样写，**同一个 babel 插件会被注册两次**。
// 所以这里把 preset 那一路显式关掉（options.reanimated === false 会让 expo.js 的两个分支
// 都不命中），只留 NativeWind 这一路提供 worklets 转换——结果恰好各一次。
module.exports = function (api) {
  api.cache(true)
  return {
    presets: [
      ['babel-preset-expo', { jsxImportSource: 'nativewind', reanimated: false }],
      'nativewind/babel',
    ],
  }
}
