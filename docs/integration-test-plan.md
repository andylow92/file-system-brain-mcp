# Integration Test Plan (Manual Checklist)

## Scope

Validate end-to-end confidence for filesystem CRUD, markdown editing, preview parity, read-only HTML documents, and persistence behavior across restarts.

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

### 5) HTML documents (read-only)

Automated proof lives in `npm run test:browser` (real Chromium); this is the manual pass.

- [ ] Put a self-contained styled report (e.g. `reports/q3.html`, inline `<style>`) and a second, differently styled `.htm` file in `CONTENT_ROOT`.
- [ ] Confirm both appear in the tree with an **HTML** badge and the code-bracket icon; Rename and Delete are disabled for them, and they can't be dragged.
- [ ] Open the report: it renders with its own background, colours, and fonts; the app shell (tree, top bar, tabs) is unchanged.
- [ ] Switch to the second document: its design replaces the first's, with nothing carried over in either direction.
- [ ] **Source** shows the raw markup as text; **Split** and **Edit** are visibly disabled, show the read-only explanation on hover, and can't be activated by mouse or keyboard; the top bar reads **Read-only**.
- [ ] Edit the open `.html` file on disk: the preview refreshes on its own.
- [ ] Open a document containing `<script>`, an `onclick` handler, a form, external `<img>` / `<link>`, and `target="_top"` links; with DevTools open, confirm nothing runs, nothing is requested, and clicking links or submit leaves the app where it is.
- [ ] Open a markdown note again: Preview, Split, and Edit work as before and Source is gone.
- [ ] Check the tab bar in light and dark OS themes: each active tab shows its accent bar, and a keyboard focus ring (Tab into the bar, then arrow keys) is distinct from the active indicator.

## Exit Criteria

- All checklist items pass without data loss.
- No filesystem operations are allowed outside `CONTENT_ROOT`.
- HTML documents are never modified by the app and never reach the network or the app's state.
- Preview and editor maintain consistent markdown state after repeated saves and reloads.
