<script lang="ts">
	// Mounts the fhir-browser app.
	import Page from '$apps/fhir-browser/routes/devtools/fhirbrowser/+page.svelte';
	let props = $props();
</script>

<Page {...props} />
