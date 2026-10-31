<script lang="ts">
	// Mounts the overview app.
	import Page from '$apps/overview/routes/pasienter/[id]/+page.svelte';
	let props = $props();
</script>

<Page {...props} />
