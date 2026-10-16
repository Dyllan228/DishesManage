/**
 * 核心数据模型
 *
 * 约定（见 docs/决策记录.md D-002）：
 * - 所有实体都带 id / createdAt / updatedAt，为 V2 云端同步预留
 * - 时间戳统一用毫秒数（number），便于 IndexedDB 索引与排序
 * - 软删除用 deletedAt（null 表示未删除）
 */

export type ID = string
export type Timestamp = number

/** 所有可持久化实体的公共字段 */
export interface BaseEntity {
  id: ID
  createdAt: Timestamp
  updatedAt: Timestamp
}

// ---------------------------------------------------------------------------
// 菜谱
// ---------------------------------------------------------------------------

/** 食材行类型：主料 / 调料 */
export type IngredientKind = 'main' | 'seasoning'

/** 难度：1 简单 / 2 中等 / 3 较难 */
export type Difficulty = 1 | 2 | 3

/** 菜谱来源：手动录入 / 粘贴解析 / 链接抓取（V2） */
export type SourceType = 'manual' | 'paste' | 'url'

/** 菜谱内的食材行（FR-1.2） */
export interface Ingredient extends BaseEntity {
  recipeId: ID
  kind: IngredientKind
  /** 显示名，如「排骨」 */
  name: string
  /** 归一化后的标准食材 ID，用于备菜清单合并（FR-3.12）；未识别时为 null */
  normalizedId: ID | null
  /** 数值用量；null 表示「适量」「少许」这类不可量化的情况 */
  amount: number | null
  /** 原文用量文本，如「适量」「两把」；amount 为 null 时用它展示 */
  amountText: string | null
  /** 单位，如「g」「勺」；无单位为 null */
  unit: string | null
  /** 备注，如「切块」 */
  note: string | null
  order: number
}

/** 制作步骤（FR-1.4） */
export interface Step extends BaseEntity {
  recipeId: ID
  order: number
  text: string
  /** 步骤配图（FR-1.22），M5 实现 */
  imageBlobId: ID | null
  /** 该步骤蕴含的时长（秒），用于一键启动倒计时（FR-3.23） */
  timerSec: number | null
  /** 计时器名称，如「腌制」 */
  timerLabel: string | null
}

/** 制作笔记（FR-3.26） */
export interface Note extends BaseEntity {
  recipeId: ID
  text: string
  /** 关联的制作日期 YYYY-MM-DD */
  cookedOn: string | null
}

export interface Recipe extends BaseEntity {
  name: string
  /** 封面图 Blob 外键（FR-1.21），M5 实现 */
  coverBlobId: ID | null
  intro: string | null
  /** 主分类，唯一归属（FR-2.2） */
  categoryId: ID
  /** 冗余的标签 ID 列表（FR-2.8） */
  tagIds: ID[]
  /** 基准份量（几人份） */
  servings: number
  /** 预计耗时（分钟） */
  durationMin: number | null
  difficulty: Difficulty
  sourceType: SourceType
  /** 原始粘贴文本（FR-1.15） */
  sourceText: string | null
  tips: string | null
  favorite: boolean
  cookCount: number
  lastCookedAt: Timestamp | null
  /** 平均评分 1-5 */
  rating: number | null
  /** 软删除（FR-5.8），null 表示未删除 */
  deletedAt: Timestamp | null
}

/** 菜谱详情（聚合） */
export interface RecipeDetail {
  recipe: Recipe
  ingredients: Ingredient[]
  steps: Step[]
  notes: Note[]
}

/** 新建/编辑菜谱时提交的表单数据 */
export interface RecipeDraft {
  name: string
  intro: string | null
  categoryId: ID
  tagIds: ID[]
  servings: number
  durationMin: number | null
  difficulty: Difficulty
  sourceType: SourceType
  sourceText: string | null
  tips: string | null
  ingredients: Array<Omit<Ingredient, keyof BaseEntity | 'recipeId'>>
  steps: Array<Omit<Step, keyof BaseEntity | 'recipeId'>>
}

// ---------------------------------------------------------------------------
// 分类与标签
// ---------------------------------------------------------------------------

/** 分类树节点（自关联，FR-2.3 支持无限层级，UI 建议不超 3 层） */
export interface Category extends BaseEntity {
  name: string
  parentId: ID | null
  order: number
  icon: string | null
  /** 系统保留节点（「未分类」）不可删除（FR-2.7） */
  isSystem: boolean
}

/** 标签维度（FR-2.9；cuisine 为 v1.1 决议 Q3 新增） */
export type TagDimension =
  | 'cuisine' // 菜系
  | 'taste' // 口味
  | 'method' // 烹饪方式
  | 'scene' // 场景
  | 'diet' // 人群/忌口
  | 'custom' // 自定义

export interface Tag extends BaseEntity {
  /** name + dimension 组合唯一 */
  name: string
  dimension: TagDimension
  color: string | null
  /** 使用频次，用于清理 0 使用标签（FR-2.12） */
  usageCount: number
}

// ---------------------------------------------------------------------------
// 今日菜单（FR-3.1 ~ FR-3.9）
// ---------------------------------------------------------------------------

/** 菜品制作状态机（FR-3.30） */
export type MenuItemStatus = 'todo' | 'prepping' | 'cooking' | 'done'

/** 今日菜单中的一道菜（对应外卖的购物车行） */
export interface MenuItem extends BaseEntity {
  recipeId: ID
  /** 份量倍率，0.5 ~ 5，步进 0.5（FR-3.3） */
  multiplier: number
  order: number
  /** 预计开始时间（当天 HH:mm）（FR-3.6） */
  plannedStartAt: string | null
  status: MenuItemStatus
}

// ---------------------------------------------------------------------------
// 备菜清单（FR-3.10 ~ FR-3.20）
// ---------------------------------------------------------------------------

/** 清单分组（FR-3.13） */
export type ShoppingCategory = 'meat' | 'veg' | 'staple' | 'seasoning' | 'other'

/** 家里有没有（FR-3.15） */
export type StockStatus = 'have' | 'need' | 'missing'

/**
 * 备菜清单条目
 *
 * 设计说明（D-003）：清单本身是**派生数据**（由今日菜单实时合并算出），
 * 但用户的勾选/库存状态必须持久化（FR-3.14）。因此这里用一张表同时承载两者：
 * - 派生行：id = `${date}|${itemKey}` 确定性生成，每次重算时 upsert 内容、
 *   保留 checked / stockStatus / isManual
 * - 手动追加行（FR-3.19）：isManual = true，重算时跳过，永不被覆盖
 */
export interface ShoppingItem extends BaseEntity {
  /** YYYY-MM-DD，一天一张清单 */
  date: string
  /** 合并桶的稳定键（食材归一化 id + 单位），用于跨重算匹配回勾选状态 */
  itemKey: string
  /** 显示名，如「番茄」 */
  name: string
  /** 归一化标准食材 ID（FR-3.12） */
  normalizedId: ID | null
  amount: number | null
  unit: string | null
  /** 原文用量（「适量」类无法累加时保留） */
  amountText: string | null
  category: ShoppingCategory
  /** 已备好/已购买（FR-3.14） */
  checked: boolean
  stockStatus: StockStatus
  /** 来源菜谱，用于追溯（FR-3.18） */
  sourceRecipeIds: ID[]
  /** 手动追加项（FR-3.19） */
  isManual: boolean
}

// ---------------------------------------------------------------------------
// 食材标准库（FR-3.12，决议 Q2：内置约 200 条）
// ---------------------------------------------------------------------------

export interface IngredientDict extends BaseEntity {
  /** 标准名，如「生抽」 */
  name: string
  category: ShoppingCategory
  /** 别名，如「酱油」「豉油」 */
  aliases: string[]
  defaultUnit: string | null
}

// ---------------------------------------------------------------------------
// 制作历史（FR-3.31 ~ FR-3.34）
// ---------------------------------------------------------------------------

export interface CookHistoryItem extends BaseEntity {
  /** YYYY-MM-DD */
  date: string
  recipeId: ID
  servings: number
  rating: number | null
  note: string | null
}

// ---------------------------------------------------------------------------
// 图片（M5）
// ---------------------------------------------------------------------------

export interface BlobRecord {
  id: ID
  blob: Blob
  thumbBlob: Blob | null
  mimeType: string
  width: number
  height: number
  size: number
  /** SHA-256，用于去重 */
  hash: string
  createdAt: Timestamp
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

/** 解析策略（FR-6.2） */
export type ParseStrategy = 'rule-only' | 'rule-then-llm' | 'llm-only'

export interface ApiConfig {
  provider: 'deepseek' | 'claude' | 'custom'
  apiKey: string
  baseUrl: string
  model: string
}

export interface AppSetting {
  key: string
  value: unknown
}
