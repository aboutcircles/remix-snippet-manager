import type { Address } from '../protocol/types';
import { ensureLowerAddress } from '../protocol/utils';

export interface WalletAdapter {
  connect(): Promise<{ address: Address; chainId: number }>;
  signRawHash(address: Address, hashHex32: `0x${string}`): Promise<`0x${string}`>; // returns 65B r||s||v
}

export class MockWallet implements WalletAdapter {
  constructor(private readonly address: Address, private readonly chainId: number) {}

  async connect(): Promise<{ address: Address; chainId: number }> {
    return { address: this.address, chainId: this.chainId };
  }

  async signRawHash(_address: Address, hashHex32: `0x${string}`): Promise<`0x${string}`> {
    // Not cryptographically correct. Produce deterministic fake signature 65 bytes.
    const bytes = new Uint8Array(65);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(hashHex32.slice(2 + (i * 2)) || '00', 16) ^ 0xab;
    for (let i = 32; i < 64; i++) bytes[i] = (bytes[i - 32] ^ 0xcd) & 0xff;
    bytes[64] = 27; // v
    return ('0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
  }
}

export class BrowserWallet implements WalletAdapter {
  async connect(): Promise<{ address: Address; chainId: number }> {
    const eth = window.ethereum;
    if (!eth) throw new Error('No EIP-1193 provider found');
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    const address = ensureLowerAddress(accounts[0]);
    const chainIdHex: string = await eth.request({ method: 'eth_chainId' });
    const chainId = parseInt(chainIdHex, 16);
    return { address, chainId };
  }

  async signRawHash(address: Address, hashHex32: `0x${string}`): Promise<`0x${string}`> {
    // Use EIP-712 typed data signing to avoid eth_sign (blocked by Rabby and considered unsafe)
    const eth = window.ethereum;
    if (!eth) throw new Error('No EIP-1193 provider');

    const chainIdHex: string = await eth.request({ method: 'eth_chainId' });
    const chainId = parseInt(chainIdHex, 16);

    const typedData = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' }
        ],
        LinkHashMessage: [
          { name: 'linkHash', type: 'bytes32' }
        ]
      },
      primaryType: 'LinkHashMessage',
      domain: {
        name: 'CirclesProfiles',
        version: '1',
        chainId
      },
      message: {
        linkHash: hashHex32
      }
    } as const;

    const sig = await eth.request({
      method: 'eth_signTypedData_v4',
      params: [address, JSON.stringify(typedData)]
    });
    return sig as `0x${string}`;
  }
}
