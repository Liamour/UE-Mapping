import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  build: {
    target: 'esnext',
    assetsInlineLimit: 100000000, // 强制将图片/字体也转换为 Base64 内联
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false, // 禁用 CSS 分割
    rollupOptions: {
      output: {
        codeSplitting: false, // 强制取消动态加载，全部打包到一起
      },
    },
    // 直接输出到UE插件WebUI目录
    outDir: '../Plugins/AICartographer/Resources/WebUI',
    emptyOutDir: true,
  },
  server: {
    // 允许局域网访问，如果需要的话
    host: '0.0.0.0',
    proxy: {
      // 代理所有发往 /api/volc 的请求
      '/api/volc': {
        target: 'https://ark.cn-beijing.volces.com/api/v3',
        changeOrigin: true, // 核心：欺骗跨域策略
        rewrite: (path) => path.replace(/^\/api\/volc/, ''),
        // 新增透视钩子
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('❌ [Vite Proxy Error]', err);
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            console.log(`🚀 [Vite Proxy] Sending request to Volcengine: ${req.method} ${req.url}`);
          });
          proxy.on('proxyRes', (proxyRes, req, _res) => {
            console.log(`✅ [Vite Proxy] Received response: ${proxyRes.statusCode} for ${req.url}`);
          });
        },
      }
    }
  }
})
