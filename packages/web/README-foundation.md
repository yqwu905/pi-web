# Web foundation: building blocks and conventions

This note is for the feature engineers (chat, workspace, management pages) building on `packages/web`.

## Commands

```
npm run dev -w @pi-web/web        # Vite on :5173; /api and /ws are proxied to http://127.0.0.1:7878
npm run typecheck -w @pi-web/web
npm test -w @pi-web/web           # vitest, node environment (pure logic only, no DOM)
npm run build -w @pi-web/web      # → packages/web/dist
```

Open `/dev/ui` in the running app to see every shared component (`src/pages/dev/UiGalleryPage.tsx`).

## Conventions

- **Pages** are default-exported components, lazy-loaded from `src/App.tsx`. Replace the placeholder file for your page in place: `pages/chat/ChatPage.tsx`, `pages/workspace/{Files,Terminal,Git}Page.tsx`, `pages/servers/{AddServer,ServerDetail,ServerSettings}Page.tsx`, `pages/sync/SyncCenterPage.tsx` and `pages/settings/SettingsPage.tsx`. Put page-specific components next to the page.
- **Routes and URLs** are built with `paths.*` from `lib/routes.ts`. Never hand-write URLs. `parseRoute(pathname)` classifies a URL. The chat route is `/w/:workspaceId/chat/:sessionId?`. `sessionId` is the session uuid, and `findSessionById`, `sessionRouteId`, `useSessionById` map it to and from a `SessionSummary`.
- **Workspace pages** render inside `layout/WorkspaceLayout.tsx`, which already draws the 对话 / 文件 / 终端 / Git tab bar. A page fills `flex min-h-0 flex-1 flex-col` and handles its own scrolling.
- **Colors** come only from the theme tokens in `src/styles.css` (`bg-panel`, `text-fg-2`, `border-border-strong`, `bg-success-soft`, `text-syn-keyword` …). Tailwind's default palette is disabled on purpose, so do not add hex colors in class names.
- **Type scale**: `text-2xs` 11px, `text-xs` 12px, `text-mono` 12.5px (code), `text-sm` 13px (default UI text), `text-base` 14px, `text-md` 15px (dialog titles), `text-lg` 16px, `text-xl` 20px (page titles). Radii: `rounded-sm` 4, `rounded-md` 6, `rounded-lg` 8, `rounded-xl` 10. Use the `section-label` utility for the small letter-spaced headings ("服务器", "上下文").
- **Copy**: all user-visible text is Simplified Chinese. Code and comments are English. Icons come from `lucide-react`, sized 12–16 with `strokeWidth` 1.7–2.2 to match the artboards.
- **Accessibility**: icon-only buttons use `IconButton` (its `aria-label` is required). Dialogs use `Modal`, which handles Esc, the focus trap and focus restore. Use real `<button>` and `<Link>` elements.

## Data layer (`src/api`, `src/stores`)

| Need | Use |
|---|---|
| Any REST route | `api.*` / named functions in `api/client.ts`. They throw `ApiError {status, code, message}`. Show errors with `errorMessage(e)`. |
| Download URLs | `workspaceDownloadUrl(wsId, path)`, `conversationExportUrl(convId)`, `saveBlob(blob, name)` |
| WS topic | `useTopic<T>(topic, handler)`. Topics are listed in `@pi-web/shared/api.ts`: `servers`, `convs`, `conv:<id>`, `deploy:<id>`, `sync`, `oauth`, `proxy:<id>`. Subscriptions are ref-counted and re-subscribed after reconnects. |
| Resync after WS drop | `useWsReconnect(cb)`, `useWsStatus()` |
| Servers (live status) | `useServers()`, `useServer(id)`, `refreshServers()`, `useServersStore.getState().upsertServer(view)` |
| Live conversations | `useConversations()`, `useLiveConversations(wsId?)`, `useConversationView(convId)`, `refreshConversations()` |
| Workspaces / sessions | `useAllWorkspaces()`, `useWorkspace(id)`, `useServerWorkspaces(serverId)`, `useWorkspaceSessions(wsId)` (refetched automatically on `convs` events), `useSessionById(wsId, sessionId)` |
| Meta, settings, sync, git | `useMeta()`, `useSettings()`, `useSyncStatus()` (kept live by the `sync` topic), `useGitStatus(wsId)` |
| After a mutation | `invalidateServers()`, `invalidateWorkspaces(serverId?)`, `invalidateSessions(wsId)`, `invalidateSettings()`, `invalidateSync()`, `invalidateGitStatus(wsId)`. Query keys live in `api/queryClient.ts` (`queryKeys`). |
| Toasts | `toast.info/success/warning/error(message, { title?, source? })` |
| UI prefs | `useUiStore`: sidebar expansion, `rememberSession` / `forgetSession`, `lastSession` per workspace |

### Chat: `useConversation`

`stores/conversation.ts` has the full API reference in the comment block at the top of the file. A summary:

```ts
const conv = useConversation({ workspaceId, sessionId });
conv.mode;            // "new" | "readonly" (session file, no process) | "live"
conv.state;           // shared ConversationState: messages, streaming, tools, queue, ui, isRunning …
await conv.prompt(text, { images, streamingBehavior: conv.state.isRunning ? "steer" : undefined });
const { models } = await conv.call({ type: "get_available_models" }); // typed by command
await conv.uiResponse({ type: "extension_ui_response", id, confirmed: true });
```

- Live state comes from a snapshot plus `conv:<id>` events, applied with the shared `applyConvRecord` and only when the event's `seq` is newer than the snapshot. Gaps are filled from `/replay`. The hook refetches the snapshot when `needsResync` is set or the WS reconnects. Stats refresh after each `agent_settled`, and `rpcState` refreshes after model, thinking and flag commands.
- When pi switches session (new_session, fork, clone, switch_session), `conv.sessionId` changes. Navigate with `paths.chat(workspaceId, conv.sessionId)`.
- Companion actions (`navigateConversation`, `labelConversationEntry`, `reloadConversation`) and `exportConversation` are plain client calls that take `conv.convId`.

## Components (`src/components`)

- `ui/` (import from `components/ui`):
  - Actions: `Button` (primary, secondary, outline, ghost, warning, danger; sizes sm 28, md 32, lg 36; `loading`, `icon`), `ButtonLink`, `IconButton`, `Menu`
  - Form controls: `Input` (`mono`, `leading`), `Textarea`, `Select`, `Checkbox` (`card`), `RadioGroup` + `Radio`, `Switch`, `Segmented`, `Field` (label, hint and error wiring)
  - Layout and status: `Card`, `Badge` (tag, pill, count), `StatusDot`, `Callout`, `KeyValue`, `ProgressBar`, `Spinner`, `LoadingBlock`, `EmptyState`, `Tabs` + `TabPanel`, `NavTabs`
  - Overlays: `Modal`, `Tooltip` (title attribute), `ToastViewport` (already mounted in the shell)
- `Markdown`: react-markdown with GFM and rehype-highlight. Links open in a new tab and raw HTML is not rendered.
- `CodeBlock`: highlight.js with the language taken from the `filename` or `language` prop, plus `lineNumbers`, `startLine`, `wrap`, `highlightLines`, `copyable` and `maxHeight`. It also exports `CopyButton` and `copyText`.
- `DiffView`: renders a unified diff string or parsed files, in `inline` or `split` mode, with `splitLabels`, `showFileHeaders` and `fileActions`. For pi's edit tool, call `makeUnifiedDiff(oldText, newText, path)` from `lib/diff-parse.ts`.
- `JsonView`: a collapsible JSON tree, for tool calls that have no dedicated card.

## Pure helpers (`src/lib`, unit-tested)

| File | Contents |
|---|---|
| `format.ts` | `formatBytes`, `formatRelativeTime` ("3 分钟前"), `formatDuration` ("4.2s"), `formatDurationZh`, `formatClock`, `formatTokens` ("68.1k"), `formatCost`, `formatPercent`, `truncate`, `tildify`, `basename` |
| `languages.ts` | `languageFromPath`, `languageLabel`, `isImagePath`, `imageMimeType`, `isMarkdownPath` |
| `highlight.ts` | `highlightCode`, `splitHighlightedLines` |
| `diff-parse.ts` | `parseUnifiedDiff`, `toSplitRows`, `diffStats`, `makeUnifiedDiff` |
| `sessions.ts` | session id, title and search helpers; `liveConversationForSession` |
| `status.ts` | display text and tone for server and conversation status |
| `conversation-sync.ts` | `stateFromSnapshot`, `stateFromSessionFile`, `applyEvents` |

Put new pure logic in `lib/` with a `*.test.ts` next to it. No DOM test environment is installed.
