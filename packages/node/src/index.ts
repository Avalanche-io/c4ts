// @avalanche-io/c4-node — Node.js extensions for C4
// Re-exports core plus Node-specific implementations

export * from '../../core/src/index.js'
export { NodeFS } from './node-fs.js'
export { TreeStore, openStore } from './tree-store.js'
