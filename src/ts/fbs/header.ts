// Hand-maintained mirror of `src/fbs/header.fbs`. See the rules at the
// top of that file before editing — slot IDs and vtable offsets are
// part of the wire format.
//
// Slot layout (kept in sync with header.fbs):
//   0  name                                 vtable 4
//   1  title                                vtable 6
//   2  description                          vtable 8
//   3  metadata                             vtable 10
//   4  timestamp                            vtable 12
//   5  crs                                  vtable 14
//   6  geometry_type                        vtable 16
//   7  has_z                                vtable 18
//   8  has_m                                vtable 20
//   9  has_t                                vtable 22
//   10 has_tm                               vtable 24
//   11 has_feature_geometry                 vtable 26
//   12 envelope                             vtable 28
//   13 features_count                       vtable 30
//   14 columns                              vtable 32
//   15 index_node_size                      vtable 34
//   16 feature_spatial_index_offset         vtable 36
//   17 feature_spatial_index_length         vtable 38
//   18 feature_column_indices               vtable 40
//   19 features_offset                      vtable 42
//   20 features_length                      vtable 44
//   21 links_count                          vtable 46
//   22 link_columns                         vtable 48
//   23 link_spatial_index_offset            vtable 50
//   24 link_spatial_index_length            vtable 52
//   25 link_column_indices                  vtable 54
//   26 link_adjacency_index_offset          vtable 56
//   27 link_adjacency_index_length          vtable 58
//   28 link_reverse_adjacency_index_offset  vtable 60
//   29 link_reverse_adjacency_index_length  vtable 62
//   30 links_offset                         vtable 64
//   31 links_length                         vtable 66

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */

import * as flatbuffers from 'flatbuffers';

import { Column } from '../fbs/column.js';
import { ColumnIndexEntry } from '../fbs/column-index-entry.js';
import { Crs } from '../fbs/crs.js';
import { GeometryType } from '../fbs/geometry-type.js';


export class Header {
  bb: flatbuffers.ByteBuffer|null = null;
  bb_pos = 0;
  __init(i:number, bb:flatbuffers.ByteBuffer):Header {
  this.bb_pos = i;
  this.bb = bb;
  return this;
}

static getRootAsHeader(bb:flatbuffers.ByteBuffer, obj?:Header):Header {
  return (obj || new Header()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
}

static getSizePrefixedRootAsHeader(bb:flatbuffers.ByteBuffer, obj?:Header):Header {
  bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
  return (obj || new Header()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
}

name():string|null
name(optionalEncoding:flatbuffers.Encoding):string|Uint8Array|null
name(optionalEncoding?:any):string|Uint8Array|null {
  const offset = this.bb!.__offset(this.bb_pos, 4);
  return offset ? this.bb!.__string(this.bb_pos + offset, optionalEncoding) : null;
}

title():string|null
title(optionalEncoding:flatbuffers.Encoding):string|Uint8Array|null
title(optionalEncoding?:any):string|Uint8Array|null {
  const offset = this.bb!.__offset(this.bb_pos, 6);
  return offset ? this.bb!.__string(this.bb_pos + offset, optionalEncoding) : null;
}

description():string|null
description(optionalEncoding:flatbuffers.Encoding):string|Uint8Array|null
description(optionalEncoding?:any):string|Uint8Array|null {
  const offset = this.bb!.__offset(this.bb_pos, 8);
  return offset ? this.bb!.__string(this.bb_pos + offset, optionalEncoding) : null;
}

metadata():string|null
metadata(optionalEncoding:flatbuffers.Encoding):string|Uint8Array|null
metadata(optionalEncoding?:any):string|Uint8Array|null {
  const offset = this.bb!.__offset(this.bb_pos, 10);
  return offset ? this.bb!.__string(this.bb_pos + offset, optionalEncoding) : null;
}

timestamp():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 12);
  return offset ? this.bb!.readInt64(this.bb_pos + offset) : BigInt('0');
}

crs(obj?:Crs):Crs|null {
  const offset = this.bb!.__offset(this.bb_pos, 14);
  return offset ? (obj || new Crs()).__init(this.bb!.__indirect(this.bb_pos + offset), this.bb!) : null;
}

geometryType():GeometryType {
  const offset = this.bb!.__offset(this.bb_pos, 16);
  return offset ? this.bb!.readUint8(this.bb_pos + offset) : GeometryType.Unknown;
}

hasZ():boolean {
  const offset = this.bb!.__offset(this.bb_pos, 18);
  return offset ? !!this.bb!.readInt8(this.bb_pos + offset) : false;
}

hasM():boolean {
  const offset = this.bb!.__offset(this.bb_pos, 20);
  return offset ? !!this.bb!.readInt8(this.bb_pos + offset) : false;
}

hasT():boolean {
  const offset = this.bb!.__offset(this.bb_pos, 22);
  return offset ? !!this.bb!.readInt8(this.bb_pos + offset) : false;
}

hasTm():boolean {
  const offset = this.bb!.__offset(this.bb_pos, 24);
  return offset ? !!this.bb!.readInt8(this.bb_pos + offset) : false;
}

hasFeatureGeometry():boolean {
  const offset = this.bb!.__offset(this.bb_pos, 26);
  return offset ? !!this.bb!.readInt8(this.bb_pos + offset) : true;
}

envelope(index: number):number|null {
  const offset = this.bb!.__offset(this.bb_pos, 28);
  return offset ? this.bb!.readFloat64(this.bb!.__vector(this.bb_pos + offset) + index * 8) : 0;
}

envelopeLength():number {
  const offset = this.bb!.__offset(this.bb_pos, 28);
  return offset ? this.bb!.__vector_len(this.bb_pos + offset) : 0;
}

envelopeArray():Float64Array|null {
  const offset = this.bb!.__offset(this.bb_pos, 28);
  return offset ? new Float64Array(this.bb!.bytes().buffer, this.bb!.bytes().byteOffset + this.bb!.__vector(this.bb_pos + offset), this.bb!.__vector_len(this.bb_pos + offset)) : null;
}

featuresCount():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 30);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

columns(index: number, obj?:Column):Column|null {
  const offset = this.bb!.__offset(this.bb_pos, 32);
  return offset ? (obj || new Column()).__init(this.bb!.__indirect(this.bb!.__vector(this.bb_pos + offset) + index * 4), this.bb!) : null;
}

columnsLength():number {
  const offset = this.bb!.__offset(this.bb_pos, 32);
  return offset ? this.bb!.__vector_len(this.bb_pos + offset) : 0;
}

indexNodeSize():number {
  const offset = this.bb!.__offset(this.bb_pos, 34);
  return offset ? this.bb!.readUint16(this.bb_pos + offset) : 16;
}

featureSpatialIndexOffset():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 36);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

featureSpatialIndexLength():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 38);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

featureColumnIndices(index: number, obj?:ColumnIndexEntry):ColumnIndexEntry|null {
  const offset = this.bb!.__offset(this.bb_pos, 40);
  return offset ? (obj || new ColumnIndexEntry()).__init(this.bb!.__indirect(this.bb!.__vector(this.bb_pos + offset) + index * 4), this.bb!) : null;
}

featureColumnIndicesLength():number {
  const offset = this.bb!.__offset(this.bb_pos, 40);
  return offset ? this.bb!.__vector_len(this.bb_pos + offset) : 0;
}

featuresOffset():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 42);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

featuresLength():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 44);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

linksCount():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 46);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

linkColumns(index: number, obj?:Column):Column|null {
  const offset = this.bb!.__offset(this.bb_pos, 48);
  return offset ? (obj || new Column()).__init(this.bb!.__indirect(this.bb!.__vector(this.bb_pos + offset) + index * 4), this.bb!) : null;
}

linkColumnsLength():number {
  const offset = this.bb!.__offset(this.bb_pos, 48);
  return offset ? this.bb!.__vector_len(this.bb_pos + offset) : 0;
}

linkSpatialIndexOffset():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 50);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

linkSpatialIndexLength():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 52);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

linkColumnIndices(index: number, obj?:ColumnIndexEntry):ColumnIndexEntry|null {
  const offset = this.bb!.__offset(this.bb_pos, 54);
  return offset ? (obj || new ColumnIndexEntry()).__init(this.bb!.__indirect(this.bb!.__vector(this.bb_pos + offset) + index * 4), this.bb!) : null;
}

linkColumnIndicesLength():number {
  const offset = this.bb!.__offset(this.bb_pos, 54);
  return offset ? this.bb!.__vector_len(this.bb_pos + offset) : 0;
}

linkAdjacencyIndexOffset():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 56);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

linkAdjacencyIndexLength():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 58);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

linkReverseAdjacencyIndexOffset():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 60);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

linkReverseAdjacencyIndexLength():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 62);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

linksOffset():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 64);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

linksLength():bigint {
  const offset = this.bb!.__offset(this.bb_pos, 66);
  return offset ? this.bb!.readUint64(this.bb_pos + offset) : BigInt('0');
}

static startHeader(builder:flatbuffers.Builder) {
  builder.startObject(32);
}

static addName(builder:flatbuffers.Builder, nameOffset:flatbuffers.Offset) {
  builder.addFieldOffset(0, nameOffset, 0);
}

static addTitle(builder:flatbuffers.Builder, titleOffset:flatbuffers.Offset) {
  builder.addFieldOffset(1, titleOffset, 0);
}

static addDescription(builder:flatbuffers.Builder, descriptionOffset:flatbuffers.Offset) {
  builder.addFieldOffset(2, descriptionOffset, 0);
}

static addMetadata(builder:flatbuffers.Builder, metadataOffset:flatbuffers.Offset) {
  builder.addFieldOffset(3, metadataOffset, 0);
}

static addTimestamp(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(4, v, BigInt('0'));
}

static addCrs(builder:flatbuffers.Builder, crsOffset:flatbuffers.Offset) {
  builder.addFieldOffset(5, crsOffset, 0);
}

static addGeometryType(builder:flatbuffers.Builder, geometryType:GeometryType) {
  builder.addFieldInt8(6, geometryType, GeometryType.Unknown);
}

static addHasZ(builder:flatbuffers.Builder, hasZ:boolean) {
  builder.addFieldInt8(7, +hasZ, +false);
}

static addHasM(builder:flatbuffers.Builder, hasM:boolean) {
  builder.addFieldInt8(8, +hasM, +false);
}

static addHasT(builder:flatbuffers.Builder, hasT:boolean) {
  builder.addFieldInt8(9, +hasT, +false);
}

static addHasTm(builder:flatbuffers.Builder, hasTm:boolean) {
  builder.addFieldInt8(10, +hasTm, +false);
}

static addHasFeatureGeometry(builder:flatbuffers.Builder, v:boolean) {
  builder.addFieldInt8(11, +v, +true);
}

static addEnvelope(builder:flatbuffers.Builder, envelopeOffset:flatbuffers.Offset) {
  builder.addFieldOffset(12, envelopeOffset, 0);
}

static createEnvelopeVector(builder:flatbuffers.Builder, data:number[]|Float64Array):flatbuffers.Offset;
/**
 * @deprecated This Uint8Array overload will be removed in the future.
 */
static createEnvelopeVector(builder:flatbuffers.Builder, data:number[]|Uint8Array):flatbuffers.Offset;
static createEnvelopeVector(builder:flatbuffers.Builder, data:number[]|Float64Array|Uint8Array):flatbuffers.Offset {
  builder.startVector(8, data.length, 8);
  for (let i = data.length - 1; i >= 0; i--) {
    builder.addFloat64(data[i]!);
  }
  return builder.endVector();
}

static startEnvelopeVector(builder:flatbuffers.Builder, numElems:number) {
  builder.startVector(8, numElems, 8);
}

static addFeaturesCount(builder:flatbuffers.Builder, featuresCount:bigint) {
  builder.addFieldInt64(13, featuresCount, BigInt('0'));
}

static addColumns(builder:flatbuffers.Builder, columnsOffset:flatbuffers.Offset) {
  builder.addFieldOffset(14, columnsOffset, 0);
}

static createColumnsVector(builder:flatbuffers.Builder, data:flatbuffers.Offset[]):flatbuffers.Offset {
  builder.startVector(4, data.length, 4);
  for (let i = data.length - 1; i >= 0; i--) {
    builder.addOffset(data[i]!);
  }
  return builder.endVector();
}

static startColumnsVector(builder:flatbuffers.Builder, numElems:number) {
  builder.startVector(4, numElems, 4);
}

static addIndexNodeSize(builder:flatbuffers.Builder, indexNodeSize:number) {
  builder.addFieldInt16(15, indexNodeSize, 16);
}

static addFeatureSpatialIndexOffset(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(16, v, BigInt('0'));
}

static addFeatureSpatialIndexLength(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(17, v, BigInt('0'));
}

static addFeatureColumnIndices(builder:flatbuffers.Builder, off:flatbuffers.Offset) {
  builder.addFieldOffset(18, off, 0);
}

static createFeatureColumnIndicesVector(builder:flatbuffers.Builder, data:flatbuffers.Offset[]):flatbuffers.Offset {
  builder.startVector(4, data.length, 4);
  for (let i = data.length - 1; i >= 0; i--) {
    builder.addOffset(data[i]!);
  }
  return builder.endVector();
}

static addFeaturesOffset(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(19, v, BigInt('0'));
}

static addFeaturesLength(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(20, v, BigInt('0'));
}

static addLinksCount(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(21, v, BigInt('0'));
}

static addLinkColumns(builder:flatbuffers.Builder, off:flatbuffers.Offset) {
  builder.addFieldOffset(22, off, 0);
}

static createLinkColumnsVector(builder:flatbuffers.Builder, data:flatbuffers.Offset[]):flatbuffers.Offset {
  builder.startVector(4, data.length, 4);
  for (let i = data.length - 1; i >= 0; i--) {
    builder.addOffset(data[i]!);
  }
  return builder.endVector();
}

static addLinkSpatialIndexOffset(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(23, v, BigInt('0'));
}

static addLinkSpatialIndexLength(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(24, v, BigInt('0'));
}

static addLinkColumnIndices(builder:flatbuffers.Builder, off:flatbuffers.Offset) {
  builder.addFieldOffset(25, off, 0);
}

static createLinkColumnIndicesVector(builder:flatbuffers.Builder, data:flatbuffers.Offset[]):flatbuffers.Offset {
  builder.startVector(4, data.length, 4);
  for (let i = data.length - 1; i >= 0; i--) {
    builder.addOffset(data[i]!);
  }
  return builder.endVector();
}

static addLinkAdjacencyIndexOffset(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(26, v, BigInt('0'));
}

static addLinkAdjacencyIndexLength(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(27, v, BigInt('0'));
}

static addLinkReverseAdjacencyIndexOffset(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(28, v, BigInt('0'));
}

static addLinkReverseAdjacencyIndexLength(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(29, v, BigInt('0'));
}

static addLinksOffset(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(30, v, BigInt('0'));
}

static addLinksLength(builder:flatbuffers.Builder, v:bigint) {
  builder.addFieldInt64(31, v, BigInt('0'));
}

static endHeader(builder:flatbuffers.Builder):flatbuffers.Offset {
  const offset = builder.endObject();
  return offset;
}

static finishHeaderBuffer(builder:flatbuffers.Builder, offset:flatbuffers.Offset) {
  builder.finish(offset);
}

static finishSizePrefixedHeaderBuffer(builder:flatbuffers.Builder, offset:flatbuffers.Offset) {
  builder.finish(offset, undefined, true);
}

}
