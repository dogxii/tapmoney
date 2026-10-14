// 图片已经压缩，ZIP 使用标准 STORE 模式，避免额外依赖和重复压缩。
const encoder = new TextEncoder();
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  table[i] = value >>> 0;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipFiles(files) {
  const chunks = [], directory = [];
  let offset = 0, directorySize = 0;
  for (const file of files) {
    if (!file.name || /[\\/\x00]/.test(file.name)) throw new Error('文件名无效。');
    const name = encoder.encode(file.name);
    const bytes = file.bytes;
    if (!(bytes instanceof Uint8Array) || name.length > 65535 || bytes.length > 0xffffffff) throw new Error('文件过大。');
    const crc = crc32(bytes);
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true);
    view.setUint16(12, 33, true); // 1980-01-01
    view.setUint32(14, crc, true); view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true);
    view.setUint16(26, name.length, true); header.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const entry = new DataView(central.buffer);
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x800, true); entry.setUint16(14, 33, true);
    entry.setUint32(16, crc, true); entry.setUint32(20, bytes.length, true); entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true); central.set(name, 46);
    chunks.push(header, bytes); directory.push(central);
    offset += header.length + bytes.length; directorySize += central.length;
  }
  if (files.length > 65535 || offset + directorySize > 0xffffffff) throw new Error('导出体积过大，请分批保存。');
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true);
  view.setUint32(12, directorySize, true); view.setUint32(16, offset, true);
  return new Blob([...chunks, ...directory, end], { type: 'application/zip' });
}
