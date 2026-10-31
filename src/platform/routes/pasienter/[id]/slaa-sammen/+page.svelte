<script lang="ts">
	let { data, form } = $props();

	const NAMES: Record<string, string> = {
		Encounter: 'kontakter',
		Composition: 'notater',
		Condition: 'diagnoser',
		Observation: 'målinger',
		MedicationRequest: 'resepter',
		AllergyIntolerance: 'allergier',
		Immunization: 'vaksiner',
		DocumentReference: 'dokumenter',
		Appointment: 'timer',
		ServiceRequest: 'henvisninger'
	};
	const countText = (counts: { type: string; count: number }[]) =>
		counts.length ? counts.map((c) => `${c.count} ${NAMES[c.type] ?? c.type}`).join(', ') : 'Ingen oppføringer';

	const others = $derived([...(data.sameNumber ?? []), ...(form?.found ?? [])]);
</script>

<h2>Slå sammen med en annen journal</h2>

<p class="svak">
	For en pasient som er registrert to ganger. Alt fra den andre journalen flyttes hit, også sperringer og
	behandlingsrelasjoner, og den andre journalen merkes som erstattet. Ingenting slettes, men en sammenslåing kan ikke
	angres her, så kontroller at det er samme person.
</p>

{#if form?.error}<div class="varsel varsel-feil" role="alert">{form.error}</div>{/if}

{#if data.self}
	<section class="kort">
		<h3>Denne journalen beholdes</h3>
		<p>
			<strong>{data.self.name}</strong>
			<span class="mono">{data.self.nationalIdMasked ?? ''}</span>
			{#if data.self.age !== null}· {data.self.age} år{/if}<br />
			<span class="svak">{countText(data.self.counts)}</span>
		</p>
	</section>

	{#each others as other (other.id)}
		<section class="kort">
			<h3>
				{other.name}
				{#if other.sameNumber}<span class="merke merke-advarsel">Samme fødselsnummer</span>
				{:else}<span class="merke merke-fare">Ulikt fødselsnummer</span>{/if}
			</h3>
			<p>
				<span class="mono">{other.nationalIdMasked ?? ''}</span>
				{#if other.age !== null}· {other.age} år{/if}<br />
				<span class="svak">{countText(other.counts)}</span>
			</p>
			<form method="POST" action="?/slaaSammen">
				<input type="hidden" name="annen" value={other.id} />
				<div class="felt">
					<label for="arsak-{other.id}">Hvorfor slås journalene sammen?</label>
					<input id="arsak-{other.id}" name="arsak" required minlength="10" autocomplete="off" />
				</div>
				<label class="avkryssing">
					<input type="checkbox" name="bekreftet" value="ja" required />
					Jeg har kontrollert at dette er samme person
				</label>
				{#if !other.sameNumber}
					<label class="avkryssing">
						<input type="checkbox" name="bekreftUlikt" value="ja" required />
						Jeg vet at journalene har ulikt fødselsnummer. Nummeret på denne journalen beholdes.
					</label>
				{/if}
				<button type="submit" class="fare">Flytt alt hit og slå sammen</button>
			</form>
		</section>
	{/each}

	<section class="kort">
		<h3>Finn en journal med et annet fødselsnummer</h3>
		{#if form?.searched}
			<p class="svak">
				{form.found?.length ? 'Fant' : 'Fant ingen'} med {form.searched}.
				{#if form.invalidNumber}Nummeret er ikke gyldig, men kan være lagret slik.{/if}
			</p>
		{:else if !data.sameNumber?.length}
			<p class="svak">Ingen andre journaler har samme fødselsnummer som denne.</p>
		{/if}
		<form method="POST" action="?/finn" class="rad">
			<div class="felt" style="flex: 0 1 220px">
				<label for="fodselsnummer">Fødselsnummer</label>
				<input id="fodselsnummer" name="fodselsnummer" inputmode="numeric" autocomplete="off" required />
			</div>
			<button type="submit" style="align-self: flex-end">Finn</button>
		</form>
	</section>
{/if}
