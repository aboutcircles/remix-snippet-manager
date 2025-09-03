/// <reference types="svelte" />
/// <reference types="vite/client" />

// EIP-1193 provider type
interface EthereumProvider {
  request(args: { method: string; params?: any[] | object }): Promise<any>;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export {};