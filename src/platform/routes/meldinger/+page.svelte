<script lang="ts">
	// Mounts the messages app.
	import Page from '$apps/messages/routes/meldinger/+page.svelte';
	let props = $props();
</script>

<Page {...props} />
