import { inflateRawSync, crc32 } from "node:zlib";
import { proofError, safeProofPath } from "./internationalProofContract.js";

// Deliberately restricted ZIP profile: single disk, no ZIP64/encryption/links.
// Nothing is extracted to disk or executed. Bounds are checked before inflation.
export function readProofArchive(bytes) {
  const fail = () => {
    throw proofError();
  };
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > 64 * 1024 * 1024 ||
    bytes.length < 22
  )
    fail();
  const end = bytes.length - 22;
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt16LE(end + 20) !== 0 ||
    bytes.readUInt32LE(end + 4) !== 0
  )
    fail();
  const count = bytes.readUInt16LE(end + 10);
  const length = bytes.readUInt32LE(end + 12);
  const offset = bytes.readUInt32LE(end + 16);
  if (
    count !== bytes.readUInt16LE(end + 8) ||
    !count ||
    count > 2000 ||
    offset + length !== end
  )
    fail();
  const files = new Map();
  const names = new Set();
  const ranges = [];
  let pos = offset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(pos + 8);
    const method = bytes.readUInt16LE(pos + 10);
    const checksum = bytes.readUInt32LE(pos + 16);
    const packed = bytes.readUInt32LE(pos + 20);
    const unpacked = bytes.readUInt32LE(pos + 24);
    const nameLength = bytes.readUInt16LE(pos + 28);
    const extra = bytes.readUInt16LE(pos + 30);
    const comment = bytes.readUInt16LE(pos + 32);
    const start = bytes.readUInt32LE(pos + 42);
    const mode = bytes.readUInt32LE(pos + 38) >>> 16;
    const next = pos + 46 + nameLength + extra + comment;
    if (
      next > end ||
      flags & ~0x808 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(pos + 34) !== 0 ||
      packed === 0xffffffff ||
      unpacked === 0xffffffff ||
      start === 0xffffffff ||
      ((mode & 0xf000) !== 0 &&
        (mode & 0xf000) !== 0x8000 &&
        (mode & 0xf000) !== 0x4000)
    )
      fail();
    const rawName = bytes.subarray(pos + 46, pos + 46 + nameLength);
    const name = rawName.toString("utf8");
    if (!Buffer.from(name).equals(rawName)) fail();
    const directory = name.endsWith("/");
    safeProofPath(directory ? name.slice(0, -1) : name);
    if (names.has(name.toLowerCase())) fail();
    names.add(name.toLowerCase());
    total += unpacked;
    if (
      total > 128 * 1024 * 1024 ||
      unpacked > Math.max(1, packed) * 100 ||
      start + 30 > offset ||
      bytes.readUInt32LE(start) !== 0x04034b50 ||
      bytes.readUInt16LE(start + 6) !== flags ||
      bytes.readUInt16LE(start + 8) !== method
    )
      fail();
    const localNameLength = bytes.readUInt16LE(start + 26);
    const localExtra = bytes.readUInt16LE(start + 28);
    const dataStart = start + 30 + localNameLength + localExtra;
    if (
      dataStart + packed > offset ||
      !bytes.subarray(start + 30, start + 30 + localNameLength).equals(rawName)
    )
      fail();
    if (
      !(flags & 8) &&
      (bytes.readUInt32LE(start + 14) !== checksum ||
        bytes.readUInt32LE(start + 18) !== packed ||
        bytes.readUInt32LE(start + 22) !== unpacked)
    )
      fail();
    let dataEnd = dataStart + packed;
    if (flags & 8) {
      const signed =
        dataEnd + 4 <= offset && bytes.readUInt32LE(dataEnd) === 0x08074b50;
      const descriptor = dataEnd + (signed ? 4 : 0);
      if (
        descriptor + 12 > offset ||
        bytes.readUInt32LE(descriptor) !== checksum ||
        bytes.readUInt32LE(descriptor + 4) !== packed ||
        bytes.readUInt32LE(descriptor + 8) !== unpacked
      )
        fail();
      dataEnd = descriptor + 12;
    }
    if (ranges.some(([a, b]) => start < b && dataEnd > a)) fail();
    ranges.push([start, dataEnd]);
    let value;
    try {
      value =
        method === 0
          ? bytes.subarray(dataStart, dataStart + packed)
          : inflateRawSync(bytes.subarray(dataStart, dataStart + packed), {
              maxOutputLength: Math.max(1, unpacked),
            });
    } catch {
      fail();
    }
    if (
      value.length !== unpacked ||
      crc32(value) !== checksum ||
      (directory && value.length)
    )
      fail();
    if (!directory) files.set(name, value);
    pos = next;
  }
  if (pos !== end) fail();
  for (const name of files.keys())
    for (const other of files.keys())
      if (
        name !== other &&
        other.toLowerCase().startsWith(`${name.toLowerCase()}/`)
      )
        fail();
  return files;
}
