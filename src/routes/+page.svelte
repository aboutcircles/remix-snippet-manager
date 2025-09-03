<script lang="ts">
  import {onMount} from 'svelte';
  import type {SnippetPayload} from '$lib/protocol/types';
  import {MockIpfs, LocalHttpIpfs} from '$lib/adapters/ipfs';
  import {MockRegistry, EthersRegistry, DEFAULT_NAMEREGISTRY_GNOSIS} from '$lib/adapters/registry';
  import {MockWallet, BrowserWallet} from '$lib/adapters/wallet';
  import {
    ProfileService,
    EMPTY_CHUNK,
    EMPTY_INDEX,
    EMPTY_PROFILE,
    OPERATOR_NAMESPACE
  } from '$lib/services/profileService';
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
    profile: {...EMPTY_PROFILE},
    index: {...EMPTY_INDEX},
    head: {...EMPTY_CHUNK},
    namespaceKey: OPERATOR_NAMESPACE
  };

  let connected = false;
  // Staging model
  type Draft = { originalName: string; name: string; payload: SnippetPayload };
  let drafts = new Map<string, Draft>(); // key = originalName (committed key or temp key)
  let stagedDeletes: Set<string> = new Set();
  // Selection is by key (originalName or temp key)
  let selectedKey: string | null = null;
  let selectedPayload: SnippetPayload | null = null;

  // Derived state
  let committedNames: string[] = [];

  function hasNameCollision(name: string, exceptKey?: string): boolean {
    if (committedNames.includes(name) && name !== exceptKey) return true;
    let count = 0;
    for (const [k, d] of drafts) if (d.name === name && k !== exceptKey) {
      count++;
      if (count >= 1) return true;
    }
    return false;
  }

  $: hasCollisionOrEmpty = (() => {
    for (const [k, d] of drafts) {
      const name = d.name.trim();
      if (!name || hasNameCollision(name, k)) return true;
    }
    return false;
  })();
  $: canSave = (drafts.size > 0 || stagedDeletes.size > 0) && !hasCollisionOrEmpty;
  $: snippetList = (() => {
    const names = new Set<string>();
    // 1) Start with committed names
    for (const n of committedNames) names.add(n);
    // 2) Remove staged deletions
    for (const n of stagedDeletes) names.delete(n);
    // 3) Apply drafts: remove original if renamed, add draft name
    for (const [, d] of drafts) {
      if (d.name !== d.originalName) names.delete(d.originalName);
      names.add(d.name);
    }
    return Array.from(names).sort();
  })();
  $: stagedNameSet = new Set(Array.from(drafts.values()).map(d => d.name));
  $: selectedVisibleName = selectedKey ? (drafts.get(selectedKey)?.name ?? selectedKey) : null;

  // UI flags
  let connecting = false;
  let saving = false;
  let showMenu = false;
  let networkError: string | null = null;
  let profileLoadError: string | null = null;

  function shortAddr(a: string) {
    return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
  }

  async function ensureGnosisChain() {
    if (!(typeof window !== 'undefined' && window.ethereum)) return true;
    try {
      const eth = window.ethereum as any;
      const chainIdHex: string = await eth.request({method: 'eth_chainId'});
      const current = parseInt(chainIdHex, 16);
      if (current === GNOSIS_CHAIN_ID) return true;
      try {
        await eth.request({method: 'wallet_switchEthereumChain', params: [{chainId: '0x64'}]});
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
                nativeCurrency: {name: 'xDAI', symbol: 'xDAI', decimals: 18},
                rpcUrls: ['https://rpc.gnosischain.com'],
                blockExplorerUrls: ['https://gnosisscan.io']
              }]
            });
            // after adding, switch again
            await eth.request({method: 'wallet_switchEthereumChain', params: [{chainId: '0x64'}]});
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
    networkError = null;
    profileLoadError = null;
    connecting = true;
    connected = false;

    const ok = await ensureGnosisChain();
    if (!ok) {
      connecting = false;
      return;
    }

    try {
      state = await service.connectLoadOrInit();
      connected = true;
      await refreshList();
      if (selectedKey) await loadSelectedByKey(selectedKey);
    } catch (e: any) {
      if (e?.code === 'PROFILE_FETCH_FAILED') {
        profileLoadError = `Unable to fetch existing profile from IPFS (CID ${e.cid}). You can create a new profile.`;
      } else {
        profileLoadError = 'Failed to load profile.';
      }
      // still bind to wallet and enter usable state
      try {
        const {address, chainId} = await env.wallet.connect();
        state = {
          owner: address,
          chainId,
          profile: {...EMPTY_PROFILE},
          index: {...EMPTY_INDEX},
          head: {...EMPTY_CHUNK},
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
    committedNames = links.map((l) => l.name);

    const hasSelection = !!selectedKey && (drafts.has(selectedKey) || committedNames.includes(selectedKey));

    if (!selectedKey && snippetList.length) {
      selectedKey = findKeyByVisibleName(snippetList[0]);
      await loadSelectedByKey(selectedKey!);
    } else if (hasSelection) {
      await loadSelectedByKey(selectedKey!);
    } else {
      selectedKey = null;
      selectedPayload = null;
    }
  }

  function findKeyByVisibleName(name: string): string {
    for (const [k, d] of drafts) if (d.name === name) return k;
    return name; // committed name
  }

  function onSelect(visibleName: string) {
    selectedKey = findKeyByVisibleName(visibleName);
    loadSelectedByKey(selectedKey!);
  }

  async function loadSelectedByKey(key: string) {
    if (!connected) return;
    const d = drafts.get(key);
    if (d) {
      selectedPayload = {...d.payload};
      return;
    }
    const payload = await service.getSnippetPayload(state, key);
    selectedPayload = payload ?? null;
  }

  async function loadSelected(name: string) {
    if (!connected) return;
    selectedKey = findKeyByVisibleName(name);
    await loadSelectedByKey(selectedKey);
  }

  async function addSnippet() {
    const n = drafts.size + committedNames.length + 1;
    const tempKey = `__new_${Date.now()}_${n}`;
    const ts = Math.floor(Date.now() / 1000);
    const payload: SnippetPayload = {
      title: `New Snippet ${n}`,
      language: 'plaintext',
      content: `Hello World ${n}`,
      createdAt: ts,
      updatedAt: ts
    };
    setDraft(tempKey, {originalName: tempKey, name: `snippet-${n}`, payload});
    selectedKey = tempKey;
    selectedPayload = payload;
  }


  async function ensureDraftForCommitName(commitName: string) {
    if (drafts.has(commitName)) return;

    let base = (selectedKey === commitName) ? selectedPayload : null;
    if (!base) {
      base = await service.getSnippetPayload(state, commitName);
      if (!base) return;
    }
    setDraft(commitName, {
      originalName: commitName,
      name: commitName,
      payload: {...base}
    });
  }

  async function onNameChange(newName: string) {
    if (!selectedKey) return;
    const name = newName.trim();
    if (!name || hasNameCollision(name, selectedKey)) return;

    if (!drafts.has(selectedKey) && committedNames.includes(selectedKey))
      await ensureDraftForCommitName(selectedKey);

    const d = drafts.get(selectedKey) ?? {
      originalName: selectedKey,
      name: selectedKey,
      payload: selectedPayload!
    };
    d.name = name;
    setDraft(selectedKey, d);
  }

  async function onPayloadChange(patch: Partial<SnippetPayload>) {
    if (!selectedKey) return;
    if (!drafts.has(selectedKey) && committedNames.includes(selectedKey))
      await ensureDraftForCommitName(selectedKey);

    const now = Math.floor(Date.now() / 1000);
    const d = drafts.get(selectedKey) ?? {
      originalName: selectedKey,
      name: selectedKey,
      payload: selectedPayload!
    };
    d.payload = {...d.payload, ...patch, updatedAt: now};
    setDraft(selectedKey, d);
  }


  function getInputValue(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  function getTextAreaValue(e: Event): string {
    return (e.target as HTMLTextAreaElement).value;
  }

  async function handleNameInput(e: Event) {
    await onNameChange(getInputValue(e));
  }

  async function handleTitleInput(e: Event) {
    await onPayloadChange({title: getInputValue(e)});
  }

  async function handleLanguageInput(e: Event) {
    await onPayloadChange({language: getInputValue(e)});
  }

  async function handleContentInput(e: Event) {
    await onPayloadChange({content: getTextAreaValue(e)});
  }

  async function saveAll() {
    if (drafts.size === 0 && stagedDeletes.size === 0) return;
    saving = true;
    try {
      const upserts = Array.from(drafts.values()).map(d => ({name: d.name, payload: d.payload}));
      const renameDeletes = Array.from(drafts.values())
        .filter(d => d.originalName !== d.name && committedNames.includes(d.originalName))
        .map(d => d.originalName);
      const deletes = Array.from(new Set([...stagedDeletes, ...renameDeletes]));
      const nextSelectName = upserts.length === 1 ? upserts[0].name : null;

      state = await service.publishChanges(state, {upserts, deletes});

      clearDrafts();
      clearDeletes();

      await refreshList();

      if (nextSelectName) {
        const key = findKeyByVisibleName(nextSelectName);
        if (key) {
          selectedKey = key;
          await loadSelectedByKey(key);
        } else {
          selectedKey = null;
          selectedPayload = null;
        }
      } else {
        selectedKey = null;
        selectedPayload = null;
      }
    } finally {
      saving = false;
    }
  }

  function deleteSnippet(visibleName: string) {
    const key = findKeyByVisibleName(visibleName);
    const isCommitted = committedNames.includes(key);

    deleteDraft(key);              // remove staged version (if any)
    if (isCommitted) {
      if (stagedDeletes.has(key)) removeDelete(key);
      else addDelete(key);
    }

    if (selectedKey === key || selectedVisibleName === visibleName) {
      selectedKey = null;
      selectedPayload = null;
    }
  }


  function onDisconnect() {
    connected = false;
    selectedKey = null;
    selectedPayload = null;
    clearDrafts();
    clearDeletes();
    profileLoadError = null;
  }

  async function createNewProfile() {
    const {address, chainId} = await env.wallet.connect();
    state = {
      owner: address,
      chainId,
      profile: {...EMPTY_PROFILE},
      index: {...EMPTY_INDEX},
      head: {...EMPTY_CHUNK},
      namespaceKey: OPERATOR_NAMESPACE,
      profileCid: null, indexCid: null, headCid: null
    };
    profileLoadError = null;
    connected = true;
    clearDrafts();
    clearDeletes();
    await refreshList();
  }

  function setDraft(key: string, draft: Draft) {
    const next = new Map(drafts);
    next.set(key, draft);
    drafts = next; // <— REASSIGN to trigger reactivity
  }

  function deleteDraft(key: string) {
    if (!drafts.has(key)) return;
    const next = new Map(drafts);
    next.delete(key);
    drafts = next;
  }

  function clearDrafts() {
    drafts = new Map();
  }

  function addDelete(key: string) {
    const next = new Set(stagedDeletes);
    next.add(key);
    stagedDeletes = next; // <— REASSIGN
  }

  function removeDelete(key: string) {
    if (!stagedDeletes.has(key)) return;
    const next = new Set(stagedDeletes);
    next.delete(key);
    stagedDeletes = next;
  }

  function clearDeletes() {
    stagedDeletes = new Set();
  }

  onMount(() => {
    const eth = (typeof window !== 'undefined' && (window as any).ethereum) ? (window as any).ethereum : null;
    if (!eth) return;
    const handleAcc = async () => {
      onDisconnect();
      await connect();
    };
    const handleChain = async () => {
      onDisconnect();
      await connect();
    };
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
          <button class="flex items-center gap-2 px-3 py-2 border rounded hover:bg-gray-50"
                  on:click={() => showMenu = !showMenu}>
            <span
                class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-200 text-gray-700 text-xs">{state.owner.slice(2, 4)}</span>
            <span class="text-sm">{shortAddr(state.owner)}</span>
          </button>
          {#if showMenu}
            <div class="absolute right-0 mt-2 w-40 bg-white border rounded shadow">
              <button class="w-full text-left px-3 py-2 hover:bg-gray-100"
                      on:click={async () => { showMenu=false; onDisconnect(); await connect(); }}>Switch account
              </button>
              <button class="w-full text-left px-3 py-2 hover:bg-gray-100"
                      on:click={() => { showMenu=false; onDisconnect(); }}>Disconnect
              </button>
            </div>
          {/if}
        </div>
        <div class="hidden md:block">
          <CopyableCid cid={state.profileCid} label="Profile CID"/>
        </div>
      {:else}
        <button class="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50" on:click={connect}
                disabled={connecting}>
          {connecting ? 'Connecting…' : (wallet instanceof MockWallet ? 'Connect (Mock)' : 'Connect Wallet')}
        </button>
      {/if}
    </div>
  </header>

  <main class="flex-1 grid grid-cols-1 md:grid-cols-2">
    {#if profileLoadError}
      <div
          class="md:col-span-2 bg-red-50 text-red-800 border-b border-red-200 px-4 py-2 text-sm flex items-center justify-between">
        <span>{profileLoadError}</span>
        <button class="ml-2 px-2 py-1 border rounded text-red-800 hover:bg-red-100" on:click={createNewProfile}>Create
          new profile
        </button>
      </div>
    {:else if connected && Object.keys(state.profile.namespaces || {}).length === 0}
      <div class="md:col-span-2 bg-yellow-50 text-yellow-800 border-b border-yellow-200 px-4 py-2 text-sm">
        No profile found in NameRegistry. A profile will be created on your first Save.
      </div>
    {/if}
    <aside class="border-r p-4 space-y-2 md:h-[calc(100vh-57px)] md:sticky md:top-[57px] overflow-auto">
      <div class="flex items-center justify-between mb-2">
        <h2 class="font-semibold">Snippets</h2>
        <button class="px-2 py-1 bg-green-600 text-white rounded" on:click={addSnippet} disabled={!connected}>Add
        </button>
      </div>
      <ul class="space-y-1">
        {#each snippetList as name}
          <li class="flex items-center justify-between">
            <button
                class="text-left flex-1 px-2 py-1 rounded hover:bg-gray-100 {selectedVisibleName === name ? 'bg-gray-100' : ''}"
                on:click={() => onSelect(name)}>
              <span class="font-mono truncate block max-w-[22ch]" title={name}>{name}</span>
              {#if stagedNameSet.has(name)}
                <span class="text-xs text-orange-600"> (staged)</span>
              {/if}
              {#if stagedDeletes.has(name)}
                <span class="text-xs text-red-600"> (to delete)</span>
              {/if}
            </button>
            <button class="px-2 py-1 {stagedDeletes.has(name) ? 'text-gray-600' : 'text-red-600'}"
                    on:click={() => deleteSnippet(name)}>
              {stagedDeletes.has(name) ? 'Undo' : 'Delete'}
            </button>
          </li>
        {/each}
        {#if !snippetList.length}
          <li class="text-gray-500">No snippets yet</li>
        {/if}
      </ul>
    </aside>

    <section class="p-4 space-y-3">
      {#if selectedKey}
        <div class="border rounded-lg p-4 bg-white shadow-sm">
          <div class="flex items-center justify-between mb-2">
            <h2 class="font-semibold">Details</h2>
            <button
                class="px-3 py-1 rounded text-white {canSave && !saving ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-400 cursor-not-allowed'}"
                on:click={saveAll} disabled={!canSave || saving}>{saving ? 'Saving…' : 'Save All'}</button>
          </div>
          <div class="flex flex-wrap gap-2 items-center text-xs mb-3">
            <CopyableCid cid={state.indexCid} label="Namespace Index"/>
            <CopyableCid cid={state.headCid} label="Namespace Head"/>
            {#if selectedKey}
              {#if drafts.has(selectedKey)}
                <CopyableCid cid={null} label="Snippet CID"/>
              {:else}
                {#await service.getLinkForName(state, selectedKey) then res}
                  <CopyableCid cid={res.link?.cid} label="Snippet CID"/>
                {/await}
              {/if}
            {/if}
          </div>
          <div class="space-y-2">
            <label class="block text-sm">Name
              <input class="mt-1 w-full border rounded px-2 py-1"
                     value={drafts.get(selectedKey || '')?.name ?? selectedKey ?? ''}
                     on:input={handleNameInput}/>
            </label>
            <label class="block text-sm">Title
              <input class="mt-1 w-full border rounded px-2 py-1"
                     value={drafts.get(selectedKey || '')?.payload.title ?? selectedPayload?.title ?? ''}
                     on:input={handleTitleInput}/>
            </label>
            <label class="block text-sm">Language
              <input class="mt-1 w-full border rounded px-2 py-1"
                     value={drafts.get(selectedKey || '')?.payload.language ?? selectedPayload?.language ?? ''}
                     on:input={handleLanguageInput}/>
            </label>
            <label class="block text-sm">Content
              <textarea rows="10" class="mt-1 w-full border rounded px-2 py-1 font-mono"
                        value={drafts.get(selectedKey || '')?.payload.content ?? selectedPayload?.content ?? ''}
                        on:input={handleContentInput}></textarea>
            </label>
            {#if (drafts.get(selectedKey || '')?.payload ?? selectedPayload)?.createdAt}
              <div class="text-sm text-gray-500">
                Created: {new Date(((drafts.get(selectedKey || '')?.payload ?? selectedPayload)?.createdAt || 0) * 1000).toLocaleString()}</div>
              <div class="text-sm text-gray-500">
                Updated: {new Date(((drafts.get(selectedKey || '')?.payload ?? selectedPayload)?.updatedAt || 0) * 1000).toLocaleString()}</div>
            {/if}
          </div>
        </div>
      {:else}
        <p class="text-gray-500">Select a snippet to view details</p>
      {/if}
    </section>
  </main>
</div>
