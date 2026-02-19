# Main.ts Refactoring Summary

## Overview
The original `main.ts` file was 1399 lines long and contained all the application logic in a single file. It has been successfully split into 8 modular files, each with a specific responsibility and none exceeding 500 lines.

## File Structure

### 1. **main.ts** (~125 lines)
The entry point of the application that orchestrates all other modules.
- Admin permission check
- App lifecycle management (quit, activate, second-instance)
- Protocol registration
- Service registry initialization
- Event handler initialization
- App startup flow

### 2. **settings.ts** (~55 lines)
Manages application settings and configuration.
- Settings schema definition using Zod
- `loadSettings()` - Loads settings from JSON file
- `getSettings()` - Returns current settings
- `updateSettings()` - Updates settings in memory
- `LocalSettings` type export

### 3. **window.ts** (~155 lines)
Handles all window-related operations.
- `createWindow()` - Creates and configures the main browser window
- Window preferences and permissions
- DevTools management
- Demo mode handling
- CORS header configuration
- `setupDisplayMetricsListener()` - Monitors display changes
- `appSize` - Window size configuration export

### 4. **langchain.ts** (~110 lines)
Manages the Langchain utility process.
- `spawnLangchainUtilityProcess()` - Spawns and manages the utility process
- `handleUtilityFunction()` - Generic handler for utility process communication
- `addDocumentToRAGList()` - RAG document management
- `embedInputUsingRag()` - RAG embedding operations
- `getLangchainChild()` - Returns the utility process reference

### 5. **utils.ts** (~80 lines)
Common utility functions used across the application.
- `isAdmin()` - Checks if running with admin privileges
- `needAdminPermission()` - Checks if admin permission is required
- `externalResourcesDir()` - Returns external resources directory path
- `getMediaDir()` - Returns media directory path
- `getAssetPathFromUrl()` - Converts URLs to file system paths

### 6. **ipcHandlers.ts** (~370 lines)
Core IPC handlers for main application features.
- Theme and locale settings
- Window management (zoom, resize, fullscreen)
- File operations (save image, drag start)
- Dialog handlers (open, save, message box)
- Model path management
- Model scanning (GGUF, OpenVINO, Embedding)
- RAG operations
- Image operations (open with system, show in folder)
- Developer tools

### 7. **ipcServiceHandlers.ts** (~390 lines)
IPC handlers for backend service management.
- Service information retrieval
- Service lifecycle (install, uninstall, start, stop, setup)
- Device detection and selection
- Backend readiness management
- Embedding server operations
- Transcription server operations (OpenVINO backend)
- Version management
- Service settings updates

### 8. **ipcComfyHandlers.ts** (~220 lines)
IPC handlers specifically for ComfyUI functionality.
- Preset management (reload, load user presets, save presets)
- Intel repo preset updates
- ComfyUI installation checks
- Git operations
- Python package management
- Custom node management (install, uninstall, list)

## Benefits

### Code Organization
- **Single Responsibility**: Each file has a clear, focused purpose
- **Maintainability**: Easier to find and modify specific functionality
- **Testability**: Smaller, focused modules are easier to unit test
- **Readability**: Developers can understand each module independently

### File Size Compliance
- **main.ts**: 125 lines (target: <500 lines) ✓
- **settings.ts**: 55 lines (target: <500 lines) ✓
- **window.ts**: 155 lines (target: <500 lines) ✓
- **langchain.ts**: 110 lines (target: <500 lines) ✓
- **utils.ts**: 80 lines (target: <500 lines) ✓
- **ipcHandlers.ts**: 370 lines (target: <500 lines) ✓
- **ipcServiceHandlers.ts**: 390 lines (target: <500 lines) ✓
- **ipcComfyHandlers.ts**: 220 lines (target: <500 lines) ✓

All files meet the requirement of being under 500 lines!

## Migration Notes

### Import Changes
Other files importing from `main.ts` may need to update their imports:
- `LocalSettings` type → `import from './settings.ts'`
- `appSize` → `import from './window.ts'`
- Utility functions → `import from './utils.ts'`

### Backup
The original `main.ts` has been backed up to `main.ts.backup` for reference.

## Dependencies Between Modules

```
main.ts
├── settings.ts (loads settings)
├── window.ts (creates window, display metrics)
├── langchain.ts (spawns utility process)
├── utils.ts (admin checks, paths)
├── ipcHandlers.ts (core IPC handlers)
├── ipcServiceHandlers.ts (service IPC handlers)
└── ipcComfyHandlers.ts (ComfyUI IPC handlers)

ipcHandlers.ts → uses settings, utils, langchain
ipcServiceHandlers.ts → uses settings
ipcComfyHandlers.ts → uses settings
```

## Testing Recommendations

1. **Verify app startup** - Ensure the app launches correctly
2. **Test window operations** - Zoom, resize, fullscreen, minimize
3. **Test service management** - Start/stop services, device selection
4. **Test ComfyUI features** - Preset loading, custom nodes
5. **Test RAG operations** - Document indexing, embeddings
6. **Test file operations** - Image saving, drag & drop
7. **Check admin permission flow** - Run with/without admin rights
8. **Verify single instance lock** - Try launching multiple instances

## Future Improvements

Consider further splitting if any file grows beyond 400 lines:
- `ipcHandlers.ts` could be split into `ipcCoreHandlers.ts` and `ipcModelHandlers.ts`
- `ipcServiceHandlers.ts` could separate transcription and embedding handlers

