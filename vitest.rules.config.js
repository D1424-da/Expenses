import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests-rules/**/*.test.js"],
    globals: true,
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Firestore Emulator を共有するため、ファイル間の並列実行を無効化する
    fileParallelism: false,
  },
});
