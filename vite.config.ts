import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // V1.9.0 P0-5：把稳定的大体量厂商包切到可长期缓存的独立 chunk。
        // 仅拆「首屏必用」的依赖；其余一律返回 undefined，交给 Rollup 按动态 import 归属
        // （保证 @dnd-kit / cropperjs 只留在各自懒加载路由分包里，不被提升到 eager 公共块）。
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (id.includes('@supabase')) return 'vendor-supabase'
          if (id.includes('react-router') || id.includes('@remix-run')) return 'vendor-router'
          if (
            id.includes('react-dom') ||
            id.includes('/react/') ||
            id.includes('scheduler') ||
            id.includes('use-sync-external-store')
          )
            return 'vendor-react'
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
