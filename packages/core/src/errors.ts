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
  constructor(line: number, got: string, want: string) {
    super(`c4m: patch ID does not match prior content: line ${line}: got ${got}, want ${want}`)
    this.name = 'PatchIDMismatchError'
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
