import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDevProxy(env) {
  const raw = (
    env.DEV_API_PROXY ||
    process.env.DEV_API_PROXY ||
    env.VITE_API_PROXY ||
    process.env.VITE_API_PROXY ||
    'http://127.0.0.1:3001'
  )
    .trim()
    .replace(/\/$/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'http://127.0.0.1:3001';
  }
  // Dev proxy only — keep targets on loopback to avoid accidental open proxy.
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.warn(
      `[vite] refusing non-loopback DEV_API_PROXY (${host}); using http://127.0.0.1:3001`,
    );
    return 'http://127.0.0.1:3001';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'http://127.0.0.1:3001';
  }
  return url.origin;
}

export default defineConfig(({ mode }) => {
  // Local overrides via admin-web/.env (gitignored). Repo defaults stay 5173 / 3001.
  const env = loadEnv(mode, __dirname, '');
  const devPort = Number(
    env.DEV_PORT || process.env.DEV_PORT || env.VITE_DEV_PORT || process.env.VITE_DEV_PORT || 5173,
  );
  const apiProxy = resolveDevProxy(env);

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    base: '/',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    server: {
      port: Number.isFinite(devPort) && devPort > 0 ? devPort : 5173,
      proxy: Object.fromEntries(
        [
          '/auth',
          '/reports',
          '/settings',
          '/sync',
          '/media',
          '/remote-trips',
          '/slip-reservations',
          '/offset-audit',
          '/health',
        ].map((prefix) => [
          prefix,
          {
            target: apiProxy,
            // Local FLUX Kontext edits can take many minutes per camera.
            timeout: 3_600_000,
            proxyTimeout: 3_600_000,
            bypass(req) {
              if (req.headers.accept?.includes('text/html')) return '/index.html';
              return undefined;
            },
          },
        ]),
      ),
    },
  };
});
