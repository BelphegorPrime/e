# CLI Tool

This is a CLI tool built with Node.js and Commander.

## Building Binaries

To build platform-specific binaries, you can use the following npm scripts:

### Build for Linux
```bash
npm run build:linux
```

### Build for macOS
```bash
npm run build:macos
```

### Build for Windows
```bash
npm run build:windows
```

### Build for All Platforms
```bash
npm run build:all
```

These commands will generate executables in the root of the CLI package:
- `e` (Linux)
- `e` (macOS)
- `e.exe` (Windows)

## Prerequisites

- Node.js 18+
- pkg (automatically installed as devDependency)

## Usage

After building, you can run the binaries directly:
```bash
./e hello
./e.exe hello
```