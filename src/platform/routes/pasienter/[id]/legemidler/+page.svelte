<script lang="ts">
	// Mounts the medications app.
	import Page from '$apps/medications/routes/pasienter/[id]/legemidler/+page.svelte';
	let props = $props();
</script>

<Page {...props} />
