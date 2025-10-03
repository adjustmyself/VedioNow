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

**Database (`src/database.js`)**
- MongoDB database wrapper class
- Manages video metadata, tags, and tag groups
- Handles CRUD operations for videos and tagging system

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

The MongoDB database includes these main collections:
- `videos` - Video file metadata, ratings, descriptions
- `tag_groups` - Tag categories with colors and sorting
- `tags` - Individual tags linked to groups
- `video_tag_relations` - Tag relationships for videos based on fingerprint

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

- The application uses Node.js integration in renderer processes
- Chinese language interface and comments throughout codebase
- Supports Windows, macOS, and Linux builds via electron-builder
- Uses fs-extra for enhanced file operations
- Chokidar provides cross-platform file watching
- No test framework currently configured (Jest listed but no tests present)

## Supported Video Formats

MP4, AVI, MKV, MOV, WMV, FLV, WebM, M4V, 3GP, OGV, OGG, MPG/MPEG, TS/MTS/M2TS