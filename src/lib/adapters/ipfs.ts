import type { CidV0 } from '../protocol/types';

export interface IpfsClient {
  addJson<T>(obj: T): Promise<CidV0>; // returns CIDv0
  addBytes(bytes: Uint8Array): Promise<CidV0>;
  catJson<T = any>(cid: CidV0): Promise<T>;
}

// In-memory mock IPFS that produces fake CIDv0 by hashing JSON string and prefixing 'Qm' stub.
export class MockIpfs implements IpfsClient {
  private store = new Map<string, Uint8Array>();

  private makeCid(bytes: Uint8Array): CidV0 {
    // Not a real CIDv0; for demo only. Ensures Qm... shape of length 46 by base58-like stub.
    // We'll hex hash and map to base58 alphabet; pad to 44 and prefix 'Qm'.
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let out = '';
    for (let i = 0; i < 44; i++) {
      const idx = parseInt(hex.substr((i * 2) % hex.length, 2), 16) % alphabet.length;
      out += alphabet[idx];
    }
    return ('Qm' + out) as CidV0;
  }

  async addJson<T>(obj: T): Promise<CidV0> {
    const json = JSON.stringify(obj);
    const bytes = new TextEncoder().encode(json);
    const cid = this.makeCid(bytes);
    this.store.set(cid, bytes);
    return cid;
  }

  async addBytes(bytes: Uint8Array): Promise<CidV0> {
    const cid = this.makeCid(bytes);
    this.store.set(cid, bytes);
    return cid;
  }

  async catJson<T = any>(cid: CidV0): Promise<T> {
    const bytes = this.store.get(cid);
    if (!bytes) throw new Error(`IPFS: CID not found ${cid}`);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  }
}

// Real IPFS client using ipfs-http-client, configured for local daemon at 127.0.0.1:5001
import { create as createIpfsHttpClient, type IPFSHTTPClient } from 'ipfs-http-client';
import { CID } from 'multiformats/cid';

export class LocalHttpIpfs implements IpfsClient {
  private readonly client: IPFSHTTPClient;
  constructor(url = 'http://127.0.0.1:5001') {
    this.client = createIpfsHttpClient({ url });
  }

  private async toCidV0AndPin(cid: CID): Promise<CidV0> {
    const v0 = cid.version === 0 ? cid : await cid.toV0();
    const cidStr = v0.toString();
    // Ensure pinned
    try { await this.client.pin.add(v0); } catch (_) { /* ignore if already pinned */ }
    return cidStr as CidV0;
  }

  async addJson<T>(obj: T): Promise<CidV0> {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const res = await this.client.add(bytes, { cidVersion: 0, hashAlg: 'sha2-256', pin: true, rawLeaves: false });
    return this.toCidV0AndPin(res.cid);
  }

  async addBytes(bytes: Uint8Array): Promise<CidV0> {
    const res = await this.client.add(bytes, { cidVersion: 0, hashAlg: 'sha2-256', pin: true, rawLeaves: false });
    return this.toCidV0AndPin(res.cid);
  }

  async catJson<T = any>(cid: CidV0): Promise<T> {
    const decoder = new TextDecoder();
    let data = '';
    try {
      // Enforce a hard timeout of 10 seconds for retrieval
      for await (const chunk of this.client.cat(cid, { timeout: 10_000 })) {
        data += decoder.decode(chunk as Uint8Array, { stream: true });
      }
      data += decoder.decode();
      return JSON.parse(data);
    } catch (e: any) {
      // ipfs-http-client throws TimeoutError/AbortError depending on environment
      const msg = String(e?.message || e);
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || msg.includes('timeout') || msg.includes('aborted')) {
        const err = new Error(`IPFS_CAT_TIMEOUT: Timed out retrieving CID ${cid} after 10s`);
        (err as any).code = 'IPFS_CAT_TIMEOUT';
        (err as any).cid = cid;
        throw err;
      }
      throw e;
    }
  }
}
