# hashline 18.1.5 Node compatibility

The private edit-format benchmark imports hashline's parser, block resolver,
and applier on Node 24/26. Version 18.1.5 eagerly loads its native syntax
parser, even when the applier is called without a path.

- `@oh-my-pi/pi-natives@18.1.5`: retain Bun's `import.meta.dir`, falling back
  to Node's `import.meta.dirname`. Native selection, version sentinels,
  loading errors, and the native binaries are unchanged.
- `@oh-my-pi/hashline@18.1.5`: retain Bun's syntax-cache hashing and use
  Node SHA-256 for process-local cache identity on Node. No public file
  hashes, anchors, edit algorithms, or syntax failure handling change.

These patches cover the benchmark's imported surface, not upstream's
Bun-only filesystem and file-tag APIs. The coding agent uses its own
workspace-tools hashline implementation, which is not replaced here.

`experimental/pss-edit-format-bench/src/hashline-node.test.ts` exercises the
real native parser, cache separation, boundary repair, and invalid anchors.
Re-evaluate both patches when updating their exact upstream versions.
