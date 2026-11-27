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
        name: 'New Life · Estoque',
        short_name: 'New Life Estoque',
        description: 'Gerenciador de estoque: roteadores recolhidos, chips da MVNO e custódia por cidade.',
        lang: 'pt-BR',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#0a478f',
        background_color: '#eff4fa',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{css,js,html,png,webp}'],
        navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/health(?:\/|$)/],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
})
