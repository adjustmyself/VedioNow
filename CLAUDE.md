# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VideoNow is an Electron-based desktop video management application that supports tagging systems and smart search capabilities for both local and network drive video files. The application uses a Chinese interface and is designed for managing large video collections.

## Development Commands

```bash
# Start development mode with DevTools
npm run dev

# Start production version
npm start

# Build executable for distribution
npm run build

# Run tests
npm test
```

The development mode (`npm run dev`) automatically opens Chrome DevTools for debugging.

## Architecture

This is an Electron application with a main/renderer process architecture:

### Main Process (`src/main.js`)
- Entry point for the Electron application
- Handles IPC communication with renderer
- Manages window creation and app lifecycle
- Integrates Database and VideoScanner classes

### Core Components

**Database (`src/database.js`, `src/sqliteDatabase.js`)**
- Dual backend: SQLite (better-sqlite3, default for new installs, stored at `<userData>/videonow.db`) and MongoDB
- `DatabaseFactory.create()` picks the backend from `<userData>/config.json` (`database.type`: `sqlite` | `mongodb`)
- All writable user data (config, SQLite db, thumbnails, tag images) lives under `app.getPath('userData')` via `src/appPaths.js`, except that images and backups can be relocated (see "Storage locations" below); the old in-app `data/` folder is migrated once on startup (`migrateLegacyAppData()` in main.js) because repackaging overwrites anything stored next to the code
- Both implement the same `DatabaseInterface`; all methods return identical shapes (string ids, paginated `{videos, total, page, pageSize, totalPages}`)
- `src/mongoToSqliteMigration.js` provides one-shot MongoDB→SQLite data migration (triggered from settings UI)
- Video identity is a content fingerprint (`src/fileFingerprint.js`): MD5 of size + first/last 64KB, deliberately excluding mtime; when a video's fingerprint changes, `addVideo` cascades the change into tag relations and collections
- Duplicate files (same content at another path that still exists) are copies, not moves: each copy gets its own record with fingerprint `<base>:dup:<pathHash>` (`FileFingerprint.duplicateFingerprint`), and `getDuplicateVideos()` finds all records sharing the base fingerprint. SQLite exposes the base as the generated column `content_fingerprint`; Mongo derives duplicate groups at query time (`_duplicateGroups()`, read-only). List queries return `duplicate_count` and accept `filters.duplicatesOnly`

**VideoScanner (`src/videoScanner.js`)**
- Scans directories for video files
- Supports 13+ video formats (MP4, AVI, MKV, etc.)
- Uses Chokidar for file system monitoring
- Handles both local and network drive paths

**Renderer Process (`src/renderer/`)**
- `index.html` - Main application interface
- `renderer.js` - ES module (loaded with `type="module"`); VideoManager class core (state, loading/search, grid rendering); feature methods live in `modules/*.js` as mixin classes merged into `VideoManager.prototype` (thumbnails, tagFilterBar, videoModal, scanModal, pagination, collections, batchSelection, savedSearches, hoverPreview, gridLayout)
- `shared/util.js` - ES module helpers shared by windows (`escapeHtml`, `toFileUrl`, `toTagImageUrl`, `debounce`); Node-free, tested in `tests/rendererUtil.test.js` via a child process because Jest can't load ESM
- `styles.css` - Main application styles
- `tag-manager.html/js/css` - Separate tag management window

### Key Features

- **Video Management**: Automatic scanning, database storage, file monitoring
- **Tagging System**: Hierarchical tags with groups, colors, and descriptions
- **Search & Filter**: Real-time search by filename and tag filtering
- **View Modes**: Grid and list views with multiple sorting options
- **Rating System**: 1-5 star rating for videos
- **Network Drive Support**: Windows UNC paths and mapped drives

## Database Schema

Main collections/tables (Mongo name / SQLite name):
- `videos` - Video file metadata, ratings, descriptions
- `tag_groups` - Tag categories with colors and sorting
- `tags` - Individual tags linked to groups
- `video_tag_relations` / `video_tags` - Tag relationships keyed by fingerprint (Mongo: one doc with tags array; SQLite: one row per fingerprint+tag)
- `video_collections` - Series/collection grouping (main video + ordered child videos)

## File Structure

```
src/
├── main.js              # Electron main process
├── database.js          # MongoDB database operations
├── videoScanner.js      # Directory scanning and monitoring
├── appPaths.js          # userData path resolution (main/renderer/plain node)
└── renderer/
    ├── index.html       # Main UI
    ├── renderer.js      # Frontend logic (VideoManager core + mixin wiring)
    ├── modules/         # VideoManager method groups (mixins)
    ├── shared/util.js   # Shared renderer helpers
    ├── styles.css       # Main styles
    └── tag-manager.*    # Tag management window
data/                    # Legacy storage location, migrated to userData on startup
dist/                    # Build output directory
```

## Development Notes

- Renderer windows run with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`: no `require`/Node in page code. Everything goes through `window.api.invoke/send/on` exposed by `src/preload.js`, which allowlists channels — **a new IPC channel must be added to the preload allowlist** or calls are rejected. `window.api.on` listeners receive only the payload (no event object) and the call returns an unsubscribe function. Anything needing Node (file writes, clipboard, shell) is a main-process IPC handler; e.g. canvas thumbnails are sent as JPEG bytes to `save-renderer-thumbnail`
- All dynamic HTML must still go through `escapeHtml()` (filenames from disk are untrusted input)
- Chinese language interface and comments throughout codebase
- Supports Windows, macOS, and Linux builds via electron-builder
- Uses fs-extra for enhanced file operations
- Chokidar provides cross-platform file watching
- FFmpeg is bundled via `ffmpeg-static` (PATH `ffmpeg` is the fallback); `asarUnpack` in package.json keeps the binary spawnable after packaging
- Tests live in `tests/` and run via `npm test`, which executes Jest through Electron's Node (`ELECTRON_RUN_AS_NODE`) so native modules (better-sqlite3) match the Electron ABI — plain `npx jest` will fail with ABI errors
- `getVideos()`/`searchVideos()` are paginated (default 9/page) and sorted server-side via whitelisted `filters.sortBy`/`sortOrder`; maintenance code that needs every video must use `getAllVideoRefs()`
- Tag relations are stored by name, so a relation can exist without a `tags` row ("orphan tag"). On startup `ensureCollectionTag()` puts the auto-added `合集` tag into the `系統` group (`src/systemTags.js`), then `backfillOrphanTags()` creates any remaining orphans in 未分類
- Open stats: every successful `open-path` calls `recordVideoPlay(filepath)` (`play_count` +1, `last_played_at`); playback is in an external player, so watch duration is not tracked. List queries accept `filters.unwatchedOnly` (play_count 0 or NULL/missing)
- Rescans skip files whose size + `file_mtime` are unchanged (reusing the stored fingerprint); SQLite scans write through `addVideosBatch()`
- Video `duration` is never read during scans: it is captured when a thumbnail is made — FFmpeg path via `thumbnailGenerator.onDuration` → `setVideoDuration()`, `<video>`/canvas path via the `set-video-duration` IPC. Old records are filled by the settings-page `backfill-durations` IPC (`probeDuration()` reads only the header). Rescans keep the stored duration unless the fingerprint changed
- Batch multi-select (`modules/batchSelection.js`): selection is a `Map(id → {fingerprint, tags…})` kept across pages/filters; Ctrl/Shift/checkbox click toggles, plain click toggles while selecting, double-click opens details. Batch DB methods (both backends): `addTagToVideos`, `removeTagFromVideos`, `setVideosRating` (rating only, unlike `setVideoMetadata`), and `getMatchingVideoRefs(searchTerm, tags, filters)` for "select all matching". Batch delete removes records only (`deleteVideosByIds`)
- Auto-tag rules (`src/autoTagRules.js`, stored in `config.autoTagRules`): filename or full-path keyword/regex (case-insensitive) → tags. `VideoScanner.onVideosSaved(filepaths)` (wired in main's `createVideoScanner()`) applies enabled rules only to new/changed files from a scan or the watcher, so manually removed tags aren't re-added; settings page can preview counts and apply to all videos. New tag names get tag rows via `backfillOrphanTags()`
- Saved searches live in `config.savedSearches` (backend-independent, included in backups); `Config.normalizeSavedSearch()` whitelists fields (search term, tags, rating, drive, duplicates/unwatched, sortBy/sortOrder). Applying one sets all filter state + sidebar UI and runs a single `handleSearch`; `renderSavedSearches()` re-highlights the matching entry after every search/page fetch
- Storage locations: `config.storage.imagesDir` (parent of `thumbnails/`, `previews/`, `tag-images/`) and `config.storage.backupDir` (parent of `auto/`, `pre-restore/`); empty string = default under userData (`Config.getStoragePaths()`). main.js reads them once at startup into `storagePaths` (`getImagesDir()`/`getBackupsDir()`) and passes them to `ThumbnailGenerator({imagesDir})` and `BackupManager`. The settings page changes them via `change-storage-dir`, which uses `src/storageMover.js` to copy everything, save the config, and only then delete the old files. Changing the images dir relaunches the app; changing the backup dir just resets `backupManager`. `reset-config` and restore both keep the current `storage` section
- Thumbnails live in `<imagesDir>/thumbnails` named `fp-<base fingerprint>.jpg` (`ThumbnailGenerator.thumbnailKey()`; copies share one, moves/renames keep it); records without a fingerprint fall back to the legacy path-MD5 name. `thumbnailExists(path, fingerprint)` renames a legacy-named file on first lookup, and `cleanupThumbnails(refs)` treats both names as valid. Every thumbnail IPC therefore takes the video's fingerprint (cards carry `data-fingerprint`)
- Hover previews: `ThumbnailGenerator.generatePreview()` makes a 10-frame 3200x180 strip (one FFmpeg run, one fast-seek input per frame at 5%–95%, letterboxed to 320x180) in `<userData>/previews` with the same `fp-` naming as thumbnails; generated lazily on the first 350ms hover via the `get-preview` IPC, which returns `disabled` when `config.app.hoverPreview` is false. `PREVIEW_FRAMES` is defined only in `thumbnailGenerator.js`; `get-preview` returns it as `frames` and the renderer slices the strip by that. Grid cards only, and cards with a description keep showing the description instead. `cleanupThumbnails()`/`getThumbnailStats()` cover both folders
- Settings page saves through `Config.updateSettings()`, which replaces only the `database`/`app` sections — never `config.save()` the renderer's partial object, it would wipe scan paths, watched folders, saved searches and auto-tag rules
- Watched folders persist in `config.scan.watchedFolders` (`[{path, recursive}]`, added when a scan has "監看" checked). ~5s after startup and after every `recreateDatabase()`, `syncWatchedFolders()` runs `VideoScanner.syncWatchedFolders()`: an incremental scan per folder (no missing-file cleanup, unreachable folders skipped) that re-arms chokidar; progress goes to the main window's `background-scan-status` pill. `shutdownDataLayer()` calls `videoScanner.dispose()` so a stale scanner can't re-add watchers
- Backups (`src/backupManager.js`, SQLite only): a `VideoNow-backup-<YYYYMMDD-HHmmss>/` folder with `videonow.db` (online `db.backup()`), `config.json`, `tag-images/`, `manifest.json`, plus `thumbnails/` when `config.app.backupThumbnails` is on (default; previews are never backed up). Auto backup runs ~15s after startup at most once per 24h into `<backupDir>/auto`, keeping `config.app.autoBackupKeep` copies (default 7, clamped 1–60 by `BackupManager.normalizeKeep()`; lowering it prunes only after the next auto backup). Restore first backs up current data (without thumbnails) to `<backupDir>/pre-restore`, closes the DB, replaces the DB and tag images, merges thumbnails without overwriting, keeps the current `database` and `storage` config sections, and relaunches
- Grid view columns come from `modules/gridLayout.js`: `gridColumnsForWidth()` (floor of sqrt(content width / 100), so cards grow with the screen: 1080p 4, 2K 4, 4K@100% 5) is the starting column count. The grid view must never scroll: cards have a fixed height (16:9 thumbnail via `.video-card` size container + `height: 56.25cqw`, plus `.video-card-content` fixed at `--card-content-height`; card tags stay on one line and `fitCardTags()` folds the overflow into "+N"), and `planGrid()` (fed by a ResizeObserver on `.content` and the pagination bar) picks columns from the width only and rows from the visible height; the configured page size only applies to list view. The batch bar is absolutely positioned over the toolbar (`--toolbar-height`) so entering multi-select neither scrolls nor repaginates. If you change card text-area content or the toolbar/pagination/grid padding, keep `--card-content-height` / `--pagination-min-height` in sync. `.videos-grid` needs `grid-auto-rows: max-content`: the grid has a fixed height (flex:1), and with `auto` rows that don't fit, rows only grow from the card's min-height into the leftover space, so the next row covers the previous row's tags. In grid mode the page size is `gridColumns × gridRows` (`pageSizeForView()`; falls back to the setting rounded to full rows before the first measurement); always use `pageSizeForView()` instead of `this.pageSize` for limit/offset math, and call `repaginate(previousSize)` when the effective size changes (column change, grid/list switch)
- The top tag filter bar has a fixed height so filtering never changes the grid rows: selected tags render on its first row (`#tag-pinned`, one line, scrolls sideways), and a group's tags (or tag-search matches) show in `.tag-tab-content`, an absolutely positioned dropdown over the content, open only while `tagPanelOpen` (opened by clicking a group tab or typing in the tag search; closed by clicking outside the bar, Esc, or clicking the same tab)
- Renderer pages (including splash) have a CSP meta tag: no inline scripts/handlers — bind events in JS; file paths must go through `toFileUrl()`. `theme.js` and `splash.js` stay classic scripts (theme must apply synchronously in `<head>`)

## Supported Video Formats

MP4, AVI, MKV, MOV, WMV, FLV, WebM, M4V, 3GP, OGV, OGG, MPG/MPEG, TS/MTS/M2TS