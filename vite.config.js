import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  publicDir: "public",
  base: process.env.GITHUB_ACTIONS === "true"
    ? `/${process.env.GITHUB_REPOSITORY.split("/")[1]}/`
    : "/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
