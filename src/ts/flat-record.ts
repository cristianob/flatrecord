import * as flatbuffers from 'flatbuffers';
import { toByteReader, type ByteReader } from './byte-reader.js';
import { isValidMagicBytes, magicbytes, SIZE_PREFIX_LEN } from './constants.js';
import { crc32 } from './crc32.js';
import { Feature } from './fbs/feature.js';
import { fromFeature, type IGeoJsonFeature } from './geojson/feature.js';
import { parseLink } from './link.js';
import {
    flatRecordMetaOf,
    type DeserializeResult,
    type Link,
    type FlatRecordMeta,
    type FlatRecordMode,
    type Row,
} from './link-types.js';
import { fromByteBuffer, type HeaderMeta, type ColumnIndexLocation } from './header-meta.js';
import {
    DEFAULT_NODE_SIZE,
    NODE_ITEM_BYTE_LEN,
    generateLevelBounds,
    type Rect,
    streamSearch,
} from './packedrtree.js';
import {
    parsePropertyIndexBlock,
    searchBool,
    searchNumeric,
    searchText,
    type PropertyIndex,
    type TextQueryOptions,
    type ValuePredicate,
    type ValueQueryOptions,
} from './property-index.js';
import { runShortestPath, type ShortestPathOptions, type ShortestPathResult } from './shortest-path.js';

/** Result yielded by `findFeaturesByText` / `findLinksByText`. `tier`
 *  reflects how the candidate matched the query:
 *  - `'A'`: query tokens appear consecutive and in the query's order
 *  - `'B'`: query tokens appear in order with gaps
 *  - `'C'`: query tokens all present, possibly out of order
 *  Results are emitted in tier order (A → B → C), then by earliest
 *  matched position. `index` is the storage index of the record in
 *  the file. */
export type TextHit<T, Key extends 'feature' | 'link' = 'feature'> = Key extends 'link'
    ? { link: T; tier: 'A' | 'B' | 'C'; index: number }
    : { feature: T; tier: 'A' | 'B' | 'C'; index: number };

/** Convenient pointer to a single feature by property lookup, accepted
 *  anywhere `shortestPath` (and similar) takes a feature index. The
 *  underlying column must have been declared in `writeColumnIndex.features`
 *  at write time. Matches the first record whose normalised text
 *  token / numeric value / boolean equals `value`; throws when no
 *  record matches. */
export interface FeatureLookup {
    column: string;
    value: string | number | boolean;
}

const EMPTY_PROP_INDEX = (): PropertyIndex => ({
    text: new Map(),
    numeric: new Map(),
    bool: new Map(),
});

function mergePropertyIndex(into: PropertyIndex, from: PropertyIndex): void {
    for (const [k, v] of from.text) into.text.set(k, v);
    for (const [k, v] of from.numeric) into.numeric.set(k, v);
    for (const [k, v] of from.bool) into.bool.set(k, v);
}

/**
 * Reader installed in place of the real byte source by
 * `preload({ detach: true })`. The source buffer has been released, so any
 * read that escaped the in-memory caches is a wrong assumption by the
 * caller — fail loudly instead of returning bogus bytes.
 */
const DETACHED_READER: ByteReader = {
    read(): never {
        throw new Error(
            'FlatRecord: reader detached by preload({ detach: true }); all data is ' +
                'served from in-memory caches. Re-open the file to read uncached data.',
        );
    },
};

/**
 * In-memory random-access reader over a FlatRecord file backed by an arbitrary
 * `ByteReader`. The constructor (`open`) parses only the FlatRecord header — every
 * subsequent piece (features, links, indices) is located via the header's
 * directory of absolute offsets and read lazily as queried. Safe to open
 * on multi-gigabyte files (including remote ones) as long as the underlying
 * `ByteReader` supports random access.
 *
 * The file is one of four modes (see `mode`):
 *  - `table`     — features only, no geometry
 *  - `geo`       — features with geometry
 *  - `graph`     — features (no geometry) + links
 *  - `geograph`  — features (with geometry) + links
 *
 * Methods that don't make sense in a given mode (`featuresInBbox` on a
 * `table` file, `outgoingLinksOf` on a `geo` file, etc.) throw a
 * descriptive error.
 */
export class FlatRecord {
    /** Underlying byte source for all I/O performed by this instance. */
    readonly reader: ByteReader;
    readonly header: HeaderMeta;

    private readonly featureCache = new Map<number, IGeoJsonFeature>();
    private readonly outgoingLinksCache = new Map<number, Link[]>();
    private readonly incomingLinksCache = new Map<number, Link[]>();
    private readonly linkCache = new Map<number, Link>();
    /** Lazy: per-link byte offset in the links block, in storage order.
     *  Populated on first random-access by storage index. */
    private linkStorageOffsetsCache: Uint32Array | null = null;
    private linksSectionBytes: Uint8Array | null = null;
    private featureSpatialIndexBytes: Uint8Array | null = null;
    private linkSpatialIndexBytes: Uint8Array | null = null;
    private linkAdjacencyIndexBytes: Uint8Array | null = null;
    private linkReverseAdjacencyIndexBytes: Uint8Array | null = null;
    private featurePropertyIndex: PropertyIndex = EMPTY_PROP_INDEX();
    private linkPropertyIndex: PropertyIndex = EMPTY_PROP_INDEX();
    private loadedFeatureCols = new Set<string>();
    private loadedLinkCols = new Set<string>();
    private featureSpatialIndexFirstLeafCache: number | null = null;

    private constructor(reader: ByteReader, header: HeaderMeta) {
        this.reader = reader;
        this.header = header;
    }

    /**
     * Open the file: read magic + header (one range request) and parse
     * the directory. Doesn't touch payload blocks.
     */
    static async open(source: Uint8Array | ByteReader): Promise<FlatRecord> {
        const reader = toByteReader(source);

        const magicAndLen = await reader.read(0, magicbytes.length + SIZE_PREFIX_LEN);
        if (!isValidMagicBytes(magicAndLen)) {
            throw new Error('Not a FlatRecord file (invalid magic bytes)');
        }
        const headerLength = new DataView(
            magicAndLen.buffer,
            magicAndLen.byteOffset + magicbytes.length,
        ).getUint32(0, true);

        // Pull the header bytes plus the 4-byte CRC slot in one read.
        const headerAndCrc = await reader.read(
            magicbytes.length,
            SIZE_PREFIX_LEN + headerLength + 4,
        );
        const headerBb = new flatbuffers.ByteBuffer(headerAndCrc);
        const header = fromByteBuffer(headerBb);

        const crcView = new DataView(
            headerAndCrc.buffer,
            headerAndCrc.byteOffset + SIZE_PREFIX_LEN + headerLength,
        );
        header.headerCrc32 = crcView.getUint32(0, true);

        // Verify the CRC when the writer set one. A mismatch means the
        // header was corrupted in transit / on disk — fail fast with a
        // clear message rather than chasing bogus directory offsets.
        if (header.headerCrc32 !== 0) {
            const headerOnly = headerAndCrc.subarray(0, SIZE_PREFIX_LEN + headerLength);
            const computed = crc32(headerOnly);
            if (computed !== header.headerCrc32) {
                throw new Error(
                    `FlatRecord header CRC mismatch (expected 0x${header.headerCrc32
                        .toString(16)
                        .padStart(8, '0')}, computed 0x${computed.toString(16).padStart(8, '0')}). File is corrupted.`,
                );
            }
        }

        return new FlatRecord(reader, header);
    }

    /** Number of features in the file. */
    get featuresCount(): number {
        return this.header.featuresCount;
    }
    /** Number of links in the file. */
    get linksCount(): number {
        return this.header.linksCount;
    }
    /** `true` when at least one feature carries geometry (`geo` /
     *  `geograph` modes). */
    get hasGeometry(): boolean {
        return this.header.hasFeatureGeometry;
    }
    /** `true` when the dataset has links. */
    get hasLinks(): boolean {
        return this.header.linksBlock.length > 0;
    }
    /** Inferred mode of the file. */
    get mode(): FlatRecordMode {
        const g = this.hasGeometry;
        const l = this.hasLinks;
        if (g && l) return 'geograph';
        if (g) return 'geo';
        if (l) return 'graph';
        return 'table';
    }

    /** Snapshot of structural metadata + derived mode. */
    meta(): FlatRecordMeta {
        return flatRecordMetaOf(this.header);
    }

    // ───────────────────────── Feature access ──────────────────────────

    /**
     * Read a single feature by its storage index. Each feature is parsed
     * at most once per instance and cached.
     */
    async getFeature(index: number): Promise<IGeoJsonFeature> {
        if (index < 0 || index >= this.header.featuresCount) {
            throw new Error(`Feature index out of range: ${index} (have ${this.header.featuresCount})`);
        }
        const cached = this.featureCache.get(index);
        if (cached) return cached;

        if (this.hasGeometry && this.header.featureSpatialIndex.length > 0) {
            const offset = await this.featureOffsetViaSpatialIndex(index);
            const { bytes } = await this.readSizePrefixedRecord(
                this.header.featuresBlock.offset + offset,
                this.header.featuresBlock.length - offset,
            );
            const feature = parseFeatureBytes(bytes, this.header, index);
            this.featureCache.set(index, feature);
            return feature;
        }

        // No spatial index → bulk load (cheaper than N walks).
        await this.loadFeatures();
        const f = this.featureCache.get(index);
        if (!f) throw new Error(`Internal: getFeature(${index}) missing after loadFeatures()`);
        return f;
    }

    /** Async iterator over all features in storage order. */
    async *features(): AsyncGenerator<IGeoJsonFeature, void, unknown> {
        for (let i = 0; i < this.header.featuresCount; i++) {
            yield await this.getFeature(i);
        }
    }

    /**
     * Async iterator yielding every feature whose bounding box
     * intersects `rect`, using the packed Hilbert R-tree.
     * Requires the file to have been serialized with `writeSpatialIndex: true`
     * (the default) and to actually have geometry.
     */
    async *featuresInBbox(rect: Rect): AsyncGenerator<IGeoJsonFeature, void, unknown> {
        if (!this.hasGeometry) {
            throw new Error('File has no geometry. Re-serialize with feature geometries.');
        }
        if (this.header.featureSpatialIndex.length === 0) {
            throw new Error('File has no feature spatial index. Re-serialize with writeSpatialIndex: true.');
        }
        if (this.header.featuresCount === 0) return;

        const readNode = this.makeRTreeNodeReader(
            this.header.featureSpatialIndex.offset,
            this.featureSpatialIndexBytes,
        );

        for await (const [byteOffset, featureIdx] of streamSearch(
            this.header.featuresCount,
            this.header.indexNodeSize,
            rect,
            readNode,
        )) {
            const cached = this.featureCache.get(featureIdx);
            if (cached) {
                yield cached;
                continue;
            }
            const { bytes } = await this.readSizePrefixedRecord(
                this.header.featuresBlock.offset + byteOffset,
                this.header.featuresBlock.length - byteOffset,
            );
            const feature = parseFeatureBytes(bytes, this.header, featureIdx);
            this.featureCache.set(featureIdx, feature);
            yield feature;
        }
    }

    /**
     * Materialize the entire dataset, returning the same discriminated
     * `DeserializeResult` shape as the top-level `deserialize()`
     * function: `{ mode: 'geo' | 'geograph', features, adjacencyList }`
     * on files with geometry, `{ mode: 'table' | 'graph', rows,
     * adjacencyList }` otherwise. Warms caches.
     */
    async toGeoJson(): Promise<DeserializeResult<IGeoJsonFeature>> {
        const features = await this.loadFeatures();
        const links: Link[] = [];
        if (this.hasLinks) {
            for await (const l of this.allLinks()) links.push(l);
        }
        const adjacencyList = { links };
        if (this.hasGeometry) {
            return { mode: this.mode as 'geo' | 'geograph', features, adjacencyList };
        }
        const rows = features.map((f) => (f.properties ?? {}) as Row);
        return { mode: this.mode as 'table' | 'graph', rows, adjacencyList };
    }

    /**
     * Eagerly deserialize every feature into an array and populate the
     * cache. Single bulk range request over the features block.
     * Idempotent.
     */
    async loadFeatures(): Promise<IGeoJsonFeature[]> {
        const fc = this.header.featuresCount;
        const all: IGeoJsonFeature[] = new Array(fc);
        if (fc === 0) return all;

        if (this.featureCache.size === fc) {
            for (let i = 0; i < fc; i++) all[i] = this.featureCache.get(i) as IGeoJsonFeature;
            return all;
        }

        const sectionBytes = await this.reader.read(
            this.header.featuresBlock.offset,
            this.header.featuresBlock.length,
        );
        let cursor = 0;
        for (let i = 0; i < fc; i++) {
            const size = new DataView(sectionBytes.buffer, sectionBytes.byteOffset + cursor).getUint32(0, true);
            const featureBytes = sectionBytes.subarray(cursor, cursor + SIZE_PREFIX_LEN + size);
            const feature = parseFeatureBytes(featureBytes, this.header, i);
            all[i] = feature;
            this.featureCache.set(i, feature);
            cursor += SIZE_PREFIX_LEN + size;
        }
        return all;
    }

    // ─────────────────────────── Link access ───────────────────────────

    /**
     * Async iterator over the outgoing links of `featureIdx`, using the
     * CSR adjacency index. Requires `writeAdjacencyIndex: true`.
     */
    async *outgoingLinksOf(featureIdx: number): AsyncGenerator<Link, void, unknown> {
        if (!this.hasLinks) {
            throw new Error('File has no links. Re-serialize with an adjacency list.');
        }
        if (this.header.linkAdjacencyIndex.length === 0) {
            throw new Error('File has no adjacency index. Re-serialize with writeAdjacencyIndex: true.');
        }
        if (featureIdx < 0 || featureIdx >= this.header.featuresCount) {
            throw new Error(`Feature index out of range: ${featureIdx} (have ${this.header.featuresCount})`);
        }

        let links = this.outgoingLinksCache.get(featureIdx);
        if (!links) {
            links = await this.fetchOutgoingLinks(featureIdx);
            this.outgoingLinksCache.set(featureIdx, links);
        }
        for (const l of links) yield l;
    }

    private async fetchOutgoingLinks(featureIdx: number): Promise<Link[]> {
        const adjOffset = this.header.linkAdjacencyIndex.offset;
        let start: number;
        let end: number;
        if (this.linkAdjacencyIndexBytes !== null) {
            const view = new DataView(
                this.linkAdjacencyIndexBytes.buffer,
                this.linkAdjacencyIndexBytes.byteOffset + featureIdx * 4,
            );
            start = view.getUint32(0, true);
            end = view.getUint32(4, true);
        } else {
            const offsetsBytes = await this.reader.read(adjOffset + featureIdx * 4, 8);
            const offsetsView = new DataView(offsetsBytes.buffer, offsetsBytes.byteOffset);
            start = offsetsView.getUint32(0, true);
            end = offsetsView.getUint32(4, true);
        }

        if (start === end) return [];

        const spanBytes =
            this.linksSectionBytes !== null
                ? this.linksSectionBytes.subarray(start, end)
                : await this.reader.read(this.header.linksBlock.offset + start, end - start);

        const columns = this.header.linkColumns;
        const links: Link[] = [];
        let cursor = 0;
        while (cursor < spanBytes.byteLength) {
            const size = new DataView(spanBytes.buffer, spanBytes.byteOffset + cursor).getUint32(0, true);
            links.push(parseLink(spanBytes, cursor + SIZE_PREFIX_LEN, size, columns));
            cursor += SIZE_PREFIX_LEN + size;
        }
        return links;
    }

    /** Async iterator over every link in storage order. */
    async *allLinks(): AsyncGenerator<Link, void, unknown> {
        if (!this.hasLinks) return;
        const linkCount = this.header.linksCount;
        let cursor = 0;
        for (let i = 0; i < linkCount; i++) {
            const { link, totalSize } = await this.readLinkAt(cursor);
            yield link;
            cursor += totalSize;
        }
    }

    /**
     * Read a single link by its storage index (`0 ≤ i < linksCount`).
     * O(1) once the storage-offset table has been built (first call
     * walks the links block; subsequent calls are direct).
     */
    async getLink(storageIdx: number): Promise<Link> {
        if (storageIdx < 0 || storageIdx >= this.header.linksCount) {
            throw new Error(`Link index out of range: ${storageIdx} (have ${this.header.linksCount})`);
        }
        const cached = this.linkCache.get(storageIdx);
        if (cached) return cached;
        const offsets = await this.ensureLinkStorageOffsets();
        const byteOffset = offsets[storageIdx];
        const { link } = await this.readLinkAt(byteOffset);
        this.linkCache.set(storageIdx, link);
        return link;
    }

    /**
     * Bulk-fetch features by storage index. Faster than mapping
     * `getFeature` over the array on remote sources because adjacent
     * indices are coalesced into a single byte range. Results are in
     * the same order as `indices` (duplicates allowed; cached values
     * are reused).
     */
    async getFeatures(indices: ReadonlyArray<number>): Promise<IGeoJsonFeature[]> {
        for (const i of indices) {
            if (i < 0 || i >= this.header.featuresCount) {
                throw new Error(`Feature index out of range: ${i} (have ${this.header.featuresCount})`);
            }
        }
        if (indices.length === 0) return [];

        // Resolve byte offsets for every unique uncached index via the
        // spatial-index leaves (or the bulk-walk fallback below).
        const missing: number[] = [];
        for (const i of indices) {
            if (!this.featureCache.has(i)) missing.push(i);
        }
        if (missing.length > 0) {
            // Fallback when there's no spatial index: a single bulk read
            // of the features block populates every cache slot at once.
            if (this.header.featureSpatialIndex.length === 0) {
                await this.loadFeatures();
            } else {
                // Look up each missing index's byte offset, then merge
                // adjacent reads into ranges before issuing requests.
                const offsets = await Promise.all(
                    missing.map((i) => this.featureOffsetViaSpatialIndex(i)),
                );
                await this.bulkReadAndCacheFeatures(missing, offsets);
            }
        }
        return indices.map((i) => this.featureCache.get(i) as IGeoJsonFeature);
    }

    /**
     * Bulk-fetch links by storage index. Same coalescing rules as
     * `getFeatures`. Results are in the same order as `indices`.
     */
    async getLinks(indices: ReadonlyArray<number>): Promise<Link[]> {
        if (!this.hasLinks) {
            throw new Error('File has no links.');
        }
        for (const i of indices) {
            if (i < 0 || i >= this.header.linksCount) {
                throw new Error(`Link index out of range: ${i} (have ${this.header.linksCount})`);
            }
        }
        if (indices.length === 0) return [];

        const missing = indices.filter((i) => !this.linkCache.has(i));
        if (missing.length > 0) {
            const offsets = await this.ensureLinkStorageOffsets();
            await this.bulkReadAndCacheLinks(missing, offsets);
        }
        return indices.map((i) => this.linkCache.get(i) as Link);
    }

    /** Number of outgoing links from feature `v`. O(1) with CSR. */
    async outDegreeOf(featureIdx: number): Promise<number> {
        if (!this.hasLinks) return 0;
        if (this.header.linkAdjacencyIndex.length === 0) {
            throw new Error('outDegreeOf requires writeAdjacencyIndex: true.');
        }
        if (featureIdx < 0 || featureIdx >= this.header.featuresCount) {
            throw new Error(`Feature index out of range: ${featureIdx} (have ${this.header.featuresCount})`);
        }
        const [start, end] = await this.readCsrRange(
            this.header.linkAdjacencyIndex.offset,
            this.linkAdjacencyIndexBytes,
            featureIdx,
        );
        // CSR stores byte offsets, not link counts. Count records by
        // walking the span — fast because spans are usually tiny.
        if (start === end) return 0;
        const spanBytes =
            this.linksSectionBytes !== null
                ? this.linksSectionBytes.subarray(start, end)
                : await this.reader.read(this.header.linksBlock.offset + start, end - start);
        let count = 0;
        let cursor = 0;
        while (cursor < spanBytes.byteLength) {
            const size = new DataView(spanBytes.buffer, spanBytes.byteOffset + cursor).getUint32(0, true);
            count++;
            cursor += SIZE_PREFIX_LEN + size;
        }
        return count;
    }

    /** Number of incoming links to feature `v`. O(1) with reverse CSR. */
    async inDegreeOf(featureIdx: number): Promise<number> {
        if (!this.hasLinks) return 0;
        if (this.header.linkReverseAdjacencyIndex.length === 0) {
            throw new Error('inDegreeOf requires writeReverseAdjacencyIndex: true.');
        }
        if (featureIdx < 0 || featureIdx >= this.header.featuresCount) {
            throw new Error(`Feature index out of range: ${featureIdx} (have ${this.header.featuresCount})`);
        }
        const [start, end] = await this.readReverseCsrRange(featureIdx);
        return end - start;
    }

    /**
     * Async iterator over the incoming links of `featureIdx`. Requires
     * `writeReverseAdjacencyIndex: true`. Per-feature result is cached.
     */
    async *incomingLinksOf(featureIdx: number): AsyncGenerator<Link, void, unknown> {
        if (!this.hasLinks) {
            throw new Error('File has no links.');
        }
        if (this.header.linkReverseAdjacencyIndex.length === 0) {
            throw new Error(
                'File has no reverse adjacency index. Re-serialize with writeReverseAdjacencyIndex: true.',
            );
        }
        if (featureIdx < 0 || featureIdx >= this.header.featuresCount) {
            throw new Error(`Feature index out of range: ${featureIdx} (have ${this.header.featuresCount})`);
        }

        const cached = this.incomingLinksCache.get(featureIdx);
        if (cached) {
            for (const l of cached) yield l;
            return;
        }

        const [start, end] = await this.readReverseCsrRange(featureIdx);
        if (start === end) {
            this.incomingLinksCache.set(featureIdx, []);
            return;
        }

        const byteOffsetsArray = await this.readReverseLinkByteOffsets(start, end);
        const links: Link[] = new Array(byteOffsetsArray.length);
        for (let i = 0; i < byteOffsetsArray.length; i++) {
            const off = byteOffsetsArray[i];
            const { link } = await this.readLinkAt(off);
            links[i] = link;
        }
        this.incomingLinksCache.set(featureIdx, links);
        for (const l of links) yield l;
    }

    /**
     * Find the link with `link.from === from` and `link.to === to`.
     * Returns the link, or `null` when no such link exists. Requires
     * `writeAdjacencyIndex: true` so we can search inside `from`'s
     * outgoing range instead of scanning the whole graph.
     */
    async linkIndexBetween(from: number, to: number): Promise<Link | null> {
        if (!this.hasLinks) return null;
        if (this.header.linkAdjacencyIndex.length === 0) {
            throw new Error('linkIndexBetween requires writeAdjacencyIndex: true.');
        }
        if (from < 0 || from >= this.header.featuresCount) {
            throw new Error(`Feature index out of range: ${from} (have ${this.header.featuresCount})`);
        }
        const cached = this.outgoingLinksCache.get(from);
        if (cached) return cached.find((l) => l.to === to) ?? null;
        const links = await this.fetchOutgoingLinks(from);
        this.outgoingLinksCache.set(from, links);
        return links.find((l) => l.to === to) ?? null;
    }

    // ────────────────────────── Spatial: nearest ───────────────────────

    /**
     * Features yielded in ascending distance from a `[lon, lat]`
     * reference point. The traversal is best-first over the spatial
     * R-tree — each yielded value is guaranteed to be at least as far
     * from `point` as the previous one. Distances are reported in the
     * chosen `unit`; the search uses the haversine formula on the
     * WGS84 mean radius.
     *
     * Requires `writeSpatialIndex: true` + feature geometry.
     *
     * Lazy — the heap only expands as you iterate. Three ways to
     * bound the search, pick whichever fits the call site:
     *
     *   - `limit: 5`               → stop after 5 results
     *   - `maxDistance: 80`        → stop when the next-best is farther than 80 units
     *   - `limit: Infinity`        → yield every feature in distance order
     *
     * Default `limit` is `100` — calling without an explicit bound on
     * a huge dataset is almost always a bug, so the default protects
     * you from accidentally iterating the whole R-tree.
     */
    async *nearestFeatures(
        point: readonly [number, number],
        options?: NearestFeaturesOptions,
    ): AsyncGenerator<{ feature: IGeoJsonFeature; distance: number; index: number }, void, unknown> {
        if (!this.hasGeometry) throw new Error('nearestFeatures requires feature geometry.');
        if (this.header.featureSpatialIndex.length === 0) {
            throw new Error('nearestFeatures requires writeSpatialIndex: true.');
        }

        const unit: DistanceUnit = options?.unit ?? 'meters';
        const scale = DISTANCE_SCALE[unit];
        const maxDistMeters =
            options?.maxDistance !== undefined ? options.maxDistance / scale : Infinity;
        const limit = options?.limit ?? 100;
        if (limit <= 0) return;

        const numItems = this.header.featuresCount;
        const levelBounds = generateLevelBounds(numItems, DEFAULT_NODE_SIZE);
        const firstLeafNodeIdx = levelBounds[0][0];
        const rootLevel = levelBounds.length - 1;

        const readNode = async (nodeIdx: number, count: number): Promise<DataView> => {
            const bytes = await this.fetchRTreeBytes(
                nodeIdx * NODE_ITEM_BYTE_LEN,
                count * NODE_ITEM_BYTE_LEN,
            );
            return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        };

        // Best-first traversal. Heap is keyed by the rect-to-point
        // haversine distance from `point` to the entry's bbox so
        // internal entries can prune entire subtrees.
        const heap = new NearestHeap();

        // Seed with the single root entry. Its `offset` points at the
        // first entry of its child level.
        const rootView = await readNode(0, 1);
        const rootBbox: Bbox = {
            minX: rootView.getFloat64(0, true),
            minY: rootView.getFloat64(8, true),
            maxX: rootView.getFloat64(16, true),
            maxY: rootView.getFloat64(24, true),
        };
        const rootChildNodeIdx = Number(rootView.getBigUint64(32, true));
        heap.push({
            dist: rectToPointHaversine(rootBbox, point),
            isLeaf: false,
            childNodeIdx: rootChildNodeIdx,
            childLevel: rootLevel - 1,
        });

        let yielded = 0;
        while (heap.size > 0) {
            const top = heap.pop()!;
            if (top.dist > maxDistMeters) return;

            if (top.isLeaf) {
                const featureIdx = top.featureIdx as number;
                const feature = await this.getFeature(featureIdx);
                yield { feature, distance: top.dist * scale, index: featureIdx };
                yielded++;
                if (yielded >= limit) return;
                continue;
            }

            const childNodeIdx = top.childNodeIdx as number;
            const childLevel = top.childLevel as number;
            const childrenAreLeaves = childLevel === 0;
            // Read up to `nodeSize` siblings within the parent's child
            // block, clamping at the child level's end so we don't
            // read into another level's nodes.
            const levelEnd = levelBounds[childLevel][1];
            const blockEnd = Math.min(childNodeIdx + DEFAULT_NODE_SIZE, levelEnd);
            const count = Math.max(0, blockEnd - childNodeIdx);
            if (count === 0) continue;
            const childView = await readNode(childNodeIdx, count);
            for (let i = 0; i < count; i++) {
                const off = i * NODE_ITEM_BYTE_LEN;
                const bbox: Bbox = {
                    minX: childView.getFloat64(off + 0, true),
                    minY: childView.getFloat64(off + 8, true),
                    maxX: childView.getFloat64(off + 16, true),
                    maxY: childView.getFloat64(off + 24, true),
                };
                const offsetVal = Number(childView.getBigUint64(off + 32, true));
                const dist = rectToPointHaversine(bbox, point);
                if (dist > maxDistMeters) continue;
                if (childrenAreLeaves) {
                    heap.push({
                        dist,
                        isLeaf: true,
                        featureIdx: childNodeIdx + i - firstLeafNodeIdx,
                    });
                    void offsetVal;
                } else {
                    heap.push({
                        dist,
                        isLeaf: false,
                        childNodeIdx: offsetVal,
                        childLevel: childLevel - 1,
                    });
                }
            }
        }
    }

    // ───────────────────────── Diagnostics: inspect ────────────────────

    /**
     * Structured snapshot of the file's directory: every present block
     * with its byte offset, byte length, and percentage of the file.
     * Useful for verifying that an index landed where you expected and
     * for understanding where bytes go on a real dataset.
     */
    inspect(): FlatRecordInspect {
        const h = this.header;
        const blocks: FlatRecordBlockInfo[] = [];
        const considerBlock = (label: string, loc: { offset: number; length: number }): void => {
            if (loc.length > 0) blocks.push({ block: label, offset: loc.offset, length: loc.length });
        };
        considerBlock('featureSpatialIndex', h.featureSpatialIndex);
        for (const e of h.featureColumnIndices) {
            considerBlock(`featureColumnIndex[${e.column}]`, e);
        }
        considerBlock('featuresBlock', h.featuresBlock);
        considerBlock('linkSpatialIndex', h.linkSpatialIndex);
        for (const e of h.linkColumnIndices) {
            considerBlock(`linkColumnIndex[${e.column}]`, e);
        }
        considerBlock('linkAdjacencyIndex', h.linkAdjacencyIndex);
        considerBlock('linkReverseAdjacencyIndex', h.linkReverseAdjacencyIndex);
        considerBlock('linksBlock', h.linksBlock);

        const totalBytes = blocks.reduce((a, b) => Math.max(a, b.offset + b.length), 0);
        for (const b of blocks) {
            b.percent = totalBytes > 0 ? (b.length / totalBytes) * 100 : 0;
        }

        return {
            mode: this.mode,
            featuresCount: h.featuresCount,
            linksCount: h.linksCount,
            hasGeometry: h.hasFeatureGeometry,
            featureColumns: h.columns?.map((c) => ({ name: c.name, type: c.type })) ?? [],
            linkColumns: h.linkColumns?.map((c) => ({ name: c.name, type: c.type })) ?? [],
            indexes: {
                featureSpatialIndex: h.featureSpatialIndex.length > 0,
                linkSpatialIndex: h.linkSpatialIndex.length > 0,
                adjacencyIndex: h.linkAdjacencyIndex.length > 0,
                reverseAdjacencyIndex: h.linkReverseAdjacencyIndex.length > 0,
                featureColumnIndices: h.featureColumnIndices.map((e) => e.column),
                linkColumnIndices: h.linkColumnIndices.map((e) => e.column),
            },
            crc32: {
                stored: h.headerCrc32,
                verified: h.headerCrc32 !== 0,
            },
            blocks: blocks.sort((a, b) => a.offset - b.offset),
            totalBytes,
        };
    }

    /**
     * Async iterator yielding every link whose bounding rectangle
     * intersects `rect`, using the packed Hilbert R-tree on links.
     * Requires `writeLinkSpatialIndex: true`.
     */
    async *linksInBbox(rect: Rect): AsyncGenerator<Link, void, unknown> {
        if (!this.hasLinks) {
            throw new Error('File has no links.');
        }
        if (this.header.linkSpatialIndex.length === 0) {
            throw new Error('File has no link spatial index. Re-serialize with writeLinkSpatialIndex: true.');
        }
        const linkCount = this.header.linksCount;
        if (linkCount === 0) return;

        const readNode = this.makeRTreeNodeReader(
            this.header.linkSpatialIndex.offset,
            this.linkSpatialIndexBytes,
        );

        for await (const [byteOffset] of streamSearch(linkCount, DEFAULT_NODE_SIZE, rect, readNode)) {
            const { link } = await this.readLinkAt(byteOffset);
            yield link;
        }
    }

    /**
     * Compute a shortest path between two features. Requires links and
     * an adjacency index. Features are fetched lazily.
     *
     * `from` and `to` accept either a raw file index (`number`) or a
     * `{ column, value }` lookup descriptor (which resolves the feature
     * via the property index of `column`).
     */
    async shortestPath(
        from: number | FeatureLookup,
        to: number | FeatureLookup,
        options?: ShortestPathOptions,
    ): Promise<ShortestPathResult | null> {
        const fromIdx = typeof from === 'number' ? from : await this.featureIndexBy(from);
        const toIdx = typeof to === 'number' ? to : await this.featureIndexBy(to);
        return runShortestPath(this, fromIdx, toIdx, options);
    }

    /**
     * Resolve a `{ column, value }` lookup to a feature's storage index.
     * Throws when no record matches.
     */
    async featureIndexBy(lookup: FeatureLookup): Promise<number> {
        const idx = await this.loadFeatureColumnIndex(lookup.column);
        const { column, value } = lookup;
        if (typeof value === 'string') {
            const col = idx.text.get(column);
            if (!col) throw new Error(`Feature column "${column}" is not indexed as text`);
            const hits = searchText(col, value, { match: 'exact', limit: 1 });
            if (hits.length === 0) throw new Error(`No feature found with ${column} = ${JSON.stringify(value)}`);
            return hits[0].recordId;
        }
        if (typeof value === 'number') {
            const num = idx.numeric.get(column);
            if (!num) throw new Error(`Feature column "${column}" is not indexed as number`);
            const ids = searchNumeric(num, { eq: value }, { limit: 1 });
            if (ids.length === 0) throw new Error(`No feature found with ${column} = ${value}`);
            return ids[0];
        }
        const bool = idx.bool.get(column);
        if (!bool) throw new Error(`Feature column "${column}" is not indexed as boolean`);
        const ids = searchBool(bool, { eq: value }, { limit: 1 });
        if (ids.length === 0) throw new Error(`No feature found with ${column} = ${value}`);
        return ids[0];
    }

    // ─────────────────────── Property-index queries ────────────────────

    async *findFeaturesByText(
        column: string,
        query: string,
        options?: TextQueryOptions,
    ): AsyncGenerator<TextHit<IGeoJsonFeature>, void, unknown> {
        const idx = await this.loadFeatureColumnIndex(column);
        const col = idx.text.get(column);
        if (!col) throw new Error(`Feature column "${column}" is not indexed as text`);
        const hits = searchText(col, query, options);
        for (const hit of hits) {
            yield { feature: await this.getFeature(hit.recordId), tier: hit.tier, index: hit.recordId };
        }
    }

    async *findFeaturesByValue(
        column: string,
        predicate: ValuePredicate,
        options?: ValueQueryOptions,
    ): AsyncGenerator<IGeoJsonFeature, void, unknown> {
        const idx = await this.loadFeatureColumnIndex(column);
        const num = idx.numeric.get(column);
        if (num) {
            for (const id of searchNumeric(num, predicate, options)) yield await this.getFeature(id);
            return;
        }
        const bool = idx.bool.get(column);
        if (bool) {
            for (const id of searchBool(bool, predicate, options)) yield await this.getFeature(id);
            return;
        }
        throw new Error(`Feature column "${column}" is not indexed as number or boolean`);
    }

    async *findLinksByText(
        column: string,
        query: string,
        options?: TextQueryOptions,
    ): AsyncGenerator<TextHit<Link, 'link'>, void, unknown> {
        const idx = await this.loadLinkColumnIndex(column);
        const col = idx.text.get(column);
        if (!col) throw new Error(`Link column "${column}" is not indexed as text`);
        const hits = searchText(col, query, options);
        for (const hit of hits) {
            yield { link: await this.getLinkByStorageIndex(hit.recordId), tier: hit.tier, index: hit.recordId };
        }
    }

    async *findLinksByValue(
        column: string,
        predicate: ValuePredicate,
        options?: ValueQueryOptions,
    ): AsyncGenerator<Link, void, unknown> {
        const idx = await this.loadLinkColumnIndex(column);
        const num = idx.numeric.get(column);
        if (num) {
            for (const id of searchNumeric(num, predicate, options)) yield await this.getLinkByStorageIndex(id);
            return;
        }
        const bool = idx.bool.get(column);
        if (bool) {
            for (const id of searchBool(bool, predicate, options)) yield await this.getLinkByStorageIndex(id);
            return;
        }
        throw new Error(`Link column "${column}" is not indexed as number or boolean`);
    }

    /**
     * Load a single feature property index column (single range request).
     * Idempotent. Use this instead of `loadPropertyIndices` when you only
     * need one column on a large remote file.
     */
    async loadFeatureColumnIndex(name: string): Promise<PropertyIndex> {
        if (this.loadedFeatureCols.has(name)) return this.featurePropertyIndex;
        const entry = this.header.featureColumnIndices.find((e) => e.column === name);
        if (!entry) {
            throw new Error(
                `File has no feature column index for "${name}". Re-serialize with writeColumnIndex: { features: ['${name}', ...] }.`,
            );
        }
        const block = await this.readColumnIndexBlock(entry);
        const parsed = parsePropertyIndexBlock(block);
        mergePropertyIndex(this.featurePropertyIndex, parsed);
        this.loadedFeatureCols.add(name);
        return this.featurePropertyIndex;
    }

    /**
     * Load a single link property index column (single range request).
     * Idempotent.
     */
    async loadLinkColumnIndex(name: string): Promise<PropertyIndex> {
        if (this.loadedLinkCols.has(name)) return this.linkPropertyIndex;
        const entry = this.header.linkColumnIndices.find((e) => e.column === name);
        if (!entry) {
            throw new Error(
                `File has no link column index for "${name}". Re-serialize with writeColumnIndex: { links: ['${name}', ...] }.`,
            );
        }
        const block = await this.readColumnIndexBlock(entry);
        const parsed = parsePropertyIndexBlock(block);
        mergePropertyIndex(this.linkPropertyIndex, parsed);
        this.loadedLinkCols.add(name);
        return this.linkPropertyIndex;
    }

    /** Load every declared feature + link property index column. */
    async loadPropertyIndices(): Promise<void> {
        const tasks: Promise<unknown>[] = [];
        for (const e of this.header.featureColumnIndices) {
            if (!this.loadedFeatureCols.has(e.column)) tasks.push(this.loadFeatureColumnIndex(e.column));
        }
        for (const e of this.header.linkColumnIndices) {
            if (!this.loadedLinkCols.has(e.column)) tasks.push(this.loadLinkColumnIndex(e.column));
        }
        await Promise.all(tasks);
    }

    /** Drop both cached property index trees. */
    releasePropertyIndices(): void {
        this.assertReloadable('releasePropertyIndices');
        this.featurePropertyIndex = EMPTY_PROP_INDEX();
        this.linkPropertyIndex = EMPTY_PROP_INDEX();
        this.loadedFeatureCols.clear();
        this.loadedLinkCols.clear();
    }

    private async readColumnIndexBlock(entry: ColumnIndexLocation): Promise<Uint8Array> {
        return await this.reader.read(entry.offset, entry.length);
    }

    private async getLinkByStorageIndex(storageIdx: number): Promise<Link> {
        const linkCount = this.header.linksCount;
        if (storageIdx < 0 || storageIdx >= linkCount) {
            throw new Error(`Link index out of range: ${storageIdx} (have ${linkCount})`);
        }
        let i = 0;
        for await (const l of this.allLinks()) {
            if (i === storageIdx) return l;
            i++;
        }
        throw new Error(`Internal: link ${storageIdx} not found`);
    }

    /**
     * Bulk-fetch the links block (and, opportunistically, the adjacency
     * CSR) into memory in a single parallel pair of range requests.
     * Subsequent `outgoingLinksOf`, `allLinks`, `linksInBbox`,
     * `shortestPath` serve from cache. Idempotent.
     *
     * Note: `releaseLinks()` drops the links payload but **not** the
     * adjacency CSR (the CSR is also useful for cold `outgoingLinksOf`).
     * Use `releaseIndices()` or `release()` to drop the CSR too.
     */
    async loadLinks(): Promise<void> {
        if (this.linksSectionBytes !== null) return;
        if (!this.hasLinks) {
            this.linksSectionBytes = new Uint8Array(0);
            return;
        }

        const [linksBytes, adjBytes] = await Promise.all([
            this.reader.read(this.header.linksBlock.offset, this.header.linksBlock.length),
            this.header.linkAdjacencyIndex.length > 0 && this.linkAdjacencyIndexBytes === null
                ? this.reader.read(
                      this.header.linkAdjacencyIndex.offset,
                      this.header.linkAdjacencyIndex.length,
                  )
                : Promise.resolve(this.linkAdjacencyIndexBytes),
        ]);
        this.linksSectionBytes = linksBytes;
        if (adjBytes !== null) this.linkAdjacencyIndexBytes = adjBytes;

        // Populate outgoing-links cache if we have CSR.
        if (adjBytes !== null) {
            this.populateOutgoingLinksCache(adjBytes, linksBytes);
        }
    }

    private populateOutgoingLinksCache(adjBytes: Uint8Array, linksBytes: Uint8Array): void {
        const csrView = new DataView(adjBytes.buffer, adjBytes.byteOffset);
        const linksView = new DataView(linksBytes.buffer, linksBytes.byteOffset);
        const columns = this.header.linkColumns;
        for (let v = 0; v < this.header.featuresCount; v++) {
            const start = csrView.getUint32(v * 4, true);
            const end = csrView.getUint32((v + 1) * 4, true);
            if (start === end) {
                this.outgoingLinksCache.set(v, []);
                continue;
            }
            const links: Link[] = [];
            let cursor = start;
            while (cursor < end) {
                const size = linksView.getUint32(cursor, true);
                links.push(parseLink(linksBytes, cursor + SIZE_PREFIX_LEN, size, columns));
                cursor += SIZE_PREFIX_LEN + size;
            }
            this.outgoingLinksCache.set(v, links);
        }
    }

    /**
     * Cache every navigational structure: feature R-tree, link R-tree,
     * adjacency CSR. Idempotent. Feature and link payloads remain lazy.
     */
    async loadIndices(): Promise<void> {
        const tasks: Promise<unknown>[] = [];
        if (this.header.featureSpatialIndex.length > 0 && this.featureSpatialIndexBytes === null) {
            tasks.push(
                this.reader
                    .read(this.header.featureSpatialIndex.offset, this.header.featureSpatialIndex.length)
                    .then((b) => {
                        this.featureSpatialIndexBytes = b;
                    }),
            );
        }
        if (this.header.linkSpatialIndex.length > 0 && this.linkSpatialIndexBytes === null) {
            tasks.push(
                this.reader
                    .read(this.header.linkSpatialIndex.offset, this.header.linkSpatialIndex.length)
                    .then((b) => {
                        this.linkSpatialIndexBytes = b;
                    }),
            );
        }
        if (this.header.linkAdjacencyIndex.length > 0 && this.linkAdjacencyIndexBytes === null) {
            tasks.push(
                this.reader
                    .read(this.header.linkAdjacencyIndex.offset, this.header.linkAdjacencyIndex.length)
                    .then((b) => {
                        this.linkAdjacencyIndexBytes = b;
                    }),
            );
        }
        if (
            this.header.linkReverseAdjacencyIndex.length > 0 &&
            this.linkReverseAdjacencyIndexBytes === null
        ) {
            tasks.push(
                this.reader
                    .read(
                        this.header.linkReverseAdjacencyIndex.offset,
                        this.header.linkReverseAdjacencyIndex.length,
                    )
                    .then((b) => {
                        this.linkReverseAdjacencyIndexBytes = b;
                    }),
            );
        }
        await Promise.all(tasks);
    }

    /**
     * Eagerly load everything into memory using a single bulk read.
     * When the byte source provides `readAll()` we use it; otherwise we
     * compute the file's total length from the directory and issue one
     * range read covering every block.
     *
     * Pass `{ detach: true }` to also release the source buffer once the
     * caches are built (see {@link PreloadOptions.detach}).
     */
    async preload(options: PreloadOptions = {}): Promise<void> {
        const detach = options.detach ?? false;
        const all = this.reader.readAll
            ? await this.reader.readAll()
            : await this.reader.read(0, this.computeTotalLength());
        this.populateAllCachesFromFullBuffer(all, detach);
        if (detach) {
            // The reader closure is the last reference to the source buffer
            // (index ranges were copied out above, features are already
            // copied), so dropping it lets `all` be collected on return.
            (this as { reader: ByteReader }).reader = DETACHED_READER;
        }
    }

    private computeTotalLength(): number {
        const h = this.header;
        let end = 0;
        const consider = (loc: { offset: number; length: number }): void => {
            const tail = loc.offset + loc.length;
            if (tail > end) end = tail;
        };
        consider(h.featureSpatialIndex);
        consider(h.featuresBlock);
        for (const e of h.featureColumnIndices) consider(e);
        consider(h.linkSpatialIndex);
        consider(h.linkAdjacencyIndex);
        consider(h.linkReverseAdjacencyIndex);
        consider(h.linksBlock);
        for (const e of h.linkColumnIndices) consider(e);
        return end;
    }

    private populateAllCachesFromFullBuffer(all: Uint8Array, detach = false): void {
        const h = this.header;
        // Retained ranges: copy them out (`slice`) when detaching so the
        // source buffer isn't pinned by `subarray` views, otherwise keep
        // zero-copy views over the buffer the caller still holds. Features
        // are copied by `parseFeatureBytes` either way, so the features
        // section stays a transient view below.
        const take = detach
            ? (start: number, end: number): Uint8Array => all.slice(start, end)
            : (start: number, end: number): Uint8Array => all.subarray(start, end);

        if (h.featureSpatialIndex.length > 0) {
            this.featureSpatialIndexBytes = take(
                h.featureSpatialIndex.offset,
                h.featureSpatialIndex.offset + h.featureSpatialIndex.length,
            );
        }
        if (h.linkSpatialIndex.length > 0) {
            this.linkSpatialIndexBytes = take(
                h.linkSpatialIndex.offset,
                h.linkSpatialIndex.offset + h.linkSpatialIndex.length,
            );
        }
        if (h.linkAdjacencyIndex.length > 0) {
            this.linkAdjacencyIndexBytes = take(
                h.linkAdjacencyIndex.offset,
                h.linkAdjacencyIndex.offset + h.linkAdjacencyIndex.length,
            );
        }
        if (h.linkReverseAdjacencyIndex.length > 0) {
            this.linkReverseAdjacencyIndexBytes = take(
                h.linkReverseAdjacencyIndex.offset,
                h.linkReverseAdjacencyIndex.offset + h.linkReverseAdjacencyIndex.length,
            );
        }

        if (h.featuresBlock.length > 0) {
            const featuresSection = all.subarray(
                h.featuresBlock.offset,
                h.featuresBlock.offset + h.featuresBlock.length,
            );
            let cursor = 0;
            for (let i = 0; i < h.featuresCount; i++) {
                const size = new DataView(featuresSection.buffer, featuresSection.byteOffset + cursor).getUint32(
                    0,
                    true,
                );
                const featureBytes = featuresSection.subarray(cursor, cursor + SIZE_PREFIX_LEN + size);
                this.featureCache.set(i, parseFeatureBytes(featureBytes, h, i));
                cursor += SIZE_PREFIX_LEN + size;
            }
        }

        if (h.linksBlock.length > 0) {
            const linksBytes = take(
                h.linksBlock.offset,
                h.linksBlock.offset + h.linksBlock.length,
            );
            this.linksSectionBytes = linksBytes;
            if (this.linkAdjacencyIndexBytes !== null) {
                this.populateOutgoingLinksCache(this.linkAdjacencyIndexBytes, linksBytes);
            }
        }

        // `parsePropertyIndexBlock` keeps `subarray` views over the block it's
        // given, so the block must be a standalone copy when detaching.
        for (const e of h.featureColumnIndices) {
            if (this.loadedFeatureCols.has(e.column)) continue;
            const block = take(e.offset, e.offset + e.length);
            const parsed = parsePropertyIndexBlock(block);
            mergePropertyIndex(this.featurePropertyIndex, parsed);
            this.loadedFeatureCols.add(e.column);
        }
        for (const e of h.linkColumnIndices) {
            if (this.loadedLinkCols.has(e.column)) continue;
            const block = take(e.offset, e.offset + e.length);
            const parsed = parsePropertyIndexBlock(block);
            mergePropertyIndex(this.linkPropertyIndex, parsed);
            this.loadedLinkCols.add(e.column);
        }
    }

    /** True once {@link preload}`({ detach: true })` has released the byte
     *  source. Such an instance answers every query from caches and can no
     *  longer fetch uncached bytes. */
    private get detached(): boolean {
        return this.reader === DETACHED_READER;
    }

    /** Guard for cache-clearing methods. A detached instance has no byte
     *  source to rebuild from, so clearing a cache would leave it silently
     *  broken — refuse loudly instead. */
    private assertReloadable(op: string): void {
        if (this.detached) {
            throw new Error(
                `FlatRecord: ${op}() is unavailable after preload({ detach: true }) — the byte ` +
                    `source was released, so cleared caches cannot be rebuilt. Drop all references ` +
                    `to this instance to free its memory, and re-open the file if you need it again.`,
            );
        }
    }

    /**
     * Drop every cache, returning to a cold reader that re-fetches on demand.
     * Unavailable after {@link preload}`({ detach: true })` — a detached
     * instance has no byte source to rebuild from, so it (and the other
     * `release*` methods) throws instead of leaving itself half-dead.
     */
    release(): void {
        this.assertReloadable('release');
        this.releaseFeatures();
        this.releaseLinks();
        this.releaseIndices();
        this.releasePropertyIndices();
    }
    releaseFeatures(): void {
        this.assertReloadable('releaseFeatures');
        this.featureCache.clear();
    }
    releaseLinks(): void {
        this.assertReloadable('releaseLinks');
        this.outgoingLinksCache.clear();
        this.incomingLinksCache.clear();
        this.linkCache.clear();
        this.linkStorageOffsetsCache = null;
        this.linksSectionBytes = null;
    }
    releaseIndices(): void {
        this.assertReloadable('releaseIndices');
        this.featureSpatialIndexBytes = null;
        this.linkSpatialIndexBytes = null;
        this.linkAdjacencyIndexBytes = null;
        this.linkReverseAdjacencyIndexBytes = null;
    }

    // ─────────────────────────── Internals ─────────────────────────────

    private async readLinkAt(byteOffsetInLinks: number): Promise<{ link: Link; totalSize: number }> {
        if (this.linksSectionBytes !== null) {
            const view = new DataView(
                this.linksSectionBytes.buffer,
                this.linksSectionBytes.byteOffset + byteOffsetInLinks,
            );
            const size = view.getUint32(0, true);
            const link = parseLink(
                this.linksSectionBytes,
                byteOffsetInLinks + SIZE_PREFIX_LEN,
                size,
                this.header.linkColumns,
            );
            return { link, totalSize: SIZE_PREFIX_LEN + size };
        }

        const absolute = this.header.linksBlock.offset + byteOffsetInLinks;
        const maxAvailable = this.header.linksBlock.length - byteOffsetInLinks;
        const { bytes, size } = await this.readSizePrefixedRecord(absolute, maxAvailable);
        const link = parseLink(bytes, SIZE_PREFIX_LEN, size, this.header.linkColumns);
        return { link, totalSize: SIZE_PREFIX_LEN + size };
    }

    private static readonly SPECULATIVE_RECORD_SIZE = 1024;

    private async readSizePrefixedRecord(
        absolute: number,
        maxAvailable: number | null,
    ): Promise<{ bytes: Uint8Array; size: number }> {
        if (maxAvailable === null) {
            const sizePrefix = await this.reader.read(absolute, SIZE_PREFIX_LEN);
            const size = new DataView(sizePrefix.buffer, sizePrefix.byteOffset).getUint32(0, true);
            const bytes = await this.reader.read(absolute, SIZE_PREFIX_LEN + size);
            return { bytes, size };
        }
        const firstLen = Math.min(FlatRecord.SPECULATIVE_RECORD_SIZE, maxAvailable);
        const first = await this.reader.read(absolute, firstLen);
        const size = new DataView(first.buffer, first.byteOffset).getUint32(0, true);
        const total = SIZE_PREFIX_LEN + size;
        if (first.byteLength >= total) {
            return { bytes: first.subarray(0, total), size };
        }
        const remaining = total - first.byteLength;
        const rest = await this.reader.read(absolute + first.byteLength, remaining);
        const combined = new Uint8Array(total);
        combined.set(first);
        combined.set(rest, first.byteLength);
        return { bytes: combined, size };
    }

    /**
     * Build a `readNode(offsetIntoTree, size)` closure that
     * `packedrtree.streamSearch` can use to walk an R-tree. Serves
     * bytes from the cached in-memory tree when available, otherwise
     * issues a range request through the underlying `ByteReader`.
     * Shared by `featuresInBbox` and `linksInBbox` so both go through
     * the same access pattern.
     */
    private makeRTreeNodeReader(
        treeStart: number,
        cached: Uint8Array | null,
    ): (offsetIntoTree: number, size: number) => Promise<ArrayBuffer> {
        return async (offsetIntoTree: number, size: number): Promise<ArrayBuffer> => {
            if (cached !== null) {
                return cached.buffer.slice(
                    cached.byteOffset + offsetIntoTree,
                    cached.byteOffset + offsetIntoTree + size,
                ) as ArrayBuffer;
            }
            const bytes = await this.reader.read(treeStart + offsetIntoTree, size);
            return bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer;
        };
    }

    /** Return `[start, end)` byte offsets in the links block for the
     *  outgoing range of `featureIdx`. Reads 8 bytes when the CSR
     *  isn't cached. */
    private async readCsrRange(
        adjOffset: number,
        cachedCsr: Uint8Array | null,
        featureIdx: number,
    ): Promise<[number, number]> {
        if (cachedCsr !== null) {
            const view = new DataView(cachedCsr.buffer, cachedCsr.byteOffset + featureIdx * 4);
            return [view.getUint32(0, true), view.getUint32(4, true)];
        }
        const bytes = await this.reader.read(adjOffset + featureIdx * 4, 8);
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        return [view.getUint32(0, true), view.getUint32(4, true)];
    }

    /** Same as `readCsrRange` but against the reverse adjacency CSR.
     *  The reverse CSR's offsets index into the `linkByteOffsets`
     *  array (count of incoming links), not into bytes in the links
     *  block. */
    private async readReverseCsrRange(featureIdx: number): Promise<[number, number]> {
        const block = this.header.linkReverseAdjacencyIndex;
        if (this.linkReverseAdjacencyIndexBytes !== null) {
            const view = new DataView(
                this.linkReverseAdjacencyIndexBytes.buffer,
                this.linkReverseAdjacencyIndexBytes.byteOffset + featureIdx * 4,
            );
            return [view.getUint32(0, true), view.getUint32(4, true)];
        }
        const bytes = await this.reader.read(block.offset + featureIdx * 4, 8);
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        return [view.getUint32(0, true), view.getUint32(4, true)];
    }

    /** Read a range of `linkByteOffsets` from the reverse CSR block.
     *  Returns the per-incoming-link byte offsets (into the links
     *  block) for the slice `[startIdx, endIdx)`. */
    private async readReverseLinkByteOffsets(startIdx: number, endIdx: number): Promise<Uint32Array> {
        const block = this.header.linkReverseAdjacencyIndex;
        const offsetsBase = (this.header.featuresCount + 1) * 4;
        const sliceLen = (endIdx - startIdx) * 4;
        let bytes: Uint8Array;
        if (this.linkReverseAdjacencyIndexBytes !== null) {
            bytes = this.linkReverseAdjacencyIndexBytes.subarray(
                offsetsBase + startIdx * 4,
                offsetsBase + endIdx * 4,
            );
        } else {
            bytes = await this.reader.read(block.offset + offsetsBase + startIdx * 4, sliceLen);
        }
        const out = new Uint32Array(endIdx - startIdx);
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
        return out;
    }

    /** Build (and cache) the per-link byte-offsets array by walking
     *  the links block once. O(L) but happens at most once. */
    private async ensureLinkStorageOffsets(): Promise<Uint32Array> {
        if (this.linkStorageOffsetsCache) return this.linkStorageOffsetsCache;
        const linkCount = this.header.linksCount;
        if (linkCount === 0) {
            this.linkStorageOffsetsCache = new Uint32Array(0);
            return this.linkStorageOffsetsCache;
        }
        const block =
            this.linksSectionBytes ??
            (await this.reader.read(this.header.linksBlock.offset, this.header.linksBlock.length));
        if (this.linksSectionBytes === null) this.linksSectionBytes = block;
        const offsets = new Uint32Array(linkCount);
        let cursor = 0;
        for (let i = 0; i < linkCount; i++) {
            offsets[i] = cursor;
            const size = new DataView(block.buffer, block.byteOffset + cursor).getUint32(0, true);
            cursor += SIZE_PREFIX_LEN + size;
        }
        this.linkStorageOffsetsCache = offsets;
        return offsets;
    }

    /** Fetch + parse + cache features at the given storage indices,
     *  coalescing nearby byte ranges into a single request each. */
    private async bulkReadAndCacheFeatures(
        indices: ReadonlyArray<number>,
        offsets: ReadonlyArray<number>,
    ): Promise<void> {
        // Pair (index, offsetIntoFeaturesBlock); sort by offset so
        // adjacent rows merge into a single range read. We pad each
        // record with a speculative-read for the size prefix.
        const pairs = indices.map((idx, i) => ({ idx, off: offsets[i] }));
        pairs.sort((a, b) => a.off - b.off);
        if (pairs.length === 0) return;

        const block = this.header.featuresBlock;
        const inMemory = this.featureCache;
        const SPEC = 1024;

        let i = 0;
        while (i < pairs.length) {
            const start = pairs[i].off;
            let end = pairs[i].off + SPEC;
            let j = i + 1;
            while (j < pairs.length && pairs[j].off <= end + SPEC) {
                end = Math.max(end, pairs[j].off + SPEC);
                j++;
            }
            end = Math.min(end, block.length);
            const buf = await this.reader.read(block.offset + start, end - start);
            // Parse each pair in this run.
            for (let p = i; p < j; p++) {
                const rel = pairs[p].off - start;
                const size = new DataView(buf.buffer, buf.byteOffset + rel).getUint32(0, true);
                let featureBytes: Uint8Array;
                if (rel + SIZE_PREFIX_LEN + size <= buf.byteLength) {
                    featureBytes = buf.subarray(rel, rel + SIZE_PREFIX_LEN + size);
                } else {
                    // Record straddles the speculative window — read
                    // the rest in a follow-up request.
                    const rest = await this.reader.read(
                        block.offset + pairs[p].off + buf.byteLength - rel,
                        SIZE_PREFIX_LEN + size - (buf.byteLength - rel),
                    );
                    const combined = new Uint8Array(SIZE_PREFIX_LEN + size);
                    combined.set(buf.subarray(rel));
                    combined.set(rest, buf.byteLength - rel);
                    featureBytes = combined;
                }
                inMemory.set(pairs[p].idx, parseFeatureBytes(featureBytes, this.header, pairs[p].idx));
            }
            i = j;
        }
    }

    /** Fetch + parse + cache links at the given storage indices,
     *  coalescing adjacent byte ranges into single requests. */
    private async bulkReadAndCacheLinks(
        indices: ReadonlyArray<number>,
        storageOffsets: Uint32Array,
    ): Promise<void> {
        const pairs = indices.map((idx) => ({ idx, off: storageOffsets[idx] }));
        pairs.sort((a, b) => a.off - b.off);
        if (pairs.length === 0) return;

        // When the links block is resident (after preload / preload-detach),
        // serve from it via readLinkAt — no reader round-trips, and keeps bulk
        // reads working once the byte source has been detached.
        if (this.linksSectionBytes !== null) {
            for (const { idx, off } of pairs) {
                const { link } = await this.readLinkAt(off);
                this.linkCache.set(idx, link);
            }
            return;
        }

        const block = this.header.linksBlock;
        const columns = this.header.linkColumns;
        const SPEC = 512;

        let i = 0;
        while (i < pairs.length) {
            const start = pairs[i].off;
            let end = pairs[i].off + SPEC;
            let j = i + 1;
            while (j < pairs.length && pairs[j].off <= end + SPEC) {
                end = Math.max(end, pairs[j].off + SPEC);
                j++;
            }
            end = Math.min(end, block.length);
            const buf = await this.reader.read(block.offset + start, end - start);
            for (let p = i; p < j; p++) {
                const rel = pairs[p].off - start;
                const size = new DataView(buf.buffer, buf.byteOffset + rel).getUint32(0, true);
                let linkBytes: Uint8Array;
                if (rel + SIZE_PREFIX_LEN + size <= buf.byteLength) {
                    linkBytes = buf.subarray(rel, rel + SIZE_PREFIX_LEN + size);
                } else {
                    const rest = await this.reader.read(
                        block.offset + pairs[p].off + buf.byteLength - rel,
                        SIZE_PREFIX_LEN + size - (buf.byteLength - rel),
                    );
                    const combined = new Uint8Array(SIZE_PREFIX_LEN + size);
                    combined.set(buf.subarray(rel));
                    combined.set(rest, buf.byteLength - rel);
                    linkBytes = combined;
                }
                this.linkCache.set(pairs[p].idx, parseLink(linkBytes, SIZE_PREFIX_LEN, size, columns));
            }
            i = j;
        }
    }

    /** Fetch R-tree bytes for the feature spatial index, serving from
     *  the cached buffer when available. */
    private async fetchRTreeBytes(offsetIntoTree: number, length: number): Promise<Uint8Array> {
        if (this.featureSpatialIndexBytes !== null) {
            return this.featureSpatialIndexBytes.subarray(offsetIntoTree, offsetIntoTree + length);
        }
        return await this.reader.read(
            this.header.featureSpatialIndex.offset + offsetIntoTree,
            length,
        );
    }

    private async featureOffsetViaSpatialIndex(index: number): Promise<number> {
        if (this.featureSpatialIndexFirstLeafCache === null) {
            const treeSize = this.header.featureSpatialIndex.length;
            const totalNodes = treeSize / NODE_ITEM_BYTE_LEN;
            this.featureSpatialIndexFirstLeafCache =
                (totalNodes - this.header.featuresCount) * NODE_ITEM_BYTE_LEN + 32;
        }
        const treeStart = this.header.featureSpatialIndex.offset;
        const leafByteOffset = this.featureSpatialIndexFirstLeafCache + index * NODE_ITEM_BYTE_LEN;
        if (this.featureSpatialIndexBytes !== null) {
            return Number(
                new DataView(
                    this.featureSpatialIndexBytes.buffer,
                    this.featureSpatialIndexBytes.byteOffset + leafByteOffset,
                ).getBigUint64(0, true),
            );
        }
        const leafBytes = await this.reader.read(treeStart + leafByteOffset, 8);
        return Number(new DataView(leafBytes.buffer, leafBytes.byteOffset).getBigUint64(0, true));
    }
}

function parseFeatureBytes(bytes: Uint8Array, header: HeaderMeta, id: number): IGeoJsonFeature {
    const aligned = new Uint8Array(bytes.byteLength);
    aligned.set(bytes);
    const bb = new flatbuffers.ByteBuffer(aligned);
    const feature = Feature.getSizePrefixedRootAsFeature(bb);
    return fromFeature(id, feature, header) as IGeoJsonFeature;
}

// ─────────────────── KNN / inspect support types ─────────────────────

export type DistanceUnit = 'meters' | 'kilometers' | 'nautical_miles';

const DISTANCE_SCALE: Record<DistanceUnit, number> = {
    meters: 1,
    kilometers: 1 / 1000,
    nautical_miles: 1 / 1852,
};

export interface PreloadOptions {
    /**
     * Copy the retained index/link byte ranges out of the source buffer
     * (instead of holding `subarray` views over it) and release the
     * underlying `ByteReader`, so the source buffer can be garbage-collected.
     * Leaves only the decoded feature cache and the compact index copies
     * resident — useful when many datasets are kept in memory at once and the
     * whole-file buffers would otherwise add up. Trades a slightly higher
     * transient peak during the load (source buffer and index copies briefly
     * coexist) for a smaller steady-state footprint. After detaching, every
     * query is served from caches; any operation that needs an uncached
     * `read()` throws — re-open the file to read again. Default: `false`. */
    detach?: boolean;
}

export interface NearestFeaturesOptions {
    /** Output distance unit. Default: `'meters'`. */
    unit?: DistanceUnit;
    /** Hard cap on the search radius, in the chosen `unit`.
     *  Features outside this radius are never visited. */
    maxDistance?: number;
    /** Maximum number of features to yield. Default: `100`. Pass
     *  `Infinity` to yield every feature in ascending-distance order;
     *  pass any positive integer to cap. The default exists because
     *  k-NN without a bound on huge datasets is almost always a bug. */
    limit?: number;
}

export interface FlatRecordBlockInfo {
    block: string;
    offset: number;
    length: number;
    /** Percentage of the file occupied by this block (set by `inspect`). */
    percent?: number;
}

export interface FlatRecordInspect {
    mode: FlatRecordMode;
    featuresCount: number;
    linksCount: number;
    hasGeometry: boolean;
    featureColumns: Array<{ name: string; type: number }>;
    linkColumns: Array<{ name: string; type: number }>;
    indexes: {
        featureSpatialIndex: boolean;
        linkSpatialIndex: boolean;
        adjacencyIndex: boolean;
        reverseAdjacencyIndex: boolean;
        featureColumnIndices: string[];
        linkColumnIndices: string[];
    };
    crc32: { stored: number; verified: boolean };
    blocks: FlatRecordBlockInfo[];
    totalBytes: number;
}

interface Bbox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

interface NearestHeapNode {
    dist: number;
    isLeaf: boolean;
    /** When `!isLeaf`: node index of the first child of this entry. */
    childNodeIdx?: number;
    /** When `!isLeaf`: index into `levelBounds` of the child level
     *  (so we can clamp sibling reads to the level boundary). */
    childLevel?: number;
    /** When `isLeaf`: the storage index of the feature this leaf
     *  refers to. With Hilbert-sorted features this equals the
     *  storage index (`leafNodeIdx - firstLeafNodeIdx`). */
    featureIdx?: number;
}

/** Tiny binary min-heap keyed by `dist`. Avoids a heap library
 *  dependency for a single use site. */
class NearestHeap {
    private items: NearestHeapNode[] = [];
    get size(): number {
        return this.items.length;
    }
    push(node: NearestHeapNode): void {
        this.items.push(node);
        let i = this.items.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.items[p].dist <= this.items[i].dist) break;
            [this.items[p], this.items[i]] = [this.items[i], this.items[p]];
            i = p;
        }
    }
    pop(): NearestHeapNode | undefined {
        if (this.items.length === 0) return undefined;
        const top = this.items[0];
        const last = this.items.pop()!;
        if (this.items.length > 0) {
            this.items[0] = last;
            let i = 0;
            const n = this.items.length;
            for (;;) {
                const l = 2 * i + 1;
                const r = 2 * i + 2;
                let s = i;
                if (l < n && this.items[l].dist < this.items[s].dist) s = l;
                if (r < n && this.items[r].dist < this.items[s].dist) s = r;
                if (s === i) break;
                [this.items[s], this.items[i]] = [this.items[i], this.items[s]];
                i = s;
            }
        }
        return top;
    }
}

const EARTH_RADIUS_METERS = 6371008.8;

function haversineMeters(a: readonly [number, number], b: readonly [number, number]): number {
    const toRad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toRad;
    const dLon = (b[0] - a[0]) * toRad;
    const lat1 = a[1] * toRad;
    const lat2 = b[1] * toRad;
    const s =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Minimum great-circle distance from a point to an axis-aligned
 *  lon/lat rectangle, in metres. When the point is inside the rect,
 *  returns 0. Used as the priority-queue key for the best-first KNN
 *  R-tree traversal. */
function rectToPointHaversine(rect: Bbox, point: readonly [number, number]): number {
    const [lon, lat] = point;
    const nearestLon = Math.max(rect.minX, Math.min(lon, rect.maxX));
    const nearestLat = Math.max(rect.minY, Math.min(lat, rect.maxY));
    if (nearestLon === lon && nearestLat === lat) return 0;
    return haversineMeters(point, [nearestLon, nearestLat]);
}
