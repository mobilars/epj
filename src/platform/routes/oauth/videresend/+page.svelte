<script lang="ts">
	let { data } = $props();

	// Without JavaScript the meta refresh below carries the user across, and the
	// link is there if both are blocked. Nothing about the flow depends on this
	// page being seen.
	$effect(() => location.replace(data.target));
</script>

<svelte:head>
	<meta http-equiv="refresh" content="0;url={data.target}" />
</svelte:head>

<div class="smal">
	<div class="kort">
		<h1>Sender deg tilbake til appen …</h1>
		<p class="svak">Skjer det ingenting, følg lenken under.</p>
		<p><a class="knapp knapp-primar" href={data.target}>Fortsett</a></p>
	</div>
</div>
