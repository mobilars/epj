<script lang="ts">
	let { data }: { data: { countKlare: number; sumReimbursementOre: number } } = $props();

	const kroner = (ore: number) => (ore / 100).toLocaleString('nb-NO', { style: 'currency', currency: 'NOK' });
</script>

<section class="kort">
	<h2>Oppgjør</h2>
	<p>
		<strong class="tall">{data.countKlare}</strong> regningskort er klare for innsending.<br />
		Samlet refusjon: <strong class="tall">{kroner(data.sumReimbursementOre)}</strong>
	</p>
	<a class="knapp liten" href="/oppgjor">Gå til oppgjør</a>
</section>
