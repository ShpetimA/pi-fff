# Fix for Issue #6: Windows OneDrive Sync Problem

## Problem Summary

When pi opens a terminal on Windows and the working directory is `C:\Users\<username>` (no `.git` found), pi-fff's FileFinder indexes the **entire home directory** as the project root. This causes:

- Unwanted bandwidth consumption
- Disk space bloat (cloud-only files become local)
- Slow scanning while OneDrive downloads large files
- Unnecessary OneDrive sync activity

## Root Cause

1. `resolveProjectRoot()` walks up from cwd looking for `.git`. When none is found, it falls back to `cwd`.
2. `FileFinder.create({ basePath: projectRoot })` then starts scanning all files under the home directory.
3. On Windows, OneDrive Files On-Demand keeps cloud-only files as lightweight placeholders (reparse points). When FFF's background scanner/watcher accesses these files, the Windows filesystem triggers OneDrive's hydration — downloading the actual file content from the cloud.

## Solution Implemented

Added a check in the `initialize()` method of `FffRuntime` to prevent scanning the home directory:

1. **New helper function** `isHomeDirectory(path: string): boolean`
   - Compares the resolved path with the user's home directory
   - Uses Node.js `homedir()` and `resolve()` for cross-platform compatibility

2. **Validation in `initialize()` method**
   - After resolving the project root, check if it's the home directory
   - If it is, return an error with a helpful message
   - Prevents FileFinder from being created and scanning the home directory

3. **Error message**
   - Clear and actionable: "Cannot index the home directory. Please navigate to a specific project directory instead."
   - Uses existing `RuntimeInitializationError` type for consistency

4. **Test coverage**
   - Added test `initialize rejects home directory as project root`
   - Verifies that initialization fails when cwd is the home directory
   - Checks that the error message contains appropriate guidance

## Changes Made

### `src/fff-runtime.ts`
- Added `isHomeDirectory()` helper function (lines 68-71)
- Added home directory validation in `initialize()` method (lines 834-845)

### `tests/fff-runtime.test.ts`
- Added test case for home directory rejection (lines 614-622)

## Benefits

1. **Prevents OneDrive sync issues**: On Windows, cloud-only files in OneDrive won't trigger unwanted downloads
2. **Performance**: Avoids indexing large home directories with thousands of files
3. **User experience**: Clear error message guides users to navigate to a proper project directory
4. **Cross-platform**: Works on Windows, macOS, and Linux (though the OneDrive issue is Windows-specific)
5. **Minimal code change**: Only 18 lines added, no breaking changes to existing functionality

## Alternative Approaches Considered

1. **Add `enableHomeDirScanning` option to FileFinder**: The `@ff-labs/fff-node` package already has this option, but it defaults to `false`. Our fix adds an explicit check in pi-fff to provide a better error message and prevent the issue at the application layer.

2. **Exclude OneDrive directory**: This would require platform-specific logic and wouldn't solve the general problem of indexing the entire home directory.

3. **Use `enableHomeDirScanning` option**: We could pass this option, but it's better to explicitly reject home directory scanning at the application level with a clear error message.

## Testing

All existing tests pass, plus the new test specifically for home directory rejection:
- Typecheck: ✓
- All 29 tests: ✓
- New test for home directory rejection: ✓

## Backward Compatibility

This is a **breaking change** for users who currently use pi-fff from their home directory. However:
- This is an edge case that causes significant problems (OneDrive sync issues)
- The error message provides clear guidance on how to proceed
- The fix prevents a more serious problem (unwanted file downloads and performance issues)