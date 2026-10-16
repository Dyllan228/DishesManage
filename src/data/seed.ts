/**
 * 内置种子数据：分类树 + 标签（需求文档 §4.2.4，v1.1 决议 Q3 修订）
 *
 * Q3 决策：分类树一级**只按上菜类型**；菜系从树里移除，降级为标签维度。
 */

import type { Category, Tag, TagDimension } from '@/types/models'

/** 未分类节点的固定 ID —— 系统保留，不可删除（FR-2.7） */
export const UNCATEGORIZED_ID = 'cat_uncategorized'

interface SeedCategory {
  id: string
  name: string
  parentId: string | null
  icon?: string
  children?: SeedCategory[]
}

const CATEGORY_TREE: SeedCategory[] = [
  { id: 'cat_home', name: '家常菜', parentId: null, icon: '🍲' },
  {
    id: 'cat_meat',
    name: '荤菜',
    parentId: null,
    icon: '🥩',
    children: [
      { id: 'cat_meat_pork', name: '猪', parentId: 'cat_meat' },
      { id: 'cat_meat_beef', name: '牛', parentId: 'cat_meat' },
      { id: 'cat_meat_lamb', name: '羊', parentId: 'cat_meat' },
      { id: 'cat_meat_poultry', name: '鸡鸭', parentId: 'cat_meat' },
      { id: 'cat_meat_seafood', name: '鱼虾蟹', parentId: 'cat_meat' },
      { id: 'cat_meat_other', name: '其他', parentId: 'cat_meat' },
    ],
  },
  {
    id: 'cat_veg',
    name: '素菜',
    parentId: null,
    icon: '🥬',
    children: [
      { id: 'cat_veg_leaf', name: '叶菜', parentId: 'cat_veg' },
      { id: 'cat_veg_root', name: '根茎', parentId: 'cat_veg' },
      { id: 'cat_veg_mushroom', name: '菌菇', parentId: 'cat_veg' },
      { id: 'cat_veg_tofu', name: '豆制品', parentId: 'cat_veg' },
      { id: 'cat_veg_egg', name: '蛋类', parentId: 'cat_veg' },
    ],
  },
  { id: 'cat_soup', name: '汤羹', parentId: null, icon: '🥣' },
  {
    id: 'cat_staple',
    name: '主食',
    parentId: null,
    icon: '🍚',
    children: [
      { id: 'cat_staple_rice', name: '米饭类', parentId: 'cat_staple' },
      { id: 'cat_staple_noodle', name: '面食', parentId: 'cat_staple' },
      { id: 'cat_staple_congee', name: '粥', parentId: 'cat_staple' },
      { id: 'cat_staple_pancake', name: '饼', parentId: 'cat_staple' },
    ],
  },
  { id: 'cat_cold', name: '凉菜', parentId: null, icon: '🥗' },
  { id: 'cat_breakfast', name: '早餐', parentId: null, icon: '🍳' },
  { id: 'cat_dessert', name: '甜品烘焙', parentId: null, icon: '🍰' },
  { id: 'cat_drink', name: '饮品', parentId: null, icon: '🥤' },
  { id: UNCATEGORIZED_ID, name: '未分类', parentId: null, icon: '📁' },
]

const TAG_SEEDS: Record<TagDimension, string[]> = {
  // v1.1 决议 Q3 新增的维度
  cuisine: ['川菜', '粤菜', '鲁菜', '湘菜', '江浙菜', '东北菜', '西北菜', '云贵菜', '西餐', '日韩', '东南亚'],
  taste: ['辣', '清淡', '酸甜', '咸香', '麻辣', '鲜'],
  method: ['炒', '蒸', '煮', '炖', '烤', '凉拌', '炸', '焖', '煎'],
  scene: ['快手菜', '宴客菜', '一人食', '下饭菜', '减脂餐', '夜宵'],
  diet: ['儿童友好', '老人友好', '无辣', '无海鲜', '无花生', '低糖'],
  custom: [],
}

/** 标签维度展示名 */
export const DIMENSION_LABEL: Record<TagDimension, string> = {
  cuisine: '菜系',
  taste: '口味',
  method: '烹饪方式',
  scene: '场景',
  diet: '人群/忌口',
  custom: '自定义',
}

export const DIMENSION_ORDER: TagDimension[] = ['cuisine', 'taste', 'method', 'scene', 'diet', 'custom']

export function buildSeedCategories(now = Date.now()): Category[] {
  const out: Category[] = []
  const walk = (nodes: SeedCategory[]) => {
    nodes.forEach((n, i) => {
      out.push({
        id: n.id,
        name: n.name,
        parentId: n.parentId,
        order: i,
        icon: n.icon ?? null,
        isSystem: n.id === UNCATEGORIZED_ID,
        createdAt: now,
        updatedAt: now,
      })
      if (n.children) walk(n.children)
    })
  }
  walk(CATEGORY_TREE)
  return out
}

export function buildSeedTags(now = Date.now()): Tag[] {
  const out: Tag[] = []
  for (const [dimension, names] of Object.entries(TAG_SEEDS) as Array<[TagDimension, string[]]>) {
    names.forEach((name, i) => {
      out.push({
        id: `tag_${dimension}_${i}`,
        name,
        dimension,
        color: null,
        usageCount: 0,
        createdAt: now,
        updatedAt: now,
      })
    })
  }
  return out
}
