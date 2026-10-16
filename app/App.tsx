// A0 · 工具链验尸
//
// 这个文件不是应用的一部分，是一次性的体检报告。它存在的理由：
// 我看不见真机屏幕，而 A0 要在**任何业务代码落地之前**一次性回答掉
// 「这套工具链到底行不行」。所以它把每一个未知项都跑一遍、把**实测值**打在屏幕上，
// 失败了也不中断（每项独立 try/catch）——好处是用户装一次 APK，
// 就能把整张单子带回来，而不是一次只暴露一个错误。
//
// 体检通过后，本文件会被真正的应用（src/App.tsx）取代。
//
// 所有 API 签名都是对着 node_modules 里的 .d.ts 核过的，不是凭记忆写的。

import './global.css'

import { useCallback, useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, Vibration, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'

import * as SQLite from 'expo-sqlite'
import * as Crypto from 'expo-crypto'
import { Directory, File, Paths } from 'expo-file-system'
import * as Notifications from 'expo-notifications'
import { createAudioPlayer } from 'expo-audio'
import * as Clipboard from 'expo-clipboard'
import * as ImagePicker from 'expo-image-picker'
import { ImageManipulator } from 'expo-image-manipulator'
import * as Sharing from 'expo-sharing'
import { Image } from 'expo-image'

import chimeSource from './assets/chime.wav'

/** SHA-256("abc") —— NIST 的经典测试向量，用来确认摘要实现没跑偏。 */
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

const DB_NAME = 'a0-smoke.db'

type Check = {
  name: string
  ok: boolean
  detail: string
}

/** 把任意抛出来的东西压成一行短文本。 */
function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Report />
    </SafeAreaProvider>
  )
}

function Report() {
  const insets = useSafeAreaInsets()
  const [checks, setChecks] = useState<Check[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string>('')

  const run = useCallback(async () => {
    setBusy(true)
    const out: Check[] = []
    // 每项独立 try/catch：一项炸掉不该让整张单子变成空白。
    const check = async (name: string, fn: () => Promise<string> | string) => {
      try {
        out.push({ name, ok: true, detail: await fn() })
      } catch (e) {
        out.push({ name, ok: false, detail: errText(e) })
      }
    }

    // ---- 1. TextEncoder：Hermes 上到底有没有（zip.ts / xlsx.ts 靠它） ----
    // 绕开 globalThis 取，是为了不依赖 tsc 这边装了哪套 lib——DOM 的 lib 里有
    // TextEncoder 声明、纯 RN 的 lib 里没有，直接写标识符会让类型检查随 tsconfig 飘。
    const TextEncoderCtor = (
      globalThis as {
        TextEncoder?: new () => { encode(input: string): Uint8Array }
      }
    ).TextEncoder

    await check('TextEncoder 存在', () => {
      if (typeof TextEncoderCtor !== 'function') throw new Error('undefined')
      return 'globalThis.TextEncoder 是个构造函数'
    })
    await check('TextEncoder 编码 UTF-8', () => {
      if (typeof TextEncoderCtor !== 'function') throw new Error('不存在，跳过')
      const bytes = new TextEncoderCtor().encode('中文')
      // 「中文」两个汉字 UTF-8 各 3 字节
      if (bytes.length !== 6) throw new Error(`长度是 ${bytes.length}，应当是 6`)
      return `"中文".length=${bytes.length} ✓  [${Array.from(bytes).join(',')}]`
    })

    // ---- 2. SQLite：建库、建表、写、读、事务 ----
    let db: SQLite.SQLiteDatabase | null = null
    await check('SQLite 打开数据库', async () => {
      db = await SQLite.openDatabaseAsync(DB_NAME)
      return `openDatabaseAsync("${DB_NAME}") ok`
    })
    await check('SQLite 建表 + 写入 + 读回', async () => {
      if (!db) throw new Error('数据库没打开')
      await db.execAsync('DROP TABLE IF EXISTS t')
      await db.execAsync(
        'CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)'
      )
      await db.runAsync("INSERT INTO t (id, data) VALUES (?, ?)", [
        'k1',
        JSON.stringify({ 菜名: '土豆炖排骨', n: 3 }),
      ])
      const row = await db.getFirstAsync<{ data: string }>(
        'SELECT data FROM t WHERE id = ?',
        ['k1']
      )
      if (!row) throw new Error('没读回任何行')
      const parsed = JSON.parse(row.data) as { 菜名: string; n: number }
      if (parsed.菜名 !== '土豆炖排骨') throw new Error('中文往返坏了')
      return `中文 JSON 往返 ok: ${parsed.菜名} ×${parsed.n}`
    })
    await check('SQLite 排他事务', async () => {
      if (!db) throw new Error('数据库没打开')
      // 这是存储门面的核心：事务内所有查询都必须走 txn 对象。
      await db.withExclusiveTransactionAsync(async (txn) => {
        await txn.runAsync("INSERT INTO t (id, data) VALUES (?, ?)", [
          'tx1',
          JSON.stringify({ inTxn: true }),
        ])
        const r = await txn.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM t')
        if (!r || r.c < 2) throw new Error(`事务里只看到 ${r?.c} 行`)
      })
      return 'withExclusiveTransactionAsync ok（txn 可 runAsync/getFirstAsync）'
    })
    await check('SQLite 数据库落在文档目录', async () => {
      const dir = new Directory(Paths.document, 'SQLite')
      const files = dir.list().map((f) => f.uri.split('/').pop())
      return files.join(', ') || '（目录为空？）'
    })
    // 关掉再打开，确认数据是真的落到手机存储里了，不是内存里假象
    await check('SQLite 关库重开后数据仍在', async () => {
      if (!db) throw new Error('数据库没打开')
      await db.closeAsync()
      const again = await SQLite.openDatabaseAsync(DB_NAME)
      const r = await again.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM t')
      db = again
      if (!r || r.c < 3) throw new Error(`重开后只剩 ${r?.c} 行`)
      return `重开后 ${r.c} 行 —— 数据确实在手机存储里`
    })

    // ---- 3. Crypto：字符串摘要 + 文件字节摘要 ----
    await check('Crypto SHA-256(字符串)', async () => {
      const hex = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        'abc'
      )
      if (hex.toLowerCase() !== SHA256_ABC) throw new Error(`得到 ${hex}`)
      return '与 NIST 测试向量一致'
    })
    await check('文件读写 + 字节摘要', async () => {
      const f = new File(Paths.document, 'a0-probe.txt')
      if (f.exists) f.delete()
      f.create()
      f.write('abc')
      const back = await f.text()
      if (back !== 'abc') throw new Error(`读回的是 ${JSON.stringify(back)}`)
      // 走 bytes() → digest()，也就是**不经过 base64 往返**的那条路
      const bytes = await f.bytes()
      const buf = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes)
      const hex = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      if (hex !== SHA256_ABC) throw new Error(`文件字节摘要得到 ${hex}`)
      const size = f.size
      f.delete()
      return `write/text/bytes/size 全通，size=${size}，字节摘要与向量一致`
    })

    // ---- 4. 通知：渠道必须先建，权限弹窗才会出现 ----
    await check('通知渠道 + 权限申请', async () => {
      await Notifications.setNotificationChannelAsync('timer', {
        name: '计时提醒',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [220, 120, 220, 120, 400],
      })
      const perm = await Notifications.requestPermissionsAsync()
      return `渠道已建；granted=${perm.granted} status=${perm.status}`
    })

    // ---- 5. 原生模块是否都真的链进来了 ----
    await check('原生模块注册检查', () => {
      const missing: string[] = []
      if (typeof SQLite.openDatabaseAsync !== 'function') missing.push('expo-sqlite')
      if (typeof Crypto.digestStringAsync !== 'function') missing.push('expo-crypto')
      if (typeof createAudioPlayer !== 'function') missing.push('expo-audio')
      if (typeof Clipboard.setStringAsync !== 'function') missing.push('expo-clipboard')
      if (typeof ImagePicker.launchImageLibraryAsync !== 'function')
        missing.push('expo-image-picker')
      if (typeof Sharing.shareAsync !== 'function') missing.push('expo-sharing')
      if (typeof ImageManipulator.manipulate !== 'function')
        missing.push('expo-image-manipulator')
      if (typeof File !== 'function') missing.push('expo-file-system')
      if (!Image) missing.push('expo-image')
      if (missing.length) throw new Error(`缺失：${missing.join(', ')}`)
      return 'sqlite/crypto/audio/clipboard/图片选择/分享/图像处理/文件系统 全部就位'
    })

    // ---- 6. 提示音资源能否被 require 进来 ----
    await check('提示音资源已打包', () => {
      if (chimeSource == null) throw new Error('chime.wav 解析为 null')
      return `assets/chime.wav → ${typeof chimeSource} ${String(chimeSource)}`
    })

    setChecks(out)
    setBusy(false)
  }, [])

  useEffect(() => {
    void run()
  }, [run])

  const failed = checks.filter((c) => !c.ok).length

  return (
    <View style={{ flex: 1, backgroundColor: '#fafaf9' }}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 16,
        }}
      >
        <Text className="text-2xl font-bold text-stone-900">家庭私厨 · A0 体检</Text>
        <Text className="mt-1 text-sm text-stone-500">
          中文渲染正常 / 安全区 top={insets.top} bottom={insets.bottom}
          {insets.left || insets.right ? ` 左=${insets.left} 右=${insets.right}` : ''}
        </Text>

        {/* NativeWind：这一块应该是**橙色圆角**底。若是透明/灰白，说明 NativeWind 没生效 */}
        <View className="mt-4 rounded-xl bg-brand-500 p-4">
          <Text className="text-white font-semibold">
            NativeWind 检查：这块应当是橙色圆角
          </Text>
        </View>

        <AnimatedBox />

        <Text className="mt-6 mb-2 text-lg font-semibold text-stone-800">
          体检结果 {checks.length > 0 ? `(${checks.length - failed}/${checks.length} 通过)` : ''}
        </Text>

        {checks.map((c) => (
          <View
            key={c.name}
            className="mb-2 rounded-lg border border-stone-200 bg-white p-3"
          >
            <Text className={c.ok ? 'text-stone-900 font-semibold' : 'text-red-700 font-semibold'}>
              {c.ok ? '✓' : '✗'} {c.name}
            </Text>
            <Text className="mt-1 text-xs text-stone-600">{c.detail}</Text>
          </View>
        ))}

        {busy && <Text className="mt-2 text-stone-500">跑着呢…</Text>}

        <View className="mt-6 gap-3">
          <Btn
            label="震动一下（应有 2 短 1 长）"
            onPress={() => {
              Vibration.vibrate([220, 120, 220, 120, 400])
              setNote('已触发震动')
            }}
          />
          <Btn
            label="播提示音（应有三声叮）"
            onPress={() => {
              try {
                const player = createAudioPlayer(chimeSource)
                player.play()
                setNote('已播放；3 秒后释放')
                setTimeout(() => player.remove(), 3000)
              } catch (e) {
                setNote(`播放失败：${errText(e)}`)
              }
            }}
          />
          <Btn
            label="排一条 10 秒后的通知（切后台看是否弹出）"
            onPress={() => {
              void (async () => {
                try {
                  await Notifications.scheduleNotificationAsync({
                    content: { title: '计时结束', body: 'A0 通知通道测试' },
                    trigger: {
                      type: Notifications.SchedulableTriggerInputTypes.DATE,
                      date: new Date(Date.now() + 10_000),
                      channelId: 'timer',
                    },
                  })
                  setNote('已排期 10 秒后；请按 Home 键切到后台')
                } catch (e) {
                  setNote(`排期失败：${errText(e)}`)
                }
              })()
            }}
          />
          <Btn
            label="复制一段中文到剪贴板"
            onPress={() => {
              void (async () => {
                await Clipboard.setStringAsync('家庭私厨 A0 剪贴板测试')
                setNote('已复制，去别处粘贴试试')
              })()
            }}
          />
          <Btn label="重跑一遍体检" onPress={() => void run()} />
        </View>

        {note ? <Text className="mt-4 text-brand-700">{note}</Text> : null}

        <Text className="mt-8 text-xs text-stone-400">
          这一屏是 A0 的一次性体检，通过后会被真正的应用取代。
        </Text>
      </ScrollView>
    </View>
  )
}

/** Reanimated 是否真的在驱动动画：这块应当持续呼吸。 */
function AnimatedBox() {
  const v = useSharedValue(1)
  useEffect(() => {
    v.value = withRepeat(withTiming(0.25, { duration: 900 }), -1, true)
  }, [v])
  const style = useAnimatedStyle(() => ({ opacity: v.value }))
  return (
    <Animated.View
      style={style}
      className="mt-3 rounded-xl bg-stone-800 p-4"
    >
      <Text className="text-white">
        Reanimated 检查：这块应当持续明暗呼吸
      </Text>
    </Animated.View>
  )
}

function Btn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="rounded-xl bg-stone-200 px-4 py-3 active:bg-stone-300"
    >
      <Text className="text-center text-stone-900">{label}</Text>
    </Pressable>
  )
}
