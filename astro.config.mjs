import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://viewmbox.com',
  output: 'static',
  trailingSlash: 'always',
  vite: {
    plugins: [tailwindcss()],
    worker: {
      format: 'es',
    },
  },
  integrations: [
    sitemap({
      filter: (page) =>
        !page.endsWith('/404/') &&
        !page.endsWith('/500/'),
    }),
  ],
});
