/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // dev 下不启用 SW，避免干扰开发时的热更新
      devOptions: { enabled: false },
      manifest: {
        name: '家庭私厨',
        short_name: '私厨',
        description: '菜谱收集 · 分类 · 点菜与备菜清单',
        theme_color: '#e8590c',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
