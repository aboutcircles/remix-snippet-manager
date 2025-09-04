<script lang="ts">
  export let cid: string | null | undefined;
  export let label = 'CID';
  export let gateway = 'https://ipfs.io/ipfs';

  $: hasCid = !!cid;
  $: href = hasCid ? `${gateway}/${cid}` : null;

  let copied = false;

  async function copy() {
    if (!hasCid) return;
    try {
      await navigator.clipboard?.writeText(cid!);
      copied = true;
      setTimeout(() => (copied = false), 900);
    } catch { /* noop: clipboard may be blocked */ }
  }
</script>

<div
  class={`inline-flex items-center gap-2 text-xs rounded px-2 py-1
          ${hasCid ? 'bg-gray-50 border text-gray-700' : 'text-gray-400'}`}>
  <span class="font-medium">{label}:</span>

  {#if hasCid}
    <code class="font-mono truncate max-w-[18ch]" title={cid}>{cid}</code>
    <a
      class="underline text-blue-600 hover:text-blue-700"
      href={href}
      target="_blank"
      rel="noopener noreferrer">open</a>
    <button
      class="px-1 py-0.5 border rounded hover:bg-gray-100"
      on:click={copy}
      aria-live="polite"
      aria-label="Copy CID">
      {copied ? 'copied' : 'copy'}
    </button>
  {:else}
    <span>—</span>
  {/if}
</div>

<style>
  code { user-select: all; }
</style>
