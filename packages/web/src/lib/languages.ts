/**
 * File name → highlight.js language id, plus human-readable labels ("Python", "TOML").
 * Only languages registered in CodeBlock (highlight.js "common" + a few extras) are returned.
 */

const BY_NAME: Record<string, string> = {
	dockerfile: "dockerfile",
	containerfile: "dockerfile",
	makefile: "makefile",
	gnumakefile: "makefile",
	"cmakelists.txt": "cmake",
	".bashrc": "bash",
	".bash_profile": "bash",
	".profile": "bash",
	".zshrc": "bash",
	".gitignore": "plaintext",
	".gitattributes": "plaintext",
	".dockerignore": "plaintext",
	".npmrc": "ini",
	".editorconfig": "ini",
	".env": "bash",
	"package.json": "json",
	"tsconfig.json": "json",
	"cargo.lock": "ini",
	"go.mod": "go",
	"go.sum": "plaintext",
	gemfile: "ruby",
	rakefile: "ruby",
	jenkinsfile: "groovy",
	"nginx.conf": "nginx",
};

const BY_EXT: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonc: "json",
	json5: "json",
	jsonl: "json",
	ndjson: "json",
	py: "python",
	pyi: "python",
	pyw: "python",
	ipynb: "json",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	scala: "scala",
	groovy: "groovy",
	gradle: "groovy",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	hh: "cpp",
	hxx: "cpp",
	cu: "cpp",
	cuh: "cpp",
	m: "objectivec",
	mm: "objectivec",
	cs: "csharp",
	swift: "swift",
	php: "php",
	pl: "perl",
	pm: "perl",
	lua: "lua",
	r: "r",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	fish: "bash",
	ksh: "bash",
	ps1: "powershell",
	psm1: "powershell",
	sql: "sql",
	graphql: "graphql",
	gql: "graphql",
	html: "xml",
	htm: "xml",
	xhtml: "xml",
	xml: "xml",
	svg: "xml",
	plist: "xml",
	vue: "xml",
	svelte: "xml",
	css: "css",
	scss: "scss",
	sass: "scss",
	less: "less",
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	yml: "yaml",
	yaml: "yaml",
	toml: "ini",
	ini: "ini",
	cfg: "ini",
	conf: "ini",
	properties: "properties",
	env: "bash",
	diff: "diff",
	patch: "diff",
	mk: "makefile",
	cmake: "cmake",
	dockerfile: "dockerfile",
	proto: "protobuf",
	dart: "dart",
	ex: "elixir",
	exs: "elixir",
	hs: "haskell",
	nix: "nix",
	vim: "vim",
	clj: "clojure",
	cljs: "clojure",
	tf: "plaintext",
	wasm: "wasm",
	wat: "wasm",
	vb: "vbnet",
	txt: "plaintext",
	log: "plaintext",
	csv: "plaintext",
	tsv: "plaintext",
};

const LABELS: Record<string, string> = {
	typescript: "TypeScript",
	javascript: "JavaScript",
	json: "JSON",
	python: "Python",
	ruby: "Ruby",
	go: "Go",
	rust: "Rust",
	java: "Java",
	kotlin: "Kotlin",
	scala: "Scala",
	groovy: "Groovy",
	c: "C",
	cpp: "C++",
	objectivec: "Objective-C",
	csharp: "C#",
	swift: "Swift",
	php: "PHP",
	perl: "Perl",
	lua: "Lua",
	r: "R",
	bash: "Shell",
	shell: "Shell",
	powershell: "PowerShell",
	sql: "SQL",
	graphql: "GraphQL",
	xml: "HTML/XML",
	css: "CSS",
	scss: "SCSS",
	less: "Less",
	markdown: "Markdown",
	yaml: "YAML",
	ini: "INI",
	properties: "Properties",
	diff: "Diff",
	makefile: "Makefile",
	cmake: "CMake",
	dockerfile: "Dockerfile",
	protobuf: "Protobuf",
	dart: "Dart",
	elixir: "Elixir",
	haskell: "Haskell",
	nix: "Nix",
	vim: "Vim",
	clojure: "Clojure",
	nginx: "Nginx",
	wasm: "WebAssembly",
	vbnet: "VB.NET",
	plaintext: "纯文本",
};

/** highlight.js language id for a path or file name, or undefined when unknown. */
export function languageFromPath(path: string | null | undefined): string | undefined {
	if (!path) return undefined;
	const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	if (BY_NAME[name]) return BY_NAME[name];
	if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
	if (name.startsWith(".env.")) return "bash";
	const dot = name.lastIndexOf(".");
	if (dot <= 0 && !name.startsWith(".")) return undefined;
	const ext = name.slice(dot + 1);
	return BY_EXT[ext];
}

/** Human-readable language name; "TOML" when the path says so even though ini highlights it. */
export function languageLabel(language: string | undefined, path?: string): string {
	if (path && /\.toml$/i.test(path)) return "TOML";
	if (path && /\.tsx$/i.test(path)) return "TSX";
	if (path && /\.jsx$/i.test(path)) return "JSX";
	if (!language) return "纯文本";
	return LABELS[language] ?? language;
}

/** Normalizes fenced-code info strings ("py", "sh", "ts") to highlight.js ids. */
export function normalizeLanguage(lang: string | null | undefined): string | undefined {
	if (!lang) return undefined;
	const l = lang.trim().toLowerCase();
	if (!l) return undefined;
	const alias: Record<string, string> = {
		py: "python",
		sh: "bash",
		zsh: "bash",
		shell: "bash",
		console: "bash",
		ts: "typescript",
		js: "javascript",
		yml: "yaml",
		toml: "ini",
		md: "markdown",
		html: "xml",
		rs: "rust",
		rb: "ruby",
		"c++": "cpp",
		"c#": "csharp",
		cs: "csharp",
		kt: "kotlin",
		docker: "dockerfile",
		jsonl: "json",
		text: "plaintext",
		txt: "plaintext",
	};
	return alias[l] ?? BY_EXT[l] ?? l;
}

/** Whether a file is likely an image the browser can preview. */
export function isImagePath(path: string): boolean {
	return /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(path);
}

/** MIME type for previewable images (data: URLs from base64 reads). */
export function imageMimeType(path: string): string | undefined {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	const map: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		bmp: "image/bmp",
		ico: "image/x-icon",
		avif: "image/avif",
		svg: "image/svg+xml",
	};
	return map[ext];
}

export function isMarkdownPath(path: string): boolean {
	return /\.(md|markdown|mdx)$/i.test(path);
}
