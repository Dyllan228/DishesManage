// 本机 config plugin：把 Gradle 的堆内存调大。
//
// 为什么需要它——`expo-build-properties` 能改 compileSdk / buildArchs / cmakeVersion 等
// 十几项 gradle.properties，但**没有** org.gradle.jvmargs 这一项（实测
// node_modules/expo-build-properties/build/android.js 里的 propName 清单）。
// 而 RN 模板给的是 `-Xmx2048m -XX:MaxMetaspaceSize=512m`：React Native 0.86 的
// 新架构要跑 CMake + Kotlin，2GB 堆 + 512MB 元空间是常见的 OOM 点。
//
// 那为什么不直接去改 android/gradle.properties？因为这正是我们选 CNG 的理由：
// 那份文件是 `expo prebuild` 的**产物**，`prebuild --clean` 会把它重置回模板值，
// 手工改动会静默消失。写成 config plugin，才是声明式的、prebuild 之后依然成立的。

const { withGradleProperties } = require('expo/config-plugins')

const JVM_ARGS = '-Xmx4096m -XX:MaxMetaspaceSize=1024m'

module.exports = function withGradleMemory(config) {
  return withGradleProperties(config, (cfg) => {
    const items = cfg.modResults
    const existing = items.find(
      (item) => item.type === 'property' && item.key === 'org.gradle.jvmargs'
    )
    if (existing) {
      existing.value = JVM_ARGS
    } else {
      items.push({ type: 'property', key: 'org.gradle.jvmargs', value: JVM_ARGS })
    }
    return cfg
  })
}
