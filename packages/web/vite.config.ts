import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const backend = "http://127.0.0.1:7878";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		proxy: {
			"/api": { target: backend },
			// Also covers /ws/term (terminal sockets).
			"/ws": { target: backend, ws: true },
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		chunkSizeWarningLimit: 1500,
	},
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});
