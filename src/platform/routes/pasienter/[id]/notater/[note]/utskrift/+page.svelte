<script lang="ts">
	// Mounts the notes app.
	import Page from '$apps/notes/routes/pasienter/[id]/notater/[note]/utskrift/+page.svelte';
	let props = $props();
</script>

<Page {...props} />
