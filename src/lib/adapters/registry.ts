import type { Address } from '../protocol/types';

export const DEFAULT_NAMEREGISTRY_GNOSIS = '0xA27566fD89162cC3D40Cb59c87AAaA49B85F3474';

export interface RegistryClient {
  getMetadataDigest(avatar: Address): Promise<string>; // bytes32 hex 0x...
  updateMetadataDigest(digest32: string): Promise<void>; // mock or real tx
}

export class MockRegistry implements RegistryClient {
  private digestByAvatar = new Map<Address, string>();
  private current?: Address;

  constructor(private readonly avatar: Address) {
    this.current = avatar;
  }

  async getMetadataDigest(avatar: Address): Promise<string> {
    return this.digestByAvatar.get(avatar) ?? '0x' + '00'.repeat(32);
  }

  async updateMetadataDigest(digest32: string): Promise<void> {
    if (!this.current) throw new Error('No avatar bound in mock registry');
    this.digestByAvatar.set(this.current, digest32);
  }
}

// Real on-chain registry adapter via ethers v6
import { BrowserProvider, Contract } from 'ethers';

const REGISTRY_ABI = [
  { type: 'function', name: 'updateMetadataDigest', inputs: [{ type: 'bytes32', name: '_metadataDigest' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'getMetadataDigest', inputs: [{ type: 'address', name: '_avatar' }], outputs: [{ type: 'bytes32' }], stateMutability: 'view' }
] as const;

export class EthersRegistry implements RegistryClient {
  private readonly address: string;
  private readonly provider: BrowserProvider;
  constructor(registryAddress: string, provider?: BrowserProvider) {
    this.address = registryAddress;
    this.provider = provider ?? (typeof window !== 'undefined' ? new BrowserProvider((window as any).ethereum) : undefined as any);
    if (!this.provider) throw new Error('No browser provider for ethers');
  }

  private async getReadContract() {
    return new Contract(this.address, REGISTRY_ABI, this.provider);
  }

  private async getWriteContract() {
    const signer = await this.provider.getSigner();
    return new Contract(this.address, REGISTRY_ABI, signer);
  }

  async getMetadataDigest(avatar: Address): Promise<string> {
    const c = await this.getReadContract();
    const r = await c.getMetadataDigest(avatar);
    return r as string;
  }

  async updateMetadataDigest(digest32: string): Promise<void> {
    const network = await this.provider.getNetwork();
    const chain = Number(network.chainId);
    if (chain !== 100) throw new Error(`Wrong network: expected Gnosis (100), got ${chain}`);
    const c = await this.getWriteContract();
    const tx = await c.updateMetadataDigest(digest32);
    const rc = await tx.wait(1);
    if (!rc || rc.status !== 1) throw new Error('Registry tx failed');
  }
}
