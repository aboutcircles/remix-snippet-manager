// Core protocol types based on implementation_guide.md

export type Address = `0x${string}`; // lowercase enforced via helpers
export type CidV0 = string; // base58btc Qm...

export interface Profile {
  schemaVersion: '1.2';

  // regular fields we edit
  name?: string | null;
  description?: string | null;
  previewPictureUrl?: string | null;

  // existing keys
  imageUrl?: string | null;
  namespaces: Record<Address, CidV0>;
  signingKeys: Record<string, unknown>;
}

export interface NamespaceIndex {
  head: CidV0 | null;
  entries: Record<string, CidV0>;
}

export interface NamespaceChunk {
  prev: CidV0 | null;
  links: CustomDataLink[]; // up to 100
}

export interface CustomDataLinkBase {
  name: string; // logical key, e.g. 'snippet-1'
  cid: CidV0; // payload CIDv0
  encrypted: boolean;
  encryptionAlgorithm: string | null;
  encryptionKeyFingerprint: string | null;
  chainId: number; // domain
  signerAddress: Address; // lowercase
  signedAt: number; // unix seconds
  nonce: `0x${string}`; // 16B
}

export interface CustomDataLink extends CustomDataLinkBase {
  signature: `0x${string}`; // 65B
}

export interface SnippetPayload {
  title: string;
  language?: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface VerifiedLink extends CustomDataLink {
  // optionally add computed fields
}
