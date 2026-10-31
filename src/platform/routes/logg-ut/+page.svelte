<script lang="ts">
	let { data } = $props();
</script>

<div class="smal">
	<h1>Du er logget ut</h1>

	<div class="kort">
		<p>Økten i journalen er avsluttet.</p>

		{#if data.healthIdLogoutUrl}
			<p class="svak">
				Du er fortsatt innlogget hos HelseID. På en delt maskin bør du logge ut der også –
				ellers slipper neste bruker rett inn med din identitet.
			</p>
			<p>
				<a class="knapp knapp-primar" href={data.healthIdLogoutUrl} rel="noopener">
					Logg ut av HelseID
				</a>
			</p>
		{/if}

		<p><a href="/logg-inn">Logg inn på nytt</a></p>
	</div>
</div>
