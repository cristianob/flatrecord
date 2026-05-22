import { ColumnType } from './fbs/column-type.js';

export interface ColumnMeta {
    name: string;
    type: ColumnType;
    title: string | null;
    description: string | null;
    width: number;
    precision: number;
    scale: number;
    nullable: boolean;
    unique: boolean;
    primary_key: boolean;
}

/**
 * Infer the binary column type from a runtime JavaScript value. Shared
 * by the feature and link writers — both use the same rule so a value
 * of the same shape gets the same wire type whether it appears on a
 * feature or a link.
 */
export function inferColumnType(value: unknown): ColumnType {
    if (typeof value === 'boolean') return ColumnType.Bool;
    if (typeof value === 'number') return ColumnType.Double;
    if (typeof value === 'string') return ColumnType.String;
    if (value === null) return ColumnType.String;
    if (value instanceof Uint8Array) return ColumnType.Binary;
    if (typeof value === 'object') return ColumnType.Json;
    throw new Error(`Unknown property type: ${typeof value}`);
}

/** Build a default `ColumnMeta` for a single column. */
export function columnMeta(name: string, type: ColumnType): ColumnMeta {
    return {
        name,
        type,
        title: null,
        description: null,
        width: -1,
        precision: -1,
        scale: -1,
        nullable: true,
        unique: false,
        primary_key: false,
    };
}
