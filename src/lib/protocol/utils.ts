import { keccak256 } from 'ethers';
import type { Address, CustomDataLink, CustomDataLinkBase } from './types';
import { base58btc } from 'multiformats/bases/base58';

// Validations
export function isLowerHexAddress(s: string): s is Address {
  return /^0x[a-f0-9]{40}$/.test(s);
}

export function ensureLowerAddress(addr: string): Address {
  const lower = addr.toLowerCase();
  if (!isLowerHexAddress(lower)) throw new Error(`Invalid address: ${addr}`);
  return lower as Address;
}

export function isCidV0(cid: string): boolean {
  return typeof cid === 'string' && cid.length === 46 && cid.startsWith('Qm');
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function randomNonceHex16(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return ('0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

// Canonicalization: JSON without signature, sorted keys, UTF-8 bytes
export function canonicalizeLink(link: CustomDataLink | CustomDataLinkBase): Uint8Array {
  const withoutSig: any = { ...link };
  delete withoutSig.signature;

  function sortKeys(obj: any): any {
    if (obj === null) return null;
    if (Array.isArray(obj)) return obj.map(sortKeys);
    if (typeof obj === 'object') {
      const out: any = {};
      for (const key of Object.keys(obj).sort()) {
        out[key] = sortKeys(obj[key]);
      }
      return out;
    }
    // numbers: rely on JSON serializer respecting JS number rules; spec mentions limits
    return obj;
  }

  const sorted = sortKeys(withoutSig);
  const json = JSON.stringify(sorted);
  return new TextEncoder().encode(json);
}

export function keccakCanonicalLink(link: CustomDataLink | CustomDataLinkBase): `0x${string}` {
  const bytes = canonicalizeLink(link);
  // ethers keccak256 expects hex data; convert
  const hex = '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return keccak256(hex) as `0x${string}`;
}

export function normalizeV(v: number): number {
  return v === 0 || v === 1 ? v + 27 : v;
}

// CIDv0 <-> digest32 helpers
export function cidV0ToDigest32(cidV0: string): `0x${string}` {
  if (!isCidV0(cidV0)) throw new Error(`Not CIDv0: ${cidV0}`);
  // CIDv0 is raw base58btc without multibase prefix, use baseDecode
  const bytes = base58btc.baseDecode(cidV0);
  // multihash: 0x12 0x20 || digest[32]
  if (bytes[0] !== 0x12 || bytes[1] !== 0x20 || bytes.length !== 34) throw new Error('Unexpected multihash layout');
  const digest = bytes.slice(2);
  return ('0x' + Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

export function digest32ToCidV0(digest32: `0x${string}`): string {
  if (!/^0x[0-9a-f]{64}$/.test(digest32)) throw new Error('Invalid digest32');
  const digest = new Uint8Array(34);
  digest[0] = 0x12; // sha2-256
  digest[1] = 0x20; // 32 bytes
  for (let i = 0; i < 32; i++) digest[2 + i] = parseInt(digest32.slice(2 + i * 2, 4 + i * 2), 16);
  // Produce CIDv0 base58btc without multibase prefix
  return base58btc.baseEncode(digest);
}
