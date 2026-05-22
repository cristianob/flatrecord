/**
 * CRC-32 (IEEE 802.3 polynomial 0xEDB88320) over a byte sequence.
 *
 * Used to detect corruption / truncation of the header. The polynomial
 * matches `zlib.crc32`, `crc32(1)` in coreutils, and `CRC-32` in most
 * implementations — so users can verify the value externally with any
 * standard tool.
 */

const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        t[i] = c >>> 0;
    }
    return t;
})();

export function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
