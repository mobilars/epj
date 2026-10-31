<script lang="ts">
	// Mounts the billing app.
	import Page from '$apps/billing/routes/pasienter/[id]/oppgjor/+page.svelte';
	let props = $props();
</script>

<Page {...props} />
