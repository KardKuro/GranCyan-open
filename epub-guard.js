'use strict';

const fs = require('node:fs');
const MAX_ENTRIES = 10000;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_RATIO = 250;

function rejectUnsafeEpub(file) {
  const b = fs.readFileSync(file);
  const start = Math.max(0, b.length - 0x10016);
  let eocd = -1;
  for (let i = b.length - 22; i >= start; i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EPUB 不是完整的 ZIP 文件');
  const entries = b.readUInt16LE(eocd + 10);
  const centralSize = b.readUInt32LE(eocd + 12);
  const centralAt = b.readUInt32LE(eocd + 16);
  if (entries > MAX_ENTRIES || centralAt + centralSize > b.length) throw new Error('EPUB 的 ZIP 目录异常');
  let at = centralAt, total = 0;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > b.length || b.readUInt32LE(at) !== 0x02014b50) throw new Error('EPUB 的 ZIP 目录损坏');
    const packed = b.readUInt32LE(at + 20);
    const unpacked = b.readUInt32LE(at + 24);
    const nameLen = b.readUInt16LE(at + 28);
    const extraLen = b.readUInt16LE(at + 30);
    const commentLen = b.readUInt16LE(at + 32);
    const localAt = b.readUInt32LE(at + 42);
    if ([packed, unpacked, localAt].includes(0xffffffff)) throw new Error('暂不接受 ZIP64 EPUB');
    if (unpacked > MAX_ENTRY_BYTES) throw new Error('EPUB 内有超过 32MB 的单个文件');
    if (packed > 0 && unpacked / packed > MAX_RATIO) throw new Error('EPUB 的压缩比异常');
    total += unpacked;
    if (total > MAX_TOTAL_BYTES) throw new Error('EPUB 解压后超过 200MB');
    if (localAt + 30 > b.length || b.readUInt32LE(localAt) !== 0x04034b50) throw new Error('EPUB 的 ZIP 文件头损坏');
    const flags = b.readUInt16LE(localAt + 6);
    if (!(flags & 0x08)) {
      const localPacked = b.readUInt32LE(localAt + 18);
      const localUnpacked = b.readUInt32LE(localAt + 22);
      if (localPacked !== packed || localUnpacked !== unpacked) throw new Error('EPUB 的 ZIP 大小字段互相矛盾');
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  if (at > centralAt + centralSize) throw new Error('EPUB 的 ZIP 目录越界');
}

module.exports = { rejectUnsafeEpub };
