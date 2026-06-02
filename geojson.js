// Classic-resolver entry point for `flatrecord/geojson`.
//
// The canonical mapping is the "./geojson" subpath in package.json `exports`.
// Resolvers that don't read `exports` — notably Metro's classic resolver with
// `unstable_enablePackageExports` off — look for a real file at this path
// instead. This shim re-exports the built module so those bundlers resolve
// `flatrecord/geojson` with no extra configuration. Exports-aware resolvers
// (Node, bundlers with package-exports on) use `exports` and never load it.
export * from './lib/mjs/geojson.js'
