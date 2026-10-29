import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * 两套环境分工明确：
 * - `unit`（node）：`utils/` 下的纯逻辑层，不需要 DOM，跑得快
 * - `ui`（jsdom）：`entrypoints/manager/` 的 React 组件，需要 DOM
 *
 * 用 projects 而不是全局切 jsdom：纯逻辑层用不到 DOM，
 * 给它套 jsdom 只增加启动开销，且会掩盖"这层不该碰 DOM"的约束。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.test.ts'],
          exclude: ['node_modules/**', '.output/**', '.wxt/**', '.local/**', 'entrypoints/**'],
          setupFiles: ['tests/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['entrypoints/**/*.test.tsx'],
          exclude: ['node_modules/**', '.output/**', '.wxt/**', '.local/**'],
          setupFiles: ['tests/setup-ui.ts'],
        },
      },
    ],
  },
});
