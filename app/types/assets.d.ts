// 让 tsc 认识 `import chime from './assets/chime.wav'`。
//
// Metro 在打包时会把资产解析成一个数字 id（或对象），而 tsc 只看声明。
// Expo 生成的 expo-env.d.ts 通常也会声明这些，但那个文件是 `expo start`/`prebuild`
// 生成的、且被 .gitignore 忽略——靠它的话，一次干净检出就会类型报错。
// 所以这里显式声明，不依赖生成物。

declare module '*.wav' {
  const asset: number
  export default asset
}

// `import './global.css'` 是副作用导入：Metro 侧由 withNativeWind 接管编译，
// 但 tsc 这边需要一个声明，否则 TS 6.0 会直接报 TS2882。
// NativeWind 的 types.d.ts 只声明了组件的 className，没声明样式模块。
declare module '*.css' {
  const content: unknown
  export default content
}
