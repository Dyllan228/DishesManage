// 生成计时器到点的提示音，写成 assets/chime.wav。
//
// 为什么手写而不是塞一个 mp3 进来：这是 Web 版 D-010「手写 ZIP 而不是装依赖」的同一路数——
// 这段声音只有三个衰减正弦，二进制格式也就 44 字节头，手写比引一个音频资产更可解释，
// 而且这个文件可以随时重新生成、diff 得动（是脚本产物，不是不可名状的二进制）。
//
// 音色沿用 Web 版 Web Audio 的那三声「叮」：基频 880Hz（A5）叠一个 1320Hz（E6）的泛音，
// 指数衰减包络，三声间隔 120ms。
//
// 用法：node tools/gen-chime.mjs

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const SAMPLE_RATE = 44100
const BASE_HZ = 880
const OVERTONE_HZ = 1320
const OVERTONE_GAIN = 0.35 // 泛音比基频轻，否则会太尖
const DING_SECONDS = 0.18
const GAP_SECONDS = 0.12
const DING_COUNT = 3
const PEAK = 0.72 // 留点余量，避免 16bit 削顶

/** 一声「叮」的采样，指数衰减。 */
function ding() {
  const n = Math.round(DING_SECONDS * SAMPLE_RATE)
  const out = new Float64Array(n)
  // 衰减到 -60dB 所需时间取整段，听感上是干脆的一下而不是拖尾
  const decay = Math.log(1000) / n
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE
    const envelope = Math.exp(-decay * i)
    // 起音留 2ms 淡入，消掉爆音（直接切进正弦会在扬声器上「啪」一声）
    const attack = Math.min(1, t / 0.002)
    const wave =
      Math.sin(2 * Math.PI * BASE_HZ * t) +
      OVERTONE_GAIN * Math.sin(2 * Math.PI * OVERTONE_HZ * t)
    out[i] = PEAK * envelope * attack * wave
  }
  return out
}

function buildSamples() {
  const one = ding()
  const gap = new Float64Array(Math.round(GAP_SECONDS * SAMPLE_RATE))
  const total = (one.length + gap.length) * DING_COUNT - gap.length
  const samples = new Float64Array(total)
  let at = 0
  for (let d = 0; d < DING_COUNT; d++) {
    samples.set(one, at)
    at += one.length
    if (d < DING_COUNT - 1) {
      samples.set(gap, at)
      at += gap.length
    }
  }
  return samples
}

/** 44 字节 RIFF/WAVE 头 + 16bit 单声道 PCM 数据。 */
function toWav(samples) {
  const dataBytes = samples.length * 2
  const buf = Buffer.alloc(44 + dataBytes)

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4) // 整个文件长度 - 8
  buf.write('WAVE', 8, 'ascii')

  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt 块长度
  buf.writeUInt16LE(1, 20) // 1 = PCM
  buf.writeUInt16LE(1, 22) // 声道数
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28) // 字节率 = 采样率 × 声道 × 位深/8
  buf.writeUInt16LE(2, 32) // 块对齐
  buf.writeUInt16LE(16, 34) // 位深

  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)

  for (let i = 0; i < samples.length; i++) {
    // 夹紧再取整：Float64 里理论上可能略超 ±1
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2)
  }
  return buf
}

const samples = buildSamples()
const wav = toWav(samples)

const outDir = resolve(HERE, '..', 'assets')
mkdirSync(outDir, { recursive: true })
const outPath = resolve(outDir, 'chime.wav')
writeFileSync(outPath, wav)

const seconds = samples.length / SAMPLE_RATE
console.log(`已写出 ${outPath}`)
console.log(`  ${wav.length} 字节 / ${seconds.toFixed(3)} 秒 / ${SAMPLE_RATE}Hz 16bit 单声道`)
console.log(`  ${DING_COUNT} 声 ${BASE_HZ}Hz+${OVERTONE_HZ}Hz`)
