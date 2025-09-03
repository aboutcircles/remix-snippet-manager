<script lang="ts">
  import { onMount } from 'svelte';
  import type { SnippetPayload } from '$lib/protocol/types';
  import { MockIpfs, LocalHttpIpfs } from '$lib/adapters/ipfs';
  import { MockRegistry, EthersRegistry, DEFAULT_NAMEREGISTRY_GNOSIS } from '$lib/adapters/registry';
  import { MockWallet, BrowserWallet } from '$lib/adapters/wallet';
  import { ProfileService, EMPTY_CHUNK, EMPTY_INDEX, EMPTY_PROFILE, OPERATOR_NAMESPACE } from '$lib/services/profileService';
  import CopyableCid from '$lib/components/CopyableCid.svelte';

  type Address = `0x${string}`;

  // Defaults for mock mode
  const mockAddress: Address = '0x5abfec25f74cd88437631a7731906932776356f9';
  const GNOSIS_CHAIN_ID = 100;

  // Choose wallet: BrowserWallet if available, else MockWallet
  const wallet = typeof window !== 'undefined' && window.ethereum ? new BrowserWallet() : new MockWallet(mockAddress, GNOSIS_CHAIN_ID);

  const env = {
    wallet,
    ipfs: typeof window !== 'undefined' ? new LocalHttpIpfs('http://127.0.0.1:5001') : new MockIpfs(),
    // Use real registry by default when a browser wallet exists
    registry: (() => {
      if (wallet instanceof BrowserWallet) {
        const configured = (import.meta as any).env?.VITE_REGISTRY_ADDRESS as string | undefined;
        const addr = (configured && /^0x[a-fA-F0-9]{40}$/.test(configured))
          ? configured
          : DEFAULT_NAMEREGISTRY_GNOSIS;
        return new EthersRegistry(addr);
      }
      return new MockRegistry(mockAddress);
    })()
  };

  const service = new ProfileService(env);

  let state = {
    owner: mockAddress,
    chainId: GNOSIS_CHAIN_ID,
    profile: { ...EMPTY_PROFILE },
    index: { ...EMPTY_INDEX },
    head: { ...EMPTY_CHUNK },
    namespaceKey: OPERATOR_NAMESPACE
  };

  let connected = false;
  let selectedName: string | null = null;
  let selectedPayload: SnippetPayload | null = null;
  let snippets: { name: string }[] = [];

  // Draft editing state
  let draftName: string = '';
  let connecting = false;
  let saving = false;
  let prevDirty = false;
  let prevDraftName: string | null = null;
  let draft: SnippetPayload | null = null;
  let dirty = false;
  let showMenu = false;
  let networkError: string | null = null;
  let profileLoadError: string | null = null;
  let stagedDeletes: Set<string> = new Set();
  $: canSave = dirty || stagedDeletes.size > 0;

  function shortAddr(a: string) {
    return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
  }

  async function ensureGnosisChain() {
    if (!(typeof window !== 'undefined' && window.ethereum)) return true;
    try {
      const eth = window.ethereum as any;
      const chainIdHex: string = await eth.request({ method: 'eth_chainId' });
      const current = parseInt(chainIdHex, 16);
      if (current === GNOSIS_CHAIN_ID) return true;
      try {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x64' }] });
        return true;
      } catch (e: any) {
        if (e?.code === 4001) { // user rejected
          networkError = 'User rejected network switch to Gnosis Chain (100).';
          return false;
        }
        // If chain not added, try adding
        if (e?.code === 4902) {
          try {
            await eth.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: '0x64',
                chainName: 'Gnosis Chain',
                nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
                rpcUrls: ['https://rpc.gnosischain.com'],
                blockExplorerUrls: ['https://gnosisscan.io']
              }]
            });
            // after adding, switch again
            await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x64' }] });
            return true;
          } catch (addErr: any) {
            networkError = 'Failed to add/switch to Gnosis Chain (100).';
            return false;
          }
        }
        networkError = 'Please switch your wallet to Gnosis Chain (100).';
        return false;
      }
    } catch (err) {
      networkError = 'Unable to verify network.';
      return false;
    }
  }

  async function connect() {
    networkError = null; profileLoadError = null;
    connecting = true; connected = false;

    const ok = await ensureGnosisChain();
    if (!ok) { connecting = false; return; }

    try {
      state = await service.connectLoadOrInit();
      connected = true;
      await refreshList();
      if (selectedName) await loadSelected(selectedName);
    } catch (e: any) {
      if (e?.code === 'PROFILE_FETCH_FAILED') {
        profileLoadError = `Unable to fetch existing profile from IPFS (CID ${e.cid}). You can create a new profile.`;
      } else {
        profileLoadError = 'Failed to load profile.';
      }
      // still bind to wallet and enter usable state
      try {
        const { address, chainId } = await env.wallet.connect();
        state = {
          owner: address,
          chainId,
          profile: { ...EMPTY_PROFILE },
          index: { ...EMPTY_INDEX },
          head: { ...EMPTY_CHUNK },
          namespaceKey: OPERATOR_NAMESPACE,
          profileCid: null,
          indexCid: null,
          headCid: null
        };
        connected = true;
      } catch (_) {
        connected = false;
      }
    } finally {
      connecting = false;
    }
  }

  async function refreshList() {
    const links = await service.listVerifiedLinks(state);
    // Keep items even if staged for deletion; mark them in UI
    snippets = links.map((l) => ({ name: l.name }));
    // Include unsaved draft in the list (so it appears before saving)
    if (draftName && dirty && !snippets.find(s => s.name === draftName)) {
      snippets = [...snippets, { name: draftName }];
    }
    if (snippets.length && !selectedName) {
      selectedName = snippets[0].name;
      await loadSelected(selectedName);
    } else if (selectedName) {
      await loadSelected(selectedName);
    }
  }

  async function loadSelected(name: string) {
    if (!connected) return;
    // If we have an in-memory draft for this name, prefer it (unsaved)
    if (draft && draftName === name) {
      selectedPayload = { ...draft };
      return;
    }
    selectedPayload = await service.getSnippetPayload(state, name);
    // Initialize draft from loaded payload
    if (selectedPayload) {
      draft = { ...selectedPayload };
      draftName = name;
      dirty = false;
    } else {
      draft = null;
      draftName = name;
      dirty = false;
    }
  }

  async function addSnippet() {
    const n = snippets.length + 1;
    const name = `snippet-${n}`;
    const ts = Math.floor(Date.now() / 1000);
    const payload: SnippetPayload = {
      title: `New Snippet ${n}`,
      language: 'plaintext',
      content: `Hello World ${n}`,
      createdAt: ts,
      updatedAt: ts
    };
    // Prepare draft and select (do not persist yet)
    selectedName = name;
    selectedPayload = payload;
    draft = { ...payload };
    draftName = name;
    dirty = true;
    // Ensure it appears in the list immediately
    if (!snippets.find(s => s.name === name)) snippets = [...snippets, { name }];
  }

  async function saveChanges() {
    if (!dirty && stagedDeletes.size === 0) return;
    saving = true;
    try {
      const oldName = selectedName!;

      const upserts = (dirty && draft && draftName)
        ? [{ name: draftName, payload: { ...draft, updatedAt: Math.floor(Date.now() / 1000) } }]
        : [];

      const deletes = new Set<string>(stagedDeletes);
      if (dirty && oldName && draftName && oldName !== draftName) {
        deletes.add(oldName);
      }

      state = await service.publishChanges(state, { upserts, deletes: Array.from(deletes) });

      // Reset staging
      if (draftName) selectedName = draftName;
      stagedDeletes.clear();
      dirty = false;

      await refreshList();
      if (selectedName) await loadSelected(selectedName);
    } finally {
      saving = false;
    }
  }

  function deleteSnippet(name: string) {
    if (stagedDeletes.has(name)) {
      stagedDeletes.delete(name);
    } else {
      stagedDeletes.add(name);
      if (selectedName === name) {
        selectedName = null;
        selectedPayload = null;
        draft = null;
        draftName = '';
        dirty = false;
      }
    }
    // Refresh list to reflect staged deletions
    refreshList();
  }

  function onSelect(name: string) {
    selectedName = name;
    loadSelected(name);
  }

  function onDisconnect() {
    connected = false;
    selectedName = null;
    selectedPayload = null;
    draft = null;
    draftName = '';
    dirty = false;
    profileLoadError = null;
    stagedDeletes.clear();
  }

  async function createNewProfile() {
    // ensure we have the current wallet identity even if profile fetch failed
    const { address, chainId } = await env.wallet.connect();

    state = {
      owner: address,
      chainId,
      profile: { ...EMPTY_PROFILE },
      index: { ...EMPTY_INDEX },
      head: { ...EMPTY_CHUNK },
      namespaceKey: OPERATOR_NAMESPACE,
      profileCid: null,
      indexCid: null,
      headCid: null
    };

    profileLoadError = null;
    connected = true;
    await refreshList();
  }

  function onDraftChange() {
    if (!selectedPayload || !draft) { prevDirty = dirty; dirty = false; return; }
    const same = draftName === selectedName &&
      draft.title === selectedPayload.title &&
      draft.language === selectedPayload.language &&
      draft.content === selectedPayload.content;
    const newDirty = !same;

    if (newDirty) {
      // Remove existing entries for old and new names, then ensure a single entry for draftName
      snippets = snippets.filter(s => s.name !== draftName && s.name !== selectedName);
      snippets = [...snippets, { name: draftName }];
    } else if (prevDirty) {
      // Transitioned back to clean: restore list from persisted state
      refreshList();
    }

    prevDirty = newDirty;
    prevDraftName = draftName;
    dirty = newDirty;
  }
  onMount(() => {
    const eth = (typeof window !== 'undefined' && (window as any).ethereum) ? (window as any).ethereum : null;
    if (!eth) return;
    const handleAcc = async () => { onDisconnect(); await connect(); };
    const handleChain = async () => { onDisconnect(); await connect(); };
    eth.on?.('accountsChanged', handleAcc);
    eth.on?.('chainChanged', handleChain);
    return () => {
      eth.removeListener?.('accountsChanged', handleAcc);
      eth.removeListener?.('chainChanged', handleChain);
    };
  });
</script>

<div class="min-h-screen flex flex-col">
  <header class="border-b p-4 flex items-center justify-between">
    <div class="text-lg font-semibold">Circles Snippet Manager</div>
    <div class="flex items-center gap-2">
      {#if networkError}
        <span class="text-red-600 text-sm">{networkError}</span>
      {/if}
      {#if connected}
        <div class="relative">
          <button class="flex items-center gap-2 px-3 py-2 border rounded hover:bg-gray-50" on:click={() => showMenu = !showMenu}>
            <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-200 text-gray-700 text-xs">{state.owner.slice(2,4)}</span>
            <span class="text-sm">{shortAddr(state.owner)}</span>
          </button>
          {#if showMenu}
            <div class="absolute right-0 mt-2 w-40 bg-white border rounded shadow">
              <button class="w-full text-left px-3 py-2 hover:bg-gray-100" on:click={async () => { showMenu=false; onDisconnect(); await connect(); }}>Switch account</button>
              <button class="w-full text-left px-3 py-2 hover:bg-gray-100" on:click={() => { showMenu=false; onDisconnect(); }}>Disconnect</button>
            </div>
          {/if}
        </div>
        <div class="hidden md:block"><CopyableCid cid={state.profileCid} label="Profile CID" /></div>
      {:else}
        <button class="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50" on:click={connect} disabled={connecting}>
          {connecting ? 'Connecting…' : (wallet instanceof MockWallet ? 'Connect (Mock)' : 'Connect Wallet')}
        </button>
      {/if}
    </div>
  </header>

  <main class="flex-1 grid grid-cols-1 md:grid-cols-2">
    {#if profileLoadError}
      <div class="md:col-span-2 bg-red-50 text-red-800 border-b border-red-200 px-4 py-2 text-sm flex items-center justify-between">
        <span>{profileLoadError}</span>
        <button class="ml-2 px-2 py-1 border rounded text-red-800 hover:bg-red-100" on:click={createNewProfile}>Create new profile</button>
      </div>
    {:else if connected && Object.keys(state.profile.namespaces || {}).length === 0}
      <div class="md:col-span-2 bg-yellow-50 text-yellow-800 border-b border-yellow-200 px-4 py-2 text-sm">
        No profile found in NameRegistry. A profile will be created on your first Save.
      </div>
    {/if}
    <aside class="border-r p-4 space-y-2 md:h-[calc(100vh-57px)] md:sticky md:top-[57px] overflow-auto">
      <div class="flex items-center justify-between mb-2">
        <h2 class="font-semibold">Snippets</h2>
        <button class="px-2 py-1 bg-green-600 text-white rounded" on:click={addSnippet} disabled={!connected}>Add</button>
      </div>
      <ul class="space-y-1">
        {#each snippets as s}
          <li class="flex items-center justify-between">
            <button class="text-left flex-1 px-2 py-1 rounded hover:bg-gray-100 {selectedName === s.name ? 'bg-gray-100' : ''}"
              on:click={() => onSelect(s.name)}>
              <span class="font-mono truncate block max-w-[22ch]" title={s.name}>{s.name}</span>
              {#if dirty && draftName === s.name}
                <span class="text-xs text-orange-600"> (unsaved)</span>
              {/if}
              {#if stagedDeletes.has(s.name)}
                <span class="text-xs text-red-600"> (to delete)</span>
              {/if}
            </button>
            <button class="px-2 py-1 {stagedDeletes.has(s.name) ? 'text-gray-600' : 'text-red-600'}" on:click={() => deleteSnippet(s.name)} disabled={dirty && draftName === s.name}>
              {stagedDeletes.has(s.name) ? 'Undo' : 'Delete'}
            </button>
          </li>
        {/each}
        {#if !snippets.length}
          <li class="text-gray-500">No snippets yet</li>
        {/if}
      </ul>
    </aside>

    <section class="p-4 space-y-3">
      {#if selectedName}
        <div class="border rounded-lg p-4 bg-white shadow-sm">
          <div class="flex items-center justify-between mb-2">
            <h2 class="font-semibold">Details</h2>
            <button class="px-3 py-1 rounded text-white {canSave && !saving ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-400 cursor-not-allowed'}" on:click={saveChanges} disabled={!canSave || saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
          <div class="flex flex-wrap gap-2 items-center text-xs mb-3">
            <CopyableCid cid={state.indexCid} label="Namespace Index" />
            <CopyableCid cid={state.headCid} label="Namespace Head" />
            {#if selectedName}
              {#await service.getLinkForName(state, selectedName) then res}
                <CopyableCid cid={res.link?.cid} label="Snippet CID" />
              {/await}
            {/if}
          </div>
          {#if draft}
            <div class="space-y-2">
              <label class="block text-sm">Name
                <input class="mt-1 w-full border rounded px-2 py-1" bind:value={draftName} on:input={onDraftChange} />
              </label>
              <label class="block text-sm">Title
                <input class="mt-1 w-full border rounded px-2 py-1" bind:value={draft.title} on:input={onDraftChange} />
              </label>
              <label class="block text-sm">Language
                <input class="mt-1 w-full border rounded px-2 py-1" bind:value={draft.language} on:input={onDraftChange} />
              </label>
              <label class="block text-sm">Content
                <textarea rows="10" class="mt-1 w-full border rounded px-2 py-1 font-mono" bind:value={draft.content} on:input={onDraftChange}></textarea>
              </label>
              <div class="text-sm text-gray-500">Created: {new Date(draft.createdAt * 1000).toLocaleString()}</div>
              <div class="text-sm text-gray-500">Updated: {new Date(draft.updatedAt * 1000).toLocaleString()}</div>
            </div>
          {:else}
            <p class="text-gray-600">No payload available or not loaded.</p>
          {/if}
        </div>
      {:else}
        <p class="text-gray-500">Select a snippet to view details</p>
      {/if}
    </section>
  </main>
</div>
