import { defineConfig } from 'tsdown';
export default defineConfig({ entry: { start: 'src/start.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false,
  platform: 'node', target: 'es2024', dts: true, clean: true });
