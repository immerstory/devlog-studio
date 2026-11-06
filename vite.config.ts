import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { extensionEntries, extensionRoots } from "./server/extensionPaths.ts";

const VIRTUAL_ID = "virtual:devlog-extensions";

/** Gives the browser the same extensions the server loads. */
function devlogExtensions(): Plugin {
  return {
    name: "devlog-extensions",
    resolveId: (id) => (id === VIRTUAL_ID ? `\0${VIRTUAL_ID}` : undefined),
    load(id) {
      if (id !== `\0${VIRTUAL_ID}`) return undefined;
      const entries = extensionEntries(import.meta.dirname);
      const imports = entries.map(({ entry }, i) => `import e${i} from ${JSON.stringify(`/@fs/${entry.replace(/\\/g, "/").replace(/^\//, "")}`)};`);
      return `${imports.join("\n")}\nexport default [${entries.map((_, i) => `e${i}`).join(", ")}];`;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devlogExtensions()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "web") } },
  server: { fs: { allow: ["..", ...extensionRoots(import.meta.dirname)] } },
});
