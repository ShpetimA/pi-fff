# pi-fff

![575872025-1a9fc348-19bc-489b-9de9-bb329728d234](https://github.com/user-attachments/assets/c9020bb7-f708-4f75-a802-6ac182b48e07)

`pi-fff` improves `@...` file path/search experience inside pi agent by using [`@ff-labs/fff-node`](https://www.npmjs.com/package/@ff-labs/fff-node) package for typo-resistant and fast file searching.

## Usage

In the editor, type:

```text
@readme
@src/index
@"folder with spaces/file"
```

Autocomplete suggestions will be provided from the current project directory.

## Installation

### From npm

```bash
pi install npm:pi-fff
```

### From git

```bash
pi install git+https://github.com/ShpetimA/pi-fff.git
```

Restart pi after installation.

## Package metadata

This package exposes a pi extension via:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```
