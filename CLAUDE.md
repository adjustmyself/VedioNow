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
- Dual backend: SQLite (better-sqlite3, default for new installs, stored at `data/videonow.db`) and MongoDB
- `DatabaseFactory.create()` picks the backend from `data/config.json` (`database.type`: `sqlite` | `mongodb`)
- Both implement the same `DatabaseInterface`; all methods return identical shapes (string ids, paginated `{videos, total, page, pageSize, totalPages}`)
- `src/mongoToSqliteMigration.js` provides one-shot MongoDB→SQLite data migration (triggered from settings UI)
- Video identity is a content fingerprint (`src/fileFingerprint.js`): MD5 of size + first/last 64KB, deliberately excluding mtime; when a video's fingerprint changes, `addVideo` cascades the change into tag relations and collections

**VideoScanner (`src/videoScanner.js`)**
- Scans directories for video files
- Supports 13+ video formats (MP4, AVI, MKV, etc.)
- Uses Chokidar for file system monitoring
- Handles both local and network drive paths

**Renderer Process (`src/renderer/`)**
- `index.html` - Main application interface
- `renderer.js` - VideoManager class handling UI logic
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
└── renderer/
    ├── index.html       # Main UI
    ├── renderer.js      # Frontend logic (VideoManager class)
    ├── styles.css       # Main styles
    └── tag-manager.*    # Tag management window
data/                    # Thumbnails and config storage
dist/                    # Build output directory
```

## Development Notes

- The application uses Node.js integration in renderer processes; all dynamic HTML must go through `escapeHtml()` (filenames from disk are untrusted input)
- Renderer never uses `shell` directly — file opening goes through the `open-path` IPC handler
- Chinese language interface and comments throughout codebase
- Supports Windows, macOS, and Linux builds via electron-builder
- Uses fs-extra for enhanced file operations
- Chokidar provides cross-platform file watching
- FFmpeg is bundled via `ffmpeg-static` (PATH `ffmpeg` is the fallback); `asarUnpack` in package.json keeps the binary spawnable after packaging
- Tests live in `tests/` and run via `npm test`, which executes Jest through Electron's Node (`ELECTRON_RUN_AS_NODE`) so native modules (better-sqlite3) match the Electron ABI — plain `npx jest` will fail with ABI errors
- `getVideos()`/`searchVideos()` are paginated (default 9/page); maintenance code that needs every video must use `getAllVideoRefs()`

## Supported Video Formats

MP4, AVI, MKV, MOV, WMV, FLV, WebM, M4V, 3GP, OGV, OGG, MPG/MPEG, TS/MTS/M2TS