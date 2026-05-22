export const magicbytes: Uint8Array = new Uint8Array([0x66, 0x72, 0x62, 0x01, 0x66, 0x72, 0x62, 0x00]);
export const SIZE_PREFIX_LEN = 4;

/** Validate that the leading bytes identify a FlatRecord file with
 *  the current major version (byte 3 = 0x01). Future readers may
 *  accept additional majors; today only 0x01 is supported. */
export function isValidMagicBytes(bytes: Uint8Array): boolean {
    return (
        bytes.byteLength >= 4 &&
        bytes[0] === 0x66 &&
        bytes[1] === 0x72 &&
        bytes[2] === 0x62 &&
        bytes[3] === 0x01
    );
}
