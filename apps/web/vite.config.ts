import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const proxy = { '/api': { target: 'http://127.0.0.1:3000' } }

export default defineConfig({
  server: { proxy },
  preview: { proxy },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'Newlife · Controle de equipamentos',
        short_name: 'Newlife Estoque',
        description: 'Captura offline de etiquetas e consulta da custódia de equipamentos.',
        lang: 'pt-BR',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#11332b',
        background_color: '#f5f7f4',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{css,js,html,png}'],
        navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/health(?:\/|$)/],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
})
