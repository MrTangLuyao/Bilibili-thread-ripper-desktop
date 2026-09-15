"use strict";
let fs;
try { fs = require("original-fs"); } catch (_) { fs = require("node:fs"); }
const crypto = require("node:crypto");
function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function safePath(name) {
  if (typeof name !== "string" || !name || /[\\:\0]/.test(name) || name.split("/").some(x => !x || x === "." || x === "..")) throw Error("Unsafe ASAR path");
  return name;
}
class Asar {
  constructor(bytes) {
    this.bytes = bytes;
    if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) throw Error("Invalid ASAR header");
    this.base = 8 + bytes.readUInt32LE(4);
    const size = bytes.readUInt32LE(12);
    if (16 + size > this.base || this.base > bytes.length) throw Error("Invalid ASAR bounds");
    this.header = JSON.parse(bytes.toString("utf8", 16, 16 + size));
    this.edits = new Map();
  }
  static open(file) { return new Asar(fs.readFileSync(file)); }
  entry(name) { return safePath(name).split("/").reduce((n, k) => n?.files?.[k], this.header); }
  read(name) {
    if (this.edits.has(name)) return this.edits.get(name);
    const entry = this.entry(name);
    if (!entry || entry.files || entry.unpacked || entry.link) throw Error(`Not an embedded file: ${name}`);
    const offset = Number(entry.offset), size = Number(entry.size);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || this.base + offset + size > this.bytes.length) throw Error("Invalid ASAR file bounds");
    return this.bytes.subarray(this.base + offset, this.base + offset + size);
  }
  text(name) { return this.read(name).toString("utf8"); }
  set(name, bytes) { safePath(name); this.edits.set(name, Buffer.from(bytes)); }
  pack() {
    const header = JSON.parse(JSON.stringify(this.header));
    for (const [name] of this.edits) {
      const keys = name.split("/"); let node = header;
      for (const key of keys.slice(0, -1)) {
        node.files ||= {};
        node.files[key] ||= { files: {} };
        if (!node.files[key].files) throw Error("ASAR file/directory conflict");
        node = node.files[key];
      }
      node.files ||= {}; node.files[keys.at(-1)] = { size: 0, offset: "0" };
    }
    let offset = 0; const bodies = [];
    const walk = (node, prefix = "") => {
      for (const [name, entry] of Object.entries(node.files || {})) {
        const full = prefix ? `${prefix}/${name}` : name;
        if (entry.files) walk(entry, full);
        else if (!entry.unpacked && !entry.link) {
          const body = this.read(full);
          entry.offset = String(offset); entry.size = body.length;
          if (entry.integrity || this.edits.has(full)) {
            const blockSize = entry.integrity?.blockSize || 4 * 1024 * 1024;
            const blocks = [];
            for (let i = 0; i < body.length; i += blockSize) blocks.push(sha(body.subarray(i, i + blockSize)));
            entry.integrity = { algorithm: "SHA256", hash: sha(body), blockSize, blocks };
          }
          bodies.push(body); offset += body.length;
        }
      }
    };
    walk(header);
    const json = Buffer.from(JSON.stringify(header));
    const padded = Math.ceil((json.length + 4) / 4) * 4;
    const prefix = Buffer.alloc(12 + padded);
    prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(padded + 4, 4);
    prefix.writeUInt32LE(padded, 8); prefix.writeUInt32LE(json.length, 12); json.copy(prefix, 16);
    return Buffer.concat([prefix, ...bodies]);
  }
}
module.exports = { Asar, sha };
