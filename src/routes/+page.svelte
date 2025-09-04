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
  import * as SN from '$lib/stores/snippets';

  type Address = `0x${string}`;

  // Defaults for mock mode
  const mockAddress: Address = '0x5abfec25f74cd88437631a7731906932776356f9';
  const GNOSIS_CHAIN_ID = 100;
    const CHAIN_ID_HEX = '0x64';

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
  // New snippet store-based state
  let items: SN.SnippetState = SN.emptyState();
  let selectedKey: SN.Key | null = null;
  let selectedPayload: SnippetPayload | null = null;
  let selectedLinkCid: string | null = null;

  // Derived state via selectors
  $: selected = selectedKey ? (items.get(selectedKey) ?? null) : null;
  $: entries = SN.visibleEntries(items); // [{key,name,staged,deleted}]
  $: (() => { const { upserts, deletes } = SN.buildPublish(items); publishPreview = { upserts, deletes }; })();
  let publishPreview: { upserts: { name: string; payload: SnippetPayload }[]; deletes: string[] } = { upserts: [], deletes: [] };
  $: canSave = !SN.hasNameIssues(items) && (publishPreview.upserts.length > 0 || publishPreview.deletes.length > 0);
  $: selectedVisibleName = selectedKey && items.get(selectedKey) ? SN.visibleName(items.get(selectedKey)!) : null;
  // Derived profile/namespace presence flags
  $: hasRegistryProfile = !!state.profileCid;
  $: hasOperatorNamespace = !!(state.profile?.namespaces?.[state.namespaceKey]);

  // UI flags
  let connecting = false;
  let saving = false;
  let showMenu = false;
  let networkError: string | null = null;
  let profileLoadError: string | null = null;

  // ---- Profile editor draft ----
  let profileSaving = false;
  let profileErr: string | null = null;
  type ProfileDraft = { name: string; description: string; previewPictureUrl: string };
  $: profileDraft = {
    name: (state.profile.name ?? '').toString(),
    description: (state.profile.description ?? '').toString(),
    previewPictureUrl: (state.profile.previewPictureUrl ?? '').toString()
  } as ProfileDraft;
  // Prefer showing the draft preview in the header if present, otherwise saved preview/imageUrl
  $: headerAvatarUrl = (profileDraft?.previewPictureUrl && profileDraft.previewPictureUrl.length > 0)
    ? profileDraft.previewPictureUrl
    : (state.profile.previewPictureUrl || state.profile.imageUrl || null);

  async function fileToPreviewDataUrl(file: File): Promise<string> {
    if (!/^image\/(png|jpe?g|gif)$/i.test(file.type)) throw new Error('Unsupported image type');
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await new Promise((res, rej) => { img.onload = () => { res(null); URL.revokeObjectURL(img.src); }; img.onerror = rej; });

    const size = 256;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    canvas.width = size; canvas.height = size;

    const r = Math.max(size / img.width, size / img.height);
    const w = img.width * r, h = img.height * r;
    const dx = (size - w) / 2, dy = (size - h) / 2;
    ctx.drawImage(img, dx, dy, w, h);

    let q = 0.85;
    let data = canvas.toDataURL('image/jpeg', q);
    for (let i = 0; i < 6 && data.length > 150 * 1024; i++) {
      q = Math.max(0.4, q - 0.1);
      data = canvas.toDataURL('image/jpeg', q);
    }
    return data;
  }

  async function onPreviewFileChange(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      profileDraft.previewPictureUrl = await fileToPreviewDataUrl(f);
    } catch (_) {
      profileErr = 'Preview must be PNG/JPEG/GIF, 256×256, ≤150KB.';
    }
  }

  async function saveProfile() {
    profileErr = null;
    profileSaving = true;
    try {
      const patch: any = {};
      if ((state.profile.name ?? '') !== profileDraft.name) patch.name = profileDraft.name;
      if ((state.profile.description ?? '') !== profileDraft.description) patch.description = profileDraft.description;
      if ((state.profile.previewPictureUrl ?? '') !== profileDraft.previewPictureUrl) patch.previewPictureUrl = profileDraft.previewPictureUrl;

      if (!('name' in patch) && !('description' in patch) && !('previewPictureUrl' in patch)) return;

      state = await service.updateProfileMetadata(state, patch);
    } catch (e: any) {
      profileErr = String(e?.message || e);
    } finally {
      profileSaving = false;
    }
  }

  function handleProfileNameInput(e: Event) {
    profileDraft.name = (e.target as HTMLInputElement).value;
  }
  function handleProfileDescInput(e: Event) {
    profileDraft.description = (e.target as HTMLTextAreaElement).value;
  }

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
        await eth.request({method: 'wallet_switchEthereumChain', params: [{chainId: CHAIN_ID_HEX}]});
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
                chainId: CHAIN_ID_HEX,
                chainName: 'Gnosis Chain',
                nativeCurrency: {name: 'xDAI', symbol: 'xDAI', decimals: 18},
                rpcUrls: ['https://rpc.gnosischain.com'],
                blockExplorerUrls: ['https://gnosisscan.io']
              }]
            });
            // after adding, switch again
            await eth.request({method: 'wallet_switchEthereumChain', params: [{chainId: CHAIN_ID_HEX}]});
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
    const names = links.map((l) => l.name);

    // Ensure models exist for each committed name (without payload for now)
    for (const n of names) items = SN.ensure(items, n);

    // Mark disappeared committed entries as committed=null if they have no draft
    for (const [k, m] of items) {
      if (!names.includes(k) && !m.draft && m.committed) {
        items = SN.setCommitted(items, k, null);
      }
    }

    const hasSelection = !!selectedKey && items.has(selectedKey);
    if (!hasSelection && entries.length) {
      selectedKey = entries[0].key;
      await loadSelectedByKey(selectedKey!);
    } else if (hasSelection) {
      await loadSelectedByKey(selectedKey!);
    } else {
      selectedKey = null;
      selectedPayload = null;
      selectedLinkCid = null;
    }
  }

  function onSelectKey(key: string) {
    selectedKey = key;
    loadSelectedByKey(key);
  }

  async function loadSelectedByKey(key: string) {
    if (!connected) return;
    const m = items.get(key);
    if (!m) return;

    const pay = m.draft?.payload ?? m.committed?.payload ?? null;
    selectedPayload = pay ? { ...pay } : null;

    if (!selectedPayload) {
      const payload = await service.getSnippetPayload(state, key);
      if (payload) {
        items = SN.setCommitted(items, key, { name: key, payload });
        selectedPayload = { ...payload };
      }
    }
    const { link } = await service.getLinkForName(state, key);
    selectedLinkCid = link?.cid ?? null;
  }

  async function loadSelected(name: string) {
    if (!connected) return;
    // try to locate entry by visible name
    const entry = entries.find(e => e.name === name);
    if (entry) {
      selectedKey = entry.key;
      await loadSelectedByKey(selectedKey);
    }
  }

  async function addSnippet() {
    const tempKey = `__new_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const ts = Math.floor(Date.now() / 1000);
    const name = SN.makeUniqueName(items, 'snippet');
    const draft = {
      name,
      payload: { title: 'New Snippet', language: 'plaintext', content: 'Hello World', createdAt: ts, updatedAt: ts }
    };
    items = SN.addNew(items, tempKey, draft);
    selectedKey = tempKey;
    selectedPayload = draft.payload;
  }


  async function ensureDraftForCommitName(commitName: string) {
    const m = items.get(commitName);
    if (m?.draft) return;
    let base = (selectedKey === commitName) ? selectedPayload : null;
    if (!base) {
      base = await service.getSnippetPayload(state, commitName);
      if (!base) return;
    }
    // seed committed first so patch/setName can derive from it lazily
    items = SN.setCommitted(items, commitName, { name: commitName, payload: { ...base } });
  }

  async function onNameChange(newName: string) {
    if (!selectedKey) return;
    const name = newName.trim();
    if (!name) return;
    await ensureDraftForCommitName(selectedKey);
    items = SN.setName(items, selectedKey, name);
  }

  async function onPayloadChange(patch: Partial<SnippetPayload>) {
    if (!selectedKey) return;
    await ensureDraftForCommitName(selectedKey);
    items = SN.patchPayload(items, selectedKey, patch);
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
    const { upserts, deletes } = SN.buildPublish(items);
    if (upserts.length === 0 && deletes.length === 0) return;
    saving = true;
    try {
      const nextSelectName = upserts.length === 1 ? upserts[0].name : null;

      state = await service.publishChanges(state, { upserts, deletes });

      // Reconcile: commit drafts and clear deletes immutably
      let next = new Map<string, SN.SnippetModel>();
      for (const [k, m] of items) {
        if (m.deleted && m.committed) continue; // dropped
        if (m.draft) {
          const newKey = m.draft.name;
          next.set(newKey, { key: newKey, committed: { ...m.draft }, draft: null, deleted: false });
        } else if (m.committed) {
          next.set(m.committed.name, { key: m.committed.name, committed: { ...m.committed }, draft: null, deleted: false });
        }
      }
      items = next;

      await refreshList();

      if (nextSelectName) {
        for (const [k, m] of items) if (SN.visibleName(m) === nextSelectName) { selectedKey = k; break; }
        if (selectedKey) await loadSelectedByKey(selectedKey);
        else { selectedKey = null; selectedPayload = null; selectedLinkCid = null; }
      } else {
        selectedKey = null; selectedPayload = null; selectedLinkCid = null;
      }
    } finally {
      saving = false;
    }
  }

  function deleteSnippetKey(key: string) {
    items = SN.toggleDelete(items, key);
    if (selectedKey === key) {
      selectedKey = null;
      selectedPayload = null;
      selectedLinkCid = null;
    }
  }


  function onDisconnect() {
    connected = false;
    selectedKey = null;
    selectedPayload = null;
    selectedLinkCid = null;
    items = SN.emptyState();
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
    items = SN.emptyState();
    await refreshList();
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
            {#if headerAvatarUrl}
              <img src={headerAvatarUrl} alt="avatar" class="w-6 h-6 rounded-full object-cover border" />
            {:else}
              <span
                class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-200 text-gray-700 text-xs">{state.owner.slice(2, 4)}</span>
            {/if}
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

    {:else if connected && !hasRegistryProfile}
      <!-- No digest registered yet: user has not written/registered a profile -->
      <div class="md:col-span-2 bg-yellow-50 text-yellow-800 border-b border-yellow-200 px-4 py-2 text-sm">
        No profile is registered in NameRegistry yet. Click <em>Save Profile</em> to create and register it.
      </div>

    {:else if connected && hasRegistryProfile && !hasOperatorNamespace}
      <!-- Profile exists, but snippets namespace has not been created yet -->
      <div class="md:col-span-2 bg-blue-50 text-blue-800 border-b border-blue-200 px-4 py-2 text-sm">
        No snippets namespace yet. It will be created on your first snippet save.
      </div>
    {/if}

    <!-- Profile card -->
    <section class="p-4 md:col-span-2">
      <div class="border rounded-lg p-4 bg-white shadow-sm space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="font-semibold">Profile</h2>
          <button class="px-3 py-1 rounded text-white {profileSaving ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'}"
                  on:click={saveProfile} disabled={profileSaving}>
            {profileSaving ? 'Saving…' : 'Save Profile'}
          </button>
        </div>
        {#if profileErr}<div class="text-sm text-red-600">{profileErr}</div>{/if}

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label class="block text-sm">Name (required)
            <input class="mt-1 w-full border rounded px-2 py-1"
                   value={profileDraft.name}
                   on:input={handleProfileNameInput} />
          </label>

          <label class="block text-sm">Preview picture (256×256, ≤150KB)
            <input type="file" accept="image/png,image/jpeg,image/gif"
                   class="mt-1 block" on:change={onPreviewFileChange} />
            {#if profileDraft.previewPictureUrl}
              <img src={profileDraft.previewPictureUrl} alt="preview" class="mt-2 w-16 h-16 rounded border" />
            {/if}
          </label>

          <label class="block text-sm md:col-span-2">Description
            <textarea rows="3" class="mt-1 w-full border rounded px-2 py-1"
                      on:input={handleProfileDescInput}>{profileDraft.description}</textarea>
          </label>
        </div>
      </div>
    </section>

    <aside class="border-r p-4 space-y-2 md:h-[calc(100vh-57px)] md:sticky md:top-[57px] overflow-auto">
      <div class="flex items-center justify-between mb-2">
        <h2 class="font-semibold">Snippets</h2>
        <button class="px-2 py-1 bg-green-600 text-white rounded" on:click={addSnippet} disabled={!connected}>Add
        </button>
      </div>
      <ul class="space-y-1">
        {#each entries as e (e.key)}
          <li class="flex items-center justify-between">
            <button
                class="text-left flex-1 px-2 py-1 rounded hover:bg-gray-100 {selectedKey === e.key ? 'bg-gray-100' : ''}"
                on:click={() => onSelectKey(e.key)}>
              <span class="font-mono truncate block max-w-[22ch]" title={e.name}>{e.name}</span>
              {#if e.staged}
                <span class="text-xs text-orange-600"> (staged)</span>
              {/if}
              {#if e.deleted}
                <span class="text-xs text-red-600"> (to delete)</span>
              {/if}
            </button>
            <button class="px-2 py-1 {e.deleted ? 'text-gray-600' : 'text-red-600'}"
                    on:click={() => deleteSnippetKey(e.key)}>
              {e.deleted ? 'Undo' : 'Delete'}
            </button>
          </li>
        {/each}
        {#if !entries.length}
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
            <CopyableCid cid={selectedKey && items.get(selectedKey)?.draft ? null : selectedLinkCid} label="Snippet CID" />
          </div>
          <div class="space-y-2">
            <label class="block text-sm">Name
              <input class="mt-1 w-full border rounded px-2 py-1"
                     value={(items.get(selectedKey || '')?.draft?.name) ?? (selectedKey ?? '')}
                     on:input={handleNameInput}/>
            </label>
            <label class="block text-sm">Title
              <input class="mt-1 w-full border rounded px-2 py-1"
                     value={(items.get(selectedKey || '')?.draft?.payload.title) ?? selectedPayload?.title ?? ''}
                     on:input={handleTitleInput}/>
            </label>
            <label class="block text-sm">Language
              <input class="mt-1 w-full border rounded px-2 py-1"
                     value={(items.get(selectedKey || '')?.draft?.payload.language) ?? selectedPayload?.language ?? ''}
                     on:input={handleLanguageInput}/>
            </label>
            <label class="block text-sm">Content
              <textarea rows="10" class="mt-1 w-full border rounded px-2 py-1 font-mono"
                        value={(items.get(selectedKey || '')?.draft?.payload.content) ?? selectedPayload?.content ?? ''}
                        on:input={handleContentInput}></textarea>
            </label>
            {#if (items.get(selectedKey || '')?.draft?.payload ?? selectedPayload)?.createdAt}
              <div class="text-sm text-gray-500">
                Created: {new Date((((items.get(selectedKey || '')?.draft?.payload ?? selectedPayload)?.createdAt || 0) * 1000)).toLocaleString()}</div>
              <div class="text-sm text-gray-500">
                Updated: {new Date((((items.get(selectedKey || '')?.draft?.payload ?? selectedPayload)?.updatedAt || 0) * 1000)).toLocaleString()}</div>
            {/if}
          </div>
        </div>
      {:else}
        <p class="text-gray-500">Select a snippet to view details</p>
      {/if}
    </section>
  </main>
</div>
