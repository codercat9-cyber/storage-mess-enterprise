import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import fs from 'fs';

// Версия из package.json — вшивается при сборке как __APP_VERSION__
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
const APP_VERSION: string = pkg.version || '1.0.0';

// Используем сертификаты от сервера для HTTPS в dev режиме
const certPath = path.resolve(__dirname, '../server/certs/cert.pem');
const keyPath = path.resolve(__dirname, '../server/certs/key.pem');

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'storage-mess-logo.svg',
        'apple-touch-icon-180x180.png',
        'pwa-64x64.png',
        'pwa-192x192.png',
        'pwa-512x512.png',
        'maskable-icon-512x512.png',
        'storage-icon.png',
        'sounds/message.mp3',
        'sounds/ringtone.mp3',
      ],
      manifest: {
        name: 'STORAGE&MESS',
        short_name: 'STORAGE&MESS',
        description: 'это простое локальное хранилище данных тут ничего нет',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        lang: 'ru',
        categories: ['social', 'communication'],
        icons: [
          {
            src: 'pwa-64x64.png',
            sizes: '64x64',
            type: 'image/png',
          },
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        screenshots: [],
        shortcuts: [
          {
            name: 'Открыть чаты',
            short_name: 'Чаты',
            url: '/',
            icons: [{ src: 'icon-192.png', sizes: '192x192' }],
          },
          {
            name: 'Настройки',
            short_name: 'Настройки',
            url: '/settings',
            icons: [{ src: 'icon-192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        // Кэширование статических ресурсов (оболочка приложения)
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,woff,ttf,wav,mp3}'],
        // Максимальный размер файла для precache (5MB)
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Удалять устаревшие кэши от предыдущих сборок (фикс Script error)
        cleanupOutdatedCaches: true,
        // Импортируем кастомный SW для обработки уведомлений
        importScripts: ['sw-custom.js'],
        // Runtime caching стратегии
        runtimeCaching: [
          {
            // Эмодзи — Cache First.
            //
            // Было NetworkFirst с networkTimeoutSeconds: 3. Это значило,
            // что уже закэшированная картинка всё равно сначала шла в
            // сеть, и под очередью из 6 соединений часть запросов
            // упиралась в трёхсекундный таймаут. При первом открытии
            // (кэша ещё нет) такие запросы просто не отдавали картинку —
            // отсюда «не подгружаются стабильно».
            //
            // Файлы неизменяемые и версионируются через ?v2 в URL, так
            // что обновление набора решается сменой этой версии, а не
            // походом в сеть за каждым спрайтом.
            urlPattern: /\/emoji\/.+\.png/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'emoji-cache-v2',
              expiration: {
                // На сервере 3593 файла. При 2500 записях LRU постоянно
                // вытесняла уже загруженные категории, и при возврате к
                // ним всё скачивалось заново.
                maxEntries: 4096,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 дней
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Thumbnails — Cache First (статичные, не меняются)
            urlPattern: /^https?:\/\/.*\/api\/files\/thumbnail\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'thumbnails-cache',
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 дней
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // API запросы (кроме файлов и обновлений) — Network First
            urlPattern: /^https?:\/\/.*\/api\/(?!files\/(download|view|voice)\/|updates\/download\/).*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24, // 24 часа
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
              networkTimeoutSeconds: 10,
            },
          },
          {
            // Шрифты — Cache First
            urlPattern: /\.(?:woff2?|ttf|otf|eot)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'fonts-cache',
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 год
              },
            },
          },
          {
            // Изображения (с поддержкой query параметров) — Stale While Revalidate
            urlPattern: /\.(?:png|jpg|jpeg|gif|webp|avif|svg)(?:\?.*)?$/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'images-cache',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 дней
              },
            },
          },
          {
            // Медиафайлы (включая картинки сообщений и аватарки без расширений)
            urlPattern: /^https?:\/\/.*\/api\/files\/(view|download)\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'files-media-cache',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 дней
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Прямые ссылки на аватарки (/api/avatars/...)
            urlPattern: /^https?:\/\/.*\/api\/avatars\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'avatars-cache',
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 дней
              },
            },
          },
        ],
        // Навигационный fallback для SPA
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/socket\.io/,
          /^\/updates\//,
        ],
        // Пропускать ожидание — сразу активировать новый SW
        skipWaiting: true,
        clientsClaim: true,
      },
      // Режим разработки — включить SW и для dev сервера
      devOptions: {
        enabled: false, // Включить true для тестирования SW в dev
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    https: fs.existsSync(certPath) && fs.existsSync(keyPath) ? {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    } : false,
    proxy: {
      '/api': {
        target: 'https://localhost:3001',
        changeOrigin: true,
        rejectUnauthorized: false,
      },
      '/socket.io': {
        target: 'https://localhost:3001',
        ws: true,
        rejectUnauthorized: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-socket': ['socket.io-client'],
          'vendor-ui': ['lucide-react', 'date-fns'],
        },
      },
    },
  },
  define: {
    // Вшиваем версию из package.json в бандл
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
});
