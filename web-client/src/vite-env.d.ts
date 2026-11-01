/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_SOCKET_URL: string;
  readonly VITE_PRIMARY_URL: string;
  readonly VITE_SAME_ORIGIN?: string;
  readonly VITE_FALLBACK_URL: string;
  readonly VITE_YGGDRASIL_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
