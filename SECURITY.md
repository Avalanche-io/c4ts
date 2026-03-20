# Security Policy

## Reporting a Vulnerability

To report a security vulnerability, email security@avalanche.io with:

- Description of the issue
- Steps to reproduce
- Impact assessment

**Response timeline:**
- Acknowledgment: within 48 hours
- Status update: within 7 days
- Resolution: within 30-90 days depending on severity

Do not open a public issue for security vulnerabilities.

## Security considerations

### c4m parsing

- The decoder rejects path traversal attempts (`../`, `./`, embedded separators)
- CR characters (0x0D) are rejected to prevent line-ending ambiguity
- Directive lines (starting with `@`) are rejected
- Patch C4 ID verification prevents content substitution attacks
- Maximum line length is implementation-defined

### Content stores

- Content is addressed by SHA-512 hash (SMPTE ST 2114:2017)
- Stores do not encrypt content at rest
- IndexedDBStore data is scoped to the browser origin
- TreeStore uses atomic writes (temp file + rename) to prevent partial writes

### Browser environment

- WebCrypto is used for all hashing (hardware-accelerated, constant-time)
- Web Worker pool communicates via structured clone (no shared memory)
- File System Access API requires explicit user permission for directory access
- IndexedDB storage is subject to browser storage quotas

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |
