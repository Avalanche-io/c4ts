/** Sentinel errors for the c4m package. */

export class C4Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'C4Error'
  }
}

export class InvalidEntryError extends C4Error {
  constructor(detail?: string) {
    super(detail ? `c4m: invalid entry: ${detail}` : 'c4m: invalid entry')
    this.name = 'InvalidEntryError'
  }
}

export class DuplicatePathError extends C4Error {
  constructor(path: string) {
    super(`c4m: duplicate path: ${path}`)
    this.name = 'DuplicatePathError'
  }
}

export class PathTraversalError extends C4Error {
  constructor(name: string) {
    super(`c4m: path traversal: ${name}`)
    this.name = 'PathTraversalError'
  }
}

export class InvalidFlowTargetError extends C4Error {
  constructor(target?: string) {
    super(target ? `c4m: invalid flow target: ${target}` : 'c4m: invalid flow target')
    this.name = 'InvalidFlowTargetError'
  }
}

export class PatchIDMismatchError extends C4Error {
  constructor(line: number, got: string, want: string, detail?: string) {
    super(
      detail
        ? `c4m: patch ID does not match prior content (line ${line}): ${detail}`
        : `c4m: patch ID does not match prior content: line ${line}: got ${got}, want ${want}`,
    )
    this.name = 'PatchIDMismatchError'
  }
}

/**
 * The stream ends with a bare C4 ID. A c4m file never ends with its own ID:
 * a bare ID is a boundary before a patch, and a file that ends with one is a
 * format error (ruled 2026-11-08). Files written by c4 1.0.13 through 1.0.26
 * with `c4 diff >>` have this shape; c4 1.1's `c4 id FILE.c4m` rewrites them.
 * `line` is the line of the trailing ID.
 */
export class TrailingIDError extends C4Error {
  constructor(line: number) {
    super(
      `c4m: a bare C4 ID ends the file; a c4m file never ends with its own ID (line ${line}): ` +
        'delete that line, or rewrite the file with `c4 id FILE.c4m > fixed.c4m`',
    )
    this.name = 'TrailingIDError'
  }
}

export class EmptyPatchError extends C4Error {
  constructor(detail?: string) {
    super(detail ? `c4m: empty patch section (${detail})` : 'c4m: empty patch section')
    this.name = 'EmptyPatchError'
  }
}

export class BadIDLengthError extends C4Error {
  constructor(length: number) {
    super(`c4 ids must be 90 characters long, input length ${length}`)
    this.name = 'BadIDLengthError'
  }
}

export class BadIDCharError extends C4Error {
  constructor(position: number) {
    super(`non c4 id character at position ${position}`)
    this.name = 'BadIDCharError'
  }
}
