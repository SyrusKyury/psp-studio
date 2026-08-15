import { openImageSource } from './image-source.js';

const SECTOR_SIZE = 2048;
const ASCII = new TextDecoder('ascii');

function readBothEndianU32(view, offset) {
  const le = view.getUint32(offset, true);
  const be = view.getUint32(offset + 4, false);
  if (le !== be) console.warn('ISO both-endian value mismatch', { offset, le, be });
  return le;
}

function cleanIdentifier(raw) {
  return raw.replace(/;\d+$/, '').replace(/\.$/, '');
}

function readPaddedAscii(bytes, offset, length) {
  return ASCII.decode(bytes.subarray(offset, offset + length)).replace(/[\0 ]+$/g, '').trim();
}


function parseIsoDate17(bytes, offset) {
  if (offset + 17 > bytes.length) return null;
  const raw = ASCII.decode(bytes.subarray(offset, offset + 16));
  if (!/^\d{16}$/.test(raw) || /^0+$/.test(raw)) return null;
  const year = Number(raw.slice(0,4)), month=Number(raw.slice(4,6)), day=Number(raw.slice(6,8)), hour=Number(raw.slice(8,10)), minute=Number(raw.slice(10,12)), second=Number(raw.slice(12,14)), centis=Number(raw.slice(14,16));
  if (!year || month<1 || month>12 || day<1 || day>31 || hour>23 || minute>59 || second>59) return null;
  const quarterOffset = new DataView(bytes.buffer, bytes.byteOffset + offset + 16, 1).getInt8(0);
  const utcMs = Date.UTC(year, month-1, day, hour, minute, second, centis*10) - quarterOffset*15*60*1000;
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseIsoDate7(bytes, offset) {
  if (offset + 7 > bytes.length) return null;
  const year = 1900 + bytes[offset], month = bytes[offset + 1], day = bytes[offset + 2], hour = bytes[offset + 3], minute = bytes[offset + 4], second = bytes[offset + 5];
  if (!month || !day || month > 12 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const quarterOffset = new DataView(bytes.buffer, bytes.byteOffset + offset + 6, 1).getInt8(0);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - quarterOffset * 15 * 60 * 1000;
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseRecord(bytes, relativeOffset, absoluteOffset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + relativeOffset);
  const length = view.getUint8(0);
  if (!length || relativeOffset + length > bytes.byteLength) return null;

  const extent = readBothEndianU32(view, 2);
  const size = readBothEndianU32(view, 10);
  const flags = view.getUint8(25);
  const idLength = view.getUint8(32);
  const idBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + relativeOffset + 33, idLength);
  let rawName;
  if (idLength === 1 && idBytes[0] === 0) rawName = '.';
  else if (idLength === 1 && idBytes[0] === 1) rawName = '..';
  else rawName = ASCII.decode(idBytes);

  return {
    recordLength: length,
    recordOffset: absoluteOffset,
    extent,
    lba: extent,
    offset: extent * SECTOR_SIZE,
    size,
    flags,
    isDirectory: Boolean(flags & 0x02),
    rawName,
    name: cleanIdentifier(rawName),
    recordedAt: parseIsoDate7(bytes, relativeOffset + 18),
  };
}

export class IsoReader {
  constructor(source, options = {}) {
    this.source = source;
    this.physicalFile = source.file;
    this.file = Object.freeze({ name: source.name, size: source.size, storageSize: source.storageSize, type: 'application/x-iso9660-image' });
    this.format = source.format;
    this.storageSize = source.storageSize;
    this.force = Boolean(options.force);
    this.sectorSize = SECTOR_SIZE;
    this.root = null;
    this.entries = new Map();
    this.volume = null;
    this.descriptors = [];
  }

  static async open(file, options = {}) {
    const source = await openImageSource(file);
    const iso = new IsoReader(source, options);
    await iso.#parse();
    return iso;
  }

  async #slice(offset, length) { return this.source.read(offset, length); }

  async readBytes(offset, length) {
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0) throw new Error('Invalid ISO read range.');
    return this.#slice(offset, Math.min(length, Math.max(0, this.file.size - offset)));
  }

  async readSectors(lba, count = 1) {
    const start = Math.max(0, Math.trunc(Number(lba) || 0));
    const sectors = Math.max(1, Math.min(64, Math.trunc(Number(count) || 1)));
    return this.#slice(start * SECTOR_SIZE, sectors * SECTOR_SIZE);
  }

  async #parse() {
    if (this.file.size < (17 * SECTOR_SIZE)) throw new Error('Image is too small to contain an ISO 9660 filesystem.');

    let pvdBytes = null;
    let pvdSector = -1;
    const scanEnd = this.force ? Math.min(512, Math.floor(this.file.size / SECTOR_SIZE)) : Math.min(80, Math.floor(this.file.size / SECTOR_SIZE));
    let descriptorRun = false;
    for (let sector = 16; sector < scanEnd; sector++) {
      const bytes = await this.#slice(sector * SECTOR_SIZE, SECTOR_SIZE);
      if (bytes.length < SECTOR_SIZE) break;
      const type = bytes[0];
      const ident = ASCII.decode(bytes.subarray(1, 6));
      if (ident !== 'CD001') {
        if (!this.force && !descriptorRun) throw new Error(`Not a valid ISO 9660 image: descriptor ${sector} is missing CD001.`);
        if (!this.force && descriptorRun) throw new Error(`Broken ISO 9660 descriptor sequence at LBA ${sector}.`);
        continue;
      }
      descriptorRun = true;
      this.descriptors.push({ sector, type });
      if (type === 1 && !pvdBytes) { pvdBytes = bytes; pvdSector = sector; }
      if (type === 255 && pvdBytes) break;
    }
    if (!pvdBytes) throw new Error('Primary Volume Descriptor not found.');

    const pvdView = new DataView(pvdBytes.buffer, pvdBytes.byteOffset, pvdBytes.byteLength);
    const volumeSpaceSize = readBothEndianU32(pvdView, 80);
    const logicalBlockSize = pvdView.getUint16(128, true);
    if (logicalBlockSize !== SECTOR_SIZE) throw new Error(`Unsupported ISO logical block size: ${logicalBlockSize} bytes.`);
    const root = parseRecord(pvdBytes, 156, pvdSector * SECTOR_SIZE + 156);
    if (!root?.isDirectory) throw new Error('Invalid ISO root directory record.');

    this.volume = {
      systemId: readPaddedAscii(pvdBytes, 8, 32),
      volumeId: readPaddedAscii(pvdBytes, 40, 32),
      volumeSpaceSize,
      sectorSize: SECTOR_SIZE,
      volumeSetId: readPaddedAscii(pvdBytes, 190, 128),
      publisherId: readPaddedAscii(pvdBytes, 318, 128),
      dataPreparerId: readPaddedAscii(pvdBytes, 446, 128),
      applicationId: readPaddedAscii(pvdBytes, 574, 128),
      copyrightFileId: readPaddedAscii(pvdBytes, 702, 37),
      creationDate: parseIsoDate17(pvdBytes, 813),
      modificationDate: parseIsoDate17(pvdBytes, 830),
      pathTableSize: readBothEndianU32(pvdView, 132, 'path table size'),
      lPathTableLba: pvdView.getUint32(140, true),
      mPathTableLba: pvdView.getUint32(148, false),
      rootDirectoryLba: root.lba,
      descriptorTerminatorSector: this.descriptors.find((item) => item.type === 255)?.sector ?? null,
      pvdSector,
    };
    root.name = '/';
    root.path = '/';
    root.children = [];
    this.root = root;
    this.entries.set('/', root);

    await this.#readDirectory(root, new Set());
  }

  async #readDirectory(directory, visited) {
    const visitKey = `${directory.extent}:${directory.size}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);

    if (directory.size > 64 * 1024 * 1024) throw new Error(`Directory table is unexpectedly large: ${directory.path}`);
    const bytes = await this.#slice(directory.offset, directory.size);
    let cursor = 0;

    while (cursor < bytes.length) {
      const recordLength = bytes[cursor];
      if (recordLength === 0) {
        cursor = Math.ceil((cursor + 1) / SECTOR_SIZE) * SECTOR_SIZE;
        continue;
      }
      const record = parseRecord(bytes, cursor, directory.offset + cursor);
      if (!record) break;
      cursor += record.recordLength;
      if (record.rawName === '.' || record.rawName === '..') continue;

      record.path = directory.path === '/' ? `/${record.name}` : `${directory.path}/${record.name}`;
      if (record.isDirectory) record.children = [];
      record.parent = directory;
      directory.children.push(record);
      this.entries.set(record.path, record);
    }

    for (const entry of directory.children) {
      if (entry.isDirectory) await this.#readDirectory(entry, visited);
    }
  }

  get(path) { return this.entries.get(path); }
  all() { return [...this.entries.values()]; }

  async readEntry(entry, maxBytes = entry.size) {
    if (!entry || entry.isDirectory) throw new Error('Cannot read a directory as a file.');
    const length = Math.min(entry.size, maxBytes);
    if (this.source.format === 'iso') return this.physicalFile.slice(entry.offset, entry.offset + length);
    return new Blob([await this.#slice(entry.offset, length)], { type: 'application/octet-stream' });
  }

  async magic(entry, length = 4) {
    const bytes = new Uint8Array(await (await this.readEntry(entry, length)).arrayBuffer());
    return ASCII.decode(bytes);
  }
}

export { SECTOR_SIZE };
