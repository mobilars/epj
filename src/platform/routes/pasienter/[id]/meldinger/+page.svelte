<script lang="ts">
	// Mounts the messages app.
	import Page from '$apps/messages/routes/pasienter/[id]/meldinger/+page.svelte';
	let props = $props();
</script>

<Page {...props} />
