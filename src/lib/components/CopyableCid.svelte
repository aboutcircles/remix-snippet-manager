<script lang="ts">
  export let cid: string | null | undefined;
  export let label: string = 'CID';
  export let gateway = 'https://ipfs.io/ipfs';

  async function copy() {
    if (!cid) return;
    try {
      await navigator.clipboard.writeText(cid);
    } catch (_) {}
  }
</script>

{#if cid}
  <div class="inline-flex items-center gap-2 text-xs bg-gray-50 border rounded px-2 py-1">
    <span class="font-medium text-gray-700">{label}:</span>
    <code class="font-mono text-gray-700 truncate max-w-[18ch]" title={cid}>{cid}</code>
    <a class="underline text-blue-600 hover:text-blue-700" href={`${gateway}/${cid}`} target="_blank" rel="noopener noreferrer">open</a>
    <button class="px-1 py-0.5 border rounded hover:bg-gray-100" on:click={copy} aria-label="Copy CID">copy</button>
  </div>
{:else}
  <div class="inline-flex items-center gap-2 text-xs text-gray-400">
    <span class="font-medium">{label}:</span>
    <span>—</span>
  </div>
{/if}

<style>
  code { user-select: all; }
</style>
