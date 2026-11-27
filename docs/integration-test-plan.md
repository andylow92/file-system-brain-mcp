# Integration Test Plan (Manual Checklist)

## Scope

Validate end-to-end confidence for filesystem CRUD, markdown editing, preview parity, and persistence behavior across restarts.

## Preconditions

- Backend is running with a writable `CONTENT_ROOT` (`npm run dev:api`).
- Frontend is running and connected to backend API (`npm run dev:web`).
- API health check succeeds before UI validation (example: `curl -sf http://localhost:3001/health`).
- `CONTENT_ROOT` points to a mounted host directory when testing persistence.

## Checklist

### 1) Create directory and file

- [ ] Create a directory (example: `docs/guides`).
- [ ] Create a markdown file in that directory (example: `docs/guides/getting-started.md`).
- [ ] Confirm file appears in file tree immediately.
- [ ] Confirm backend returns success and no path traversal errors.

### 2) Edit markdown

- [ ] Open the markdown file from the tree.
- [ ] Switch to `Edit` tab.
- [ ] Update content with headings, lists, links, and code block.
- [ ] Trigger save and confirm UI indicates save completion.

### 3) Preview render parity

- [ ] Switch to `Preview` tab.
- [ ] Validate visible output is consistent with edited markdown content.
- [ ] Confirm no stale content remains after repeated edit/preview toggles.

### 4) Persist and reload

- [ ] Refresh browser.
- [ ] Re-open edited file and verify latest content is present.
- [ ] Restart backend process.
- [ ] Re-open file and confirm content remains available.
- [ ] If containerized, restart container and verify files still exist via mounted host volume.

### 5) Responsive layout (mobile file tree)

jsdom applies no media queries, so `apps/web` `responsiveStyles.test.ts` only checks the stylesheet
cascade; this pass checks the real rendering. Use the browser's device toolbar (touch emulation on)
or resize the window.

- [ ] At 390px wide (phone), a menu button shows at the left of the top bar, and nothing in the bar
      overlaps (logo, `Live`, `Saved`, Settings, Save).
- [ ] Tap the menu button: the file tree slides in just below the top bar over a dimmed backdrop.
      Tap the menu button again: it closes.
- [ ] Reopen it and pick a file: the drawer closes and the file opens. Reopening and then tapping the
      backdrop, or pressing `Escape`, also closes it.
- [ ] At 768px (tablet), the drawer behaves the same, and a long file path stays on one line,
      truncated with `…`, without growing the top bar.
- [ ] At 1280px (desktop), there is no menu button, the sidebar sits flush under the top bar, and a
      short note shows no page scrollbar.

## Exit Criteria

- All checklist items pass without data loss.
- No filesystem operations are allowed outside `CONTENT_ROOT`.
- Preview and editor maintain consistent markdown state after repeated saves and reloads.
