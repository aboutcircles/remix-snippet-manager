import type { Address, CidV0, CustomDataLink, CustomDataLinkBase, NamespaceChunk, NamespaceIndex, Profile, SnippetPayload } from '../protocol/types';
import { cidV0ToDigest32, digest32ToCidV0, ensureLowerAddress, keccakCanonicalLink, nowSec, randomNonceHex16 } from '../protocol/utils';
import type { IpfsClient } from '../adapters/ipfs';
import type { RegistryClient } from '../adapters/registry';
import type { WalletAdapter } from '../adapters/wallet';

export interface Env {
  wallet: WalletAdapter;
  ipfs: IpfsClient;
  registry: RegistryClient;
}

export interface ProfileState {
  owner: Address;
  chainId: number;
  profile: Profile;
  index: NamespaceIndex;
  head: NamespaceChunk;
  namespaceKey: Address; // lower address key
  // resolved CIDs for the currently loaded structures
  profileCid?: CidV0 | null;
  indexCid?: CidV0 | null;
  headCid?: CidV0 | null;
}

export const EMPTY_PROFILE: Profile = {
  schemaVersion: '1.2',
  name: null,
  description: null,
  previewImageUrl: null,
  imageUrl: null,
  namespaces: {},
  signingKeys: {}
};

export const EMPTY_INDEX: NamespaceIndex = { head: null, entries: {} };
export const EMPTY_CHUNK: NamespaceChunk = { prev: null, links: [] };

export const OPERATOR_NAMESPACE: Address = '0x1111111111111111111111111111111111111111';

export class ProfileService {
  constructor(private readonly env: Env) {}

  async connectLoadOrInit(): Promise<ProfileState> {
    const { address, chainId } = await this.env.wallet.connect();
    const owner = ensureLowerAddress(address);
    const digest = await this.env.registry.getMetadataDigest(owner);

    let profile: Profile = { ...EMPTY_PROFILE };
    let index: NamespaceIndex = { ...EMPTY_INDEX };
    let head: NamespaceChunk = { ...EMPTY_CHUNK };
    const namespaceKey = OPERATOR_NAMESPACE; // operator org namespace

    let profileCid: CidV0 | null = null;
    let indexCid: CidV0 | null = null;
    let headCid: CidV0 | null = null;

    if (digest !== '0x' + '00'.repeat(32)) {
      // Resolve digest32 -> CIDv0 and fetch profile from local IPFS
      const cid = digest32ToCidV0(digest as `0x${string}`) as CidV0;
      profileCid = cid;
      try {
        profile = await this.env.ipfs.catJson<Profile>(profileCid);
      } catch (e) {
        // Surface a clear error; UI should offer to create a new profile
        const err = new Error(`PROFILE_FETCH_FAILED: Cannot fetch profile CID ${profileCid} from IPFS`);
        (err as any).code = 'PROFILE_FETCH_FAILED';
        (err as any).cid = profileCid;
        throw err;
      }
    }

    if (profile.namespaces[namespaceKey]) {
      indexCid = profile.namespaces[namespaceKey];
      try {
        index = await this.env.ipfs.catJson<NamespaceIndex>(indexCid);
      } catch (e) {
        const err = new Error(`PROFILE_FETCH_FAILED: Cannot fetch namespace index CID ${indexCid}`);
        (err as any).code = 'PROFILE_FETCH_FAILED';
        (err as any).cid = indexCid;
        throw err;
      }

      if (index.head) {
        headCid = index.head;
        try {
          head = await this.env.ipfs.catJson<NamespaceChunk>(headCid);
        } catch (e) {
          const err = new Error(`PROFILE_FETCH_FAILED: Cannot fetch namespace head CID ${headCid}`);
          (err as any).code = 'PROFILE_FETCH_FAILED';
          (err as any).cid = headCid as any;
          throw err;
        }
      } else {
        head = { ...EMPTY_CHUNK };
      }
    }

    return { owner, chainId, profile: { ...profile }, index: { ...index }, head: { ...head }, namespaceKey, profileCid, indexCid, headCid };
  }

  async addOrUpdateSnippet(state: ProfileState, name: string, payload: SnippetPayload): Promise<ProfileState> {
    // Pin payload
    const payloadCid = await this.env.ipfs.addJson(payload);

    // Build link (without signature)
    const linkBase: CustomDataLinkBase = {
      name,
      cid: payloadCid,
      encrypted: false,
      encryptionAlgorithm: null,
      encryptionKeyFingerprint: null,
      chainId: state.chainId,
      signerAddress: state.owner,
      signedAt: nowSec(),
      nonce: randomNonceHex16()
    };

    const hash = keccakCanonicalLink(linkBase);
    const signature = await this.env.wallet.signRawHash(state.owner, hash);
    const link: CustomDataLink = { ...linkBase, signature };

    // Rotate if needed
    let head = { ...state.head };
    let index = { ...state.index };
    if (head.links.length === 100) {
      const closedCid = await this.env.ipfs.addJson(head); // pin
      for (const l of head.links) index.entries[l.name] = closedCid;
      head = { prev: closedCid, links: [] };
    }

    // Insert/replace in head
    const existingIdx = head.links.findIndex((l) => l.name === name);
    if (existingIdx >= 0) head.links[existingIdx] = link; else head.links.push(link);

    // Commit (simplified mock without rebase): pin head → update index → pin index → update profile → pin profile → registry
    const headCid = await this.env.ipfs.addJson(head);
    for (const l of head.links) index.entries[l.name] = headCid;
    index.head = headCid;
    const indexCid = await this.env.ipfs.addJson(index);

    const profile = { ...state.profile };
    profile.namespaces[state.namespaceKey] = indexCid;
    const profileCid = await this.env.ipfs.addJson(profile);

    // Registry expects digest32 from profile CIDv0 (sha2-256 multihash digest)
    const digest32 = cidV0ToDigest32(profileCid);
    await this.env.registry.updateMetadataDigest(digest32);

    return { ...state, head, index, profile, headCid, indexCid, profileCid };
  }

  async deleteSnippet(state: ProfileState, name: string): Promise<ProfileState> {
    let head = { ...state.head };
    let index = { ...state.index };
    head.links = head.links.filter((l) => l.name !== name);
    delete index.entries[name];

    const headCid = await this.env.ipfs.addJson(head);
    for (const l of head.links) index.entries[l.name] = headCid;
    index.head = headCid;
    const indexCid = await this.env.ipfs.addJson(index);

    const profile = { ...state.profile };
    profile.namespaces[state.namespaceKey] = indexCid;
    const profileCid = await this.env.ipfs.addJson(profile);
    const digest32 = cidV0ToDigest32(profileCid);
    await this.env.registry.updateMetadataDigest(digest32);

    return { ...state, head, index, profile, headCid, indexCid, profileCid };
  }

  async listVerifiedLinks(state: ProfileState): Promise<CustomDataLink[]> {
    // For mock, return head.links newest-first by signedAt, tiebreak index order
    return [...state.head.links].sort((a, b) => (b.signedAt - a.signedAt) || (state.head.links.indexOf(b) - state.head.links.indexOf(a)));
  }

  // Resolve a link and its owning chunk CID for a given name
  async getLinkForName(state: ProfileState, name: string): Promise<{ link: CustomDataLink | null; owningChunkCid: CidV0 | null }> {
    let link = state.head.links.find((l) => l.name === name) || null;
    if (link) return { link, owningChunkCid: state.headCid ?? null };

    const chunkCid = state.index.entries[name] ?? null;
    if (!chunkCid) return { link: null, owningChunkCid: null };
    const chunk = await this.env.ipfs.catJson<NamespaceChunk>(chunkCid);
    link = chunk.links.find((l) => l.name === name) || null;
    return { link, owningChunkCid: chunkCid };
  }

  async getSnippetPayload(state: ProfileState, name: string): Promise<SnippetPayload | null> {
    // Try to find the link in the current head first
    let link = state.head.links.find((l) => l.name === name) || null;

    if (!link) {
      // Fallback: use index to find the owning chunk and look up the link
      const chunkCid = state.index.entries[name];
      if (!chunkCid) return null;
      const chunk = await this.env.ipfs.catJson<NamespaceChunk>(chunkCid);
      link = chunk.links.find((l) => l.name === name) || null;
      if (!link) return null;
    }

    // Basic domain check per guide; in mock, skip signature verification
    if (link.chainId !== state.chainId) return null;

    // Fetch and return payload from IPFS
    const payload = await this.env.ipfs.catJson<SnippetPayload>(link.cid);
    return payload;
  }

  // Atomic publish: apply upserts and deletes in-memory, then pin head/index/profile and update registry once
  async publishChanges(
    state: ProfileState,
    changes: { upserts: { name: string; payload: SnippetPayload }[]; deletes: string[] }
  ): Promise<ProfileState> {
    const { upserts, deletes } = changes;
    if ((upserts?.length ?? 0) === 0 && (deletes?.length ?? 0) === 0) return state;

    let head: NamespaceChunk = { ...state.head, links: [...state.head.links] };
    let index: NamespaceIndex = { head: state.index.head, entries: { ...state.index.entries } };
    const profile: Profile = { ...state.profile, namespaces: { ...state.profile.namespaces } };

    // Apply deletions first
    if (deletes && deletes.length) {
      const delSet = new Set(deletes);
      head.links = head.links.filter((l) => !delSet.has(l.name));
      for (const name of delSet) delete index.entries[name];
    }

    // Apply upserts: add payloads, sign links, rotate if needed
    for (const u of upserts ?? []) {
      // Pin payload
      const payloadCid = await this.env.ipfs.addJson(u.payload);
      const linkBase: CustomDataLinkBase = {
        name: u.name,
        cid: payloadCid,
        encrypted: false,
        encryptionAlgorithm: null,
        encryptionKeyFingerprint: null,
        chainId: state.chainId,
        signerAddress: state.owner,
        signedAt: nowSec(),
        nonce: randomNonceHex16()
      };
      const hash = keccakCanonicalLink(linkBase);
      const signature = await this.env.wallet.signRawHash(state.owner, hash);
      const link: CustomDataLink = { ...linkBase, signature };

      if (head.links.length === 100) {
        const closedCid = await this.env.ipfs.addJson(head);
        for (const l of head.links) index.entries[l.name] = closedCid;
        head = { prev: closedCid, links: [] };
      }

      const idx = head.links.findIndex((l) => l.name === u.name);
      if (idx >= 0) head.links[idx] = link; else head.links.push(link);
    }

    // Commit: head -> index -> profile -> registry
    const headCid = await this.env.ipfs.addJson(head);
    for (const l of head.links) index.entries[l.name] = headCid;
    index.head = headCid;
    const indexCid = await this.env.ipfs.addJson(index);

    profile.namespaces[state.namespaceKey] = indexCid;
    const profileCid = await this.env.ipfs.addJson(profile);

    const digest32 = cidV0ToDigest32(profileCid);
    await this.env.registry.updateMetadataDigest(digest32);

    return { ...state, head, index, profile, headCid, indexCid, profileCid };
  }
}
