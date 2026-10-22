import { Cpu, Ellipsis, Pencil, Plus, RefreshCw, Search, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { CodeBlock } from "../../components/CodeBlock";
import { DiffView } from "../../components/DiffView";
import { JsonView } from "../../components/JsonView";
import { Markdown } from "../../components/Markdown";
import {
	Badge,
	Button,
	Callout,
	Card,
	Checkbox,
	EmptyState,
	Field,
	IconButton,
	Input,
	KeyValue,
	Menu,
	Modal,
	ProgressBar,
	Radio,
	RadioGroup,
	SectionLabel,
	Segmented,
	Select,
	Spinner,
	StatusDot,
	Switch,
	TabPanel,
	Tabs,
	Textarea,
	toast,
} from "../../components/ui";
import { makeUnifiedDiff } from "../../lib/diff-parse";

const PY = `import bisect
from pathlib import Path

class ShardedTextDataset(Dataset):
    """按分片读取 token，只缓存最近使用的分片。"""

    def __init__(self, shards, tokenizer, seq_len=2048, cache_shards=4):
        self.shards = [Path(p) for p in shards]
        # 每个 worker 最多保留 cache_shards 个分片
        self._cache = LRUCache(maxsize=cache_shards)
`;

const MD = `# llm-train

基于 PyTorch 的语言模型训练代码。训练数据按分片存放在 \`/data/shards\`，详见 [文档](https://example.com)。

## 快速开始

\`\`\`bash
pip install -e .
python -m train --config configs/train.yaml
\`\`\`

- [x] 分片 LRU 缓存
- [ ] FSDP 支持

| 指标 | 修改前 | 修改后 |
| --- | --- | --- |
| 峰值内存 | 38 GB | 12 GB |

> 注意：需要 Python ≥ 3.10。
`;

const DIFF = makeUnifiedDiff(
	"        self.shards = shards\n        self._cache = dict()\n        ...\n        self._cache[idx] = shard\n",
	"        self.shards = shards\n        self._cache = LRUCache(maxsize=cache_shards)\n        self._cache_shards = cache_shards\n        ...\n        shard_id = self._shard_of(idx)\n        self._cache[shard_id] = shard\n",
	"src/data/loader.py",
);

/** Route /dev/ui — living style guide of the shared components (not linked from the UI). */
export default function UiGalleryPage() {
	const [seg, setSeg] = useState<"preview" | "source">("preview");
	const [auth, setAuth] = useState<"key" | "password" | "agent">("key");
	const [trust, setTrust] = useState("approve");
	const [on, setOn] = useState(true);
	const [checked, setChecked] = useState(true);
	const [tab, setTab] = useState("overview");
	const [modal, setModal] = useState(false);
	const [diffMode, setDiffMode] = useState<"inline" | "split">("inline");

	return (
		<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto flex max-w-[1180px] flex-col gap-5 px-6 py-6">
				<h1 className="m-0 text-xl font-semibold">组件示例</h1>

				<Card title="按钮" icon={<Cpu />}>
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="primary">允许</Button>
						<Button>拒绝</Button>
						<Button variant="outline">Clone</Button>
						<Button variant="ghost" icon={<Plus size={14} />}>
							新建对话
						</Button>
						<Button variant="warning">中止</Button>
						<Button variant="danger" icon={<Trash2 size={14} />}>
							删除
						</Button>
						<Button loading>保存中</Button>
						<Button size="sm">小按钮</Button>
						<Button size="lg" variant="primary">
							大按钮
						</Button>
						<IconButton aria-label="更多操作" variant="secondary">
							<Ellipsis size={16} />
						</IconButton>
						<IconButton aria-label="刷新">
							<RefreshCw size={16} />
						</IconButton>
						<Menu
							aria-label="会话操作"
							trigger={(props) => (
								<Button {...props} icon={<Ellipsis size={14} />}>
									菜单
								</Button>
							)}
							items={[
								{ label: "重命名", icon: <Pencil />, onSelect: () => toast.info("重命名") },
								{ type: "separator" },
								{ label: "删除会话", icon: <Trash2 />, danger: true, onSelect: () => toast.error("已删除") },
							]}
						/>
					</div>
				</Card>

				<div className="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-4">
					<Card title="表单">
						<div className="flex flex-col gap-3.5">
							<Field label="名称" hint="显示在侧栏中">
								<Input defaultValue="gpu-01" />
							</Field>
							<Field label="主机" error="无法解析主机名">
								<Input mono defaultValue="10.0.3.21" />
							</Field>
							<Input leading={<Search size={14} />} placeholder="名称或首条消息" />
							<Field label="默认模型">
								<Select mono options={[{ value: "a", label: "anthropic/claude-sonnet-4-5" }, { value: "b", label: "openai/gpt-5" }]} />
							</Field>
							<Textarea mono rows={3} defaultValue={"缓存上限改为可配置\n补充回归测试"} />
						</div>
					</Card>
					<Card title="选择控件">
						<div className="flex flex-col gap-4">
							<Segmented
								aria-label="认证方式"
								size="md"
								tone="sunken"
								value={auth}
								onChange={setAuth}
								options={[
									{ value: "key", label: "私钥" },
									{ value: "password", label: "密码" },
									{ value: "agent", label: "ssh-agent" },
								]}
							/>
							<Segmented aria-label="显示方式" value={seg} onChange={setSeg} options={[{ value: "preview", label: "预览" }, { value: "source", label: "源码" }]} />
							<RadioGroup label="Project trust" description="RPC 模式无法弹出信任确认，需要在此指定" value={trust} onChange={setTrust}>
								<Radio value="approve" label="信任：加载 .pi 中的设置与扩展（--approve）" />
								<Radio value="no-approve" label="不信任：忽略项目资源（--no-approve）" />
							</RadioGroup>
							<Checkbox checked={checked} onChange={setChecked} label="settings.json" description="设置（剔除 Host 专属项）" card />
							<Switch checked={on} onChange={setOn} label={on ? "已开启" : "已关闭"} aria-label="自动同步" />
						</div>
					</Card>
					<Card title="状态">
						<div className="flex flex-col gap-3">
							<div className="flex flex-wrap gap-2">
								<Badge tone="info">信息</Badge>
								<Badge tone="warning">警告</Badge>
								<Badge tone="danger">错误</Badge>
								<Badge tone="success" shape="pill" dot>
									在线 · 12ms
								</Badge>
								<Badge>只读</Badge>
								<Badge shape="count" tone="warning">
									3
								</Badge>
							</div>
							<div className="flex flex-col gap-1.5">
								<StatusDot tone="success" label="在线 · 12ms" />
								<StatusDot tone="accent" pulse label="运行中 · bash" />
								<StatusDot tone="warning" label="等待确认 · 扩展对话框" />
								<StatusDot hollow label="离线" />
							</div>
							<ProgressBar value={52} label="总体部署进度" />
							<ProgressBar value={42} size="sm" label="上传 pi" />
							<span className="flex items-center gap-2 text-sm text-fg-2">
								<Spinner /> 进行中
							</span>
						</div>
					</Card>
				</div>

				<div className="grid grid-cols-[repeat(auto-fit,minmax(min(340px,100%),1fr))] gap-4">
					<Callout
						plain
						title="配置已更新"
						actions={
							<Button size="sm" variant="warning">
								运行结束后重启会话
							</Button>
						}
					>
						Host 刚同步了 2 个扩展和 settings.json，重启会话后生效。
					</Callout>
					<Callout>
						<strong className="font-semibold">注意：</strong>切换后同步将写入 ~/.pi/agent，会覆盖服务器上已有的同名配置。
					</Callout>
					<Callout tone="info" title="提示">
						Tunnel 模式下 LLM 请求依赖 Host 在线。
					</Callout>
				</div>

				<Card title="运行环境" padded={false} bodyClassName="px-4 pt-1 pb-2">
					<KeyValue
						items={[
							{ label: "系统", value: "Linux x86_64 · glibc 2.35", mono: true },
							{ label: "pi", value: "1.4.0", mono: true, hint: <span className="text-success-fg">与 Host 一致</span> },
							{ label: "安装目录", value: "~/.pi-web", mono: true, hint: "312 MB" },
						]}
					/>
				</Card>

				<div>
					<Tabs
						aria-label="服务器视图"
						idPrefix="gallery"
						value={tab}
						onChange={setTab}
						items={[
							{ value: "overview", label: "概览" },
							{ value: "ws", label: "工作区", badge: <Badge shape="count">2</Badge> },
							{ value: "logs", label: "日志" },
						]}
					/>
					<TabPanel idPrefix="gallery" value={tab} active className="py-3 text-sm text-fg-2">
						当前标签：{tab}
					</TabPanel>
				</div>

				<div className="flex flex-wrap gap-2">
					<Button onClick={() => setModal(true)}>打开对话框</Button>
					<Button onClick={() => toast.info("本轮用量 18.2k tokens", { source: "token-meter" })}>信息通知</Button>
					<Button onClick={() => toast.warning("已拦截 1 条命令", { source: "safe-bash" })}>警告通知</Button>
					<Button onClick={() => toast.error("无法启动 MCP 服务器 github")}>错误通知</Button>
				</div>
				<Modal
					open={modal}
					onClose={() => setModal(false)}
					title="允许执行危险命令？"
					icon={<TriangleAlert className="text-warning" />}
					size="sm"
					footerHint="8 秒后自动拒绝"
					footer={
						<>
							<Button onClick={() => setModal(false)}>拒绝</Button>
							<Button variant="primary" onClick={() => setModal(false)}>
								允许
							</Button>
						</>
					}
				>
					<div className="flex flex-col gap-2">
						<p className="m-0 text-sm text-fg-2">模型请求执行以下命令：</p>
						<pre className="m-0 rounded-md border border-border bg-code px-3 py-2.5 text-mono text-fg-code">
							<span className="text-fg-3">$ </span>rm -rf build/ dist/
						</pre>
						<Input placeholder="可以 Tab 在控件之间切换" />
					</div>
				</Modal>

				<SectionLabel>Markdown</SectionLabel>
				<Markdown>{MD}</Markdown>

				<SectionLabel>CodeBlock</SectionLabel>
				<CodeBlock code={PY} filename="src/data/loader.py" lineNumbers bordered copyable />
				<CodeBlock code={PY} language="python" lineNumbers startLine={41} wrap highlightLines={[44]} bordered />

				<div className="flex items-center gap-3">
					<SectionLabel>DiffView</SectionLabel>
					<Segmented aria-label="差异视图" value={diffMode} onChange={setDiffMode} options={[{ value: "inline", label: "行内" }, { value: "split", label: "并排" }]} />
				</div>
				<div className="overflow-hidden rounded-lg border border-border">
					<DiffView diff={DIFF} mode={diffMode} showFileHeaders splitLabels={["旧 · 暂存区", "新 · 工作区"]} />
				</div>

				<SectionLabel>JsonView</SectionLabel>
				<JsonView value={{ command: "rg -n 'class .*Dataset' src/", timeout: 120, nested: { ok: true, list: [1, "two", null] } }} />

				<Card title="空状态" padded={false}>
					<EmptyState compact title="暂无工作区" description="在服务器页面添加一个工作区。" actions={<Button size="sm">添加工作区</Button>} />
				</Card>
			</div>
		</div>
	);
}
